/**
 * The Stage scheduler, Phase A: one concurrency slot, proposal Stages only
 * (triage, discovery, specification, planning). The Task scheduler that runs
 * `execution` is a separate concern (#7).
 *
 * Each proposal is a Harness Run whose output is untrusted: it is parsed,
 * schema-checked and validated in code. One re-prompt, carrying the problems,
 * is allowed; a second invalid output fails the Stage Run with
 * `invalid_output`. A valid proposal is stored as an immutable Artifact in
 * the same transaction that completes the Stage Run, so a finished Stage is
 * never run (or generated) again.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  PlanProposalSchema,
  schemaIssues,
  SpecificationProposalSchema,
  type ArtifactKind,
  type PlanContext,
  type RuleIssue,
  type StageFailure,
  type StageRunState,
  toolPolicyOf,
  type ToolPolicy,
} from '@factory/domain';
import {
  describeHarnessExit,
  guardrailEnv,
  type AgentHarness,
  type HarnessRawResult,
  type HarnessRun,
} from '@factory/harness';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { changeJob, readJobState, stepTask, type JobState } from './engine.js';
import { newId } from './ids.js';
import { PassLoop } from './pass-loop.js';
import { currentSpec } from './criteria.js';
import { queueNextStage } from './plan-approval.js';
import {
  persistPlanTasks,
  planContextOf,
  replanRequestOf,
  repositoriesOf,
  type JobRepository,
  type ReplanRequest,
  cancelTaskItems,
} from './plans.js';
import {
  PROMPT_TEMPLATE_HASH,
  PROMPT_TEMPLATE_ID,
  PROPOSAL_STAGE_IDS,
  proposalStage,
  renderPrompt,
  type ProposalStage,
} from './proposals.js';
import {
  awaitSpecChange,
  respecificationFailed,
  respecRequestOf,
  type RespecRequest,
} from './spec-route.js';

const ACTOR = 'system:scheduler';
const POLL_MS = 1_000;
/** Harness Runs per proposal: the first, plus one re-prompt. */
const MAX_RUNS = 2;
/** Turns a proposal Harness Run may take (reading the Repository, then answering). */
const PROPOSAL_MAX_TURNS = 30;

export interface SchedulerOptions {
  db: FactoryDb;
  /** `undefined`: no Harness is configured, so queued Stages wait. */
  harness: AgentHarness | undefined;
  artifacts: ArtifactStore;
  onCommit: () => void;
  /** Where each Harness Run's spool directory goes (ADR-0012). */
  spoolRoot: string;
  /** Wall-clock limit of one proposal Harness Run. */
  wallClockMs?: number;
  /** Reports an unexpected error (the scheduler keeps going). */
  log: (message: string) => void;
}

type StageRunRow = typeof schema.stageRuns.$inferSelect;

/** What one Harness Run's output is worth. */
type Outcome =
  | { kind: 'valid'; value: unknown }
  | { kind: 'invalid'; issues: RuleIssue[] }
  | { kind: 'harness_failed'; message: string };

/**
 * What a proposal Harness Run is asked besides its Stage: why the previous
 * output was rejected (a re-prompt), and the Replan or re-specification
 * request it answers. Each is recorded on `harness_run.started`.
 */
interface StageRunContext {
  rejected: RuleIssue[] | undefined;
  replan: ReplanRequest | undefined;
  respec: RespecRequest | undefined;
}

export class StageScheduler {
  private readonly loop = new PassLoop(() => this.pass(), POLL_MS);
  private current: HarnessRun | undefined;
  /** The Job whose Stage the slot runs, and when that work ends. */
  private inflight: { jobId: string; done: Promise<unknown> } | undefined;
  private closed = false;
  /** Stage Runs left `running` by a previous runtime; resumed first. */
  private orphans: string[] = [];

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (this.opts.harness === undefined) return;
    // A previous runtime died during a Harness Run. That Harness Run lived in its
    // process, so it is gone, and nothing was stored for it: the Stage starts again.
    this.orphans = this.opts.db
      .select({ id: schema.stageRuns.id })
      .from(schema.stageRuns)
      .where(
        and(
          eq(schema.stageRuns.state, 'running'),
          inArray(schema.stageRuns.stageId, [...PROPOSAL_STAGE_IDS]),
        ),
      )
      .all()
      .map((r) => r.id);
    this.loop.start();
  }

  /** Asks for a scheduling pass soon. Call after committing a state change. */
  wake(): void {
    if (this.closed || this.opts.harness === undefined) return;
    this.loop.wake();
  }

  /**
   * Stops scheduling and cancels a Harness Run in flight. Its Stage Run stays
   * `running` and is resumed at the next start.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.loop.halt();
    await this.current?.cancel();
    await this.loop.idle();
  }

  /**
   * Stops a cancelled Job's running Stage (#12): its Harness Run is cancelled
   * (a process group gets SIGTERM, then SIGKILL), and nothing is recorded for
   * the Stage Run beyond the Run's end: the cancellation already ended it.
   * Settles when the slot is free of the Job.
   */
  async cancelJob(jobId: string): Promise<void> {
    const inflight = this.inflight;
    if (inflight?.jobId !== jobId) return;
    await this.current?.cancel();
    await inflight.done;
  }

  /** Runs at most one Stage. `true` when it did some work. */
  private async pass(): Promise<boolean> {
    const harness = this.opts.harness;
    if (harness === undefined) return false;
    let stageRunId: string | undefined;
    try {
      stageRunId = this.orphans.shift() ?? this.claimNext();
      if (stageRunId === undefined) return false;
      const done = this.runStage(harness, stageRunId);
      this.inflight = { jobId: this.stageRun(stageRunId).jobId, done: done.catch(() => undefined) };
      try {
        await done;
      } finally {
        this.inflight = undefined;
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`stage scheduler: ${err instanceof Error ? (err.stack ?? message) : message}`);
      // Never leave a claimed Stage Run silently `running`: fail it where it can be seen.
      if (
        stageRunId !== undefined &&
        !this.closed &&
        this.stageRun(stageRunId).state === 'running'
      ) {
        try {
          this.fail(this.stageRun(stageRunId), {
            reason: 'factory_error',
            message: `the factory could not run this Stage: ${message}`,
            issues: [],
          });
        } catch (failErr) {
          this.opts.log(`stage scheduler: could not record the failure: ${String(failErr)}`);
        }
      }
      return stageRunId !== undefined;
    }
  }

  /** Moves the oldest Job's queued proposal Stage Run to `running`, and returns its id. */
  private claimNext(): string | undefined {
    const next = this.opts.db
      .select({ run: schema.stageRuns })
      .from(schema.stageRuns)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
      .where(
        and(
          eq(schema.stageRuns.state, 'queued'),
          inArray(schema.stageRuns.stageId, [...PROPOSAL_STAGE_IDS]),
        ),
      )
      .orderBy(asc(schema.jobs.createdAt), asc(schema.stageRuns.position))
      .limit(1)
      .get();
    if (next === undefined) return undefined;
    changeJob(
      this.opts.db,
      { jobId: next.run.jobId, expectedVersion: 'current', actor: ACTOR },
      (_, state, step) => {
        step(requireStageRun(state, next.run.id, 'queued'), 'running');
      },
    );
    this.opts.onCommit();
    return next.run.id;
  }

  private async runStage(harness: AgentHarness, stageRunId: string): Promise<void> {
    const run = this.stageRun(stageRunId);
    const stage = proposalStage(run.stageId);
    if (stage === undefined) throw new Error(`Stage ${run.stageId} is not a proposal Stage`);
    const { job } = readJobState(this.opts.db, run.jobId);
    const repositories = this.repositoriesOf(job.id);
    const [cwd] = repositories.map((r) => r.clonePath);
    if (cwd === undefined) throw new Error(`Job ${job.id} has no Repository`);
    // A replan or re-specification request reaches its Stage as a section below, not as an
    // input; of the spec Artifacts only the current Specification is one (ADR-0031).
    const spec = currentSpec(this.opts.db, job.id)?.id;
    const inputs = this.opts.artifacts
      .listForJob(job.id)
      .filter((a) => a.kind !== 'replan_request' && a.kind !== 'respec_request')
      .filter((a) => a.kind !== 'spec' || a.id === spec)
      .map((a) => ({ kind: a.kind, content: this.opts.artifacts.readJson(a.id) }));

    // A Replan (ADR-0019): the planner re-plans from the current Plan and the human's feedback.
    const replan =
      stage.stageId === 'planning'
        ? replanRequestOf(this.opts.db, job.id, (id) => this.opts.artifacts.readJson(id))
        : undefined;
    const replanInput =
      replan === undefined
        ? undefined
        : { ...replan, plan: this.opts.artifacts.readJson(replan.planArtifactId) };
    // A re-specification (ADR-0031): the specifier revises a Specification from the feedback.
    const respec = respecRequestOf(this.opts.db, run, (id) => this.opts.artifacts.readJson(id));
    const respecInput =
      respec === undefined
        ? undefined
        : {
            specArtifactId: respec.specArtifactId,
            feedback: respec.feedback,
            spec: this.opts.artifacts.readJson(respec.specArtifactId),
          };

    let rejected: RuleIssue[] | undefined;
    for (let n = 1; n <= MAX_RUNS; n++) {
      const prompt = renderPrompt(stage, {
        job,
        repositories,
        inputs,
        ...(rejected === undefined ? {} : { rejected }),
        ...(replanInput === undefined ? {} : { replan: replanInput }),
        ...(respecInput === undefined ? {} : { respec: respecInput }),
      });
      const outcome = await this.harnessRun(harness, stage, run, {
        n,
        prompt,
        cwd,
        policy: toolPolicyOf(job.configSnapshotJson, stage.role),
        repositories,
        context: { rejected, replan, respec },
      });
      if (this.closed) return; // shutdown: left running, resumed at the next start
      if (this.stageRun(stageRunId).state !== 'running') return; // the Job was cancelled
      if (outcome.kind === 'valid') {
        this.succeed(run, stage, outcome.value, respec);
        return;
      }
      if (outcome.kind === 'harness_failed') {
        this.fail(run, { reason: 'harness_failed', message: outcome.message, issues: [] });
        return;
      }
      rejected = outcome.issues;
    }
    this.fail(run, {
      reason: 'invalid_output',
      message: `the ${stage.stageId} proposal was invalid after ${String(MAX_RUNS - 1)} re-prompt: ${(rejected ?? []).map((i) => `[${i.rule}] ${i.message}`).join('; ')}`,
      issues: rejected ?? [],
    });
  }

  /** One Harness Run, recorded as `harness_run.started` / `harness_run.finished` events. */
  private async harnessRun(
    harness: AgentHarness,
    stage: ProposalStage,
    run: StageRunRow,
    input: {
      n: number;
      prompt: string;
      cwd: string;
      policy: ToolPolicy;
      repositories: readonly JobRepository[];
      context: StageRunContext;
    },
  ): Promise<Outcome> {
    const { rejected, replan, respec } = input.context;
    // A proposal Run is never re-attached: a Stage Run left running starts again.
    const spool = join(this.opts.spoolRoot, `${run.id}-${String(input.n)}`);
    rmSync(spool, { recursive: true, force: true });
    let started: HarnessRun;
    try {
      started = await harness.start({
        role: stage.role,
        prompt: input.prompt,
        cwd: input.cwd,
        env: guardrailEnv(process.env, { FACTORY_JOB_ID: run.jobId }),
        subject: { jobId: run.jobId, stageId: run.stageId },
        limits: { wallClockMs: this.opts.wallClockMs ?? 600_000, maxTurns: PROPOSAL_MAX_TURNS },
        policy: input.policy,
        spool,
      });
    } catch (err) {
      return {
        kind: 'harness_failed',
        message: `the ${harness.id} Harness did not start: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.current = started;
    this.event(run, started.executionId, 'harness_run.started', {
      stageRunId: run.id,
      stageId: run.stageId,
      role: stage.role,
      harnessId: harness.id,
      n: input.n,
      template: { id: PROMPT_TEMPLATE_ID, hash: PROMPT_TEMPLATE_HASH },
      ...(started.sessionRef === undefined ? {} : { sessionRef: started.sessionRef }),
      ...(rejected === undefined ? {} : { reprompt: { issues: rejected } }),
      ...(replan === undefined ? {} : { replan }),
      ...(respec === undefined
        ? {}
        : {
            respec: {
              specArtifactId: respec.specArtifactId,
              feedback: respec.feedback,
              requestArtifactId: respec.requestArtifactId,
            },
          }),
    });
    // Progress isn't stored yet, only counted; draining keeps the stream from backing up.
    const drained = (async () => {
      let count = 0;
      for await (const event of started.events) if (event.kind !== 'usage') count++;
      return count;
    })();
    const result = await started.result;
    const eventCount = await drained;
    this.current = undefined;
    rmSync(spool, { recursive: true, force: true });
    const outcome = this.evaluate(
      stage,
      result,
      await this.planContext(stage, run, input.repositories),
    );
    this.event(run, started.executionId, 'harness_run.finished', {
      stageRunId: run.id,
      stageId: run.stageId,
      harnessId: harness.id,
      n: input.n,
      exit: result.exit,
      durationMs: result.durationMs,
      events: eventCount,
      usage: result.usage,
      outcome: outcome.kind,
      ...(outcome.kind === 'invalid' ? { issues: outcome.issues } : {}),
    });
    return outcome;
  }

  /**
   * What the validators check a proposal against, read after the Run: the
   * Specification's criteria, the Effective Configuration's `maxAttempts`,
   * and, for planning only, the tracked files at the planning base.
   */
  private planContext(
    stage: ProposalStage,
    run: StageRunRow,
    repositories: readonly JobRepository[],
  ): Promise<PlanContext> {
    return planContextOf(this.opts.db, run.jobId, repositories, {
      trackedFiles: stage.stageId === 'planning',
    });
  }

  /** Decides what a Harness Run's output is worth. The exit code alone proves nothing. */
  private evaluate(
    stage: ProposalStage,
    result: HarnessRawResult,
    ctx: Parameters<ProposalStage['validate']>[1],
  ): Outcome {
    if (result.exit.kind !== 'exited' || result.exit.code !== 0) {
      return {
        kind: 'harness_failed',
        message: `the ${stage.stageId} Harness Run ${describeHarnessExit(result.exit)}`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(result.output);
    } catch (err) {
      return {
        kind: 'invalid',
        issues: [
          {
            rule: 'json',
            message: `the output is not a JSON object (${err instanceof Error ? err.message : String(err)})`,
          },
        ],
      };
    }
    const parsed = stage.schema.safeParse(json);
    if (!parsed.success) return { kind: 'invalid', issues: schemaIssues(parsed.error) };
    const issues = stage.validate(parsed.data, ctx);
    return issues.length === 0
      ? { kind: 'valid', value: parsed.data }
      : { kind: 'invalid', issues };
  }

  /**
   * Stores the proposal and everything taken from it, completes the Stage Run
   * and queues the next Stage. One transaction. A re-specification's spec
   * instead waits on its `spec_change` Approval (ADR-0031).
   */
  private succeed(
    run: StageRunRow,
    stage: ProposalStage,
    value: unknown,
    respec: RespecRequest | undefined,
  ): void {
    const content = this.opts.artifacts.writeContent(value);
    changeJob(
      this.opts.db,
      { jobId: run.jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const current = requireStageRun(state, run.id, 'running');
        const artifact = this.opts.artifacts.record(
          tx,
          { jobId: run.jobId, stageRunId: run.id, kind: stage.kind, content },
          ACTOR,
        );
        this.persist(tx, stage.kind, value, { jobId: run.jobId, artifactId: artifact.id });
        if (respec !== undefined) {
          awaitSpecChange(
            tx,
            { run: current, specArtifactId: artifact.id, request: respec, actor: ACTOR },
            step,
          );
          return;
        }
        step(current, 'succeeded');
        queueNextStage(tx, run.jobId, step, current.position, ACTOR);
      },
    );
    this.opts.onCommit();
  }

  /** Writes the rows a proposal defines: Acceptance Criteria for a spec, Tasks for a plan. */
  private persist(
    tx: Tx,
    kind: ArtifactKind,
    value: unknown,
    ctx: { jobId: string; artifactId: string },
  ): void {
    if (kind === 'spec') {
      const spec = SpecificationProposalSchema.parse(value);
      tx.insert(schema.acceptanceCriteria)
        .values(
          spec.acceptanceCriteria.map((c) => ({
            id: newId('ac'),
            jobId: ctx.jobId,
            artifactId: ctx.artifactId,
            code: c.code,
            text: c.text,
            mandatory: c.mandatory,
            verification: c.verification,
          })),
        )
        .run();
    }
    if (kind === 'plan') {
      persistPlanTasks(tx, PlanProposalSchema.parse(value), {
        ...ctx,
        actor: ACTOR,
        readPlan: (id) => PlanProposalSchema.parse(this.opts.artifacts.readJson(id)),
      });
    }
  }

  private fail(run: StageRunRow, failure: StageFailure): void {
    changeJob(
      this.opts.db,
      { jobId: run.jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        // A failed re-specification leaves the Finding to the operator, and the Job goes on
        // under its current Specification: the Stage Run no longer counts (ADR-0031).
        const respec = respecRequestOf(tx, run, (id) => this.opts.artifacts.readJson(id));
        if (respec !== undefined) {
          step(requireStageRun(state, run.id, 'running'), 'superseded', {
            reason: `the re-specification failed (${failure.reason}: ${failure.message}); the current Specification stays`,
          });
          respecificationFailed(tx, { jobId: run.jobId, actor: ACTOR }, respec, failure);
          return;
        }
        step(requireStageRun(state, run.id, 'running'), 'failed', { failure });
        // A failed Replan ends the Job: the Tasks it would have carried over or cancelled
        // are cancelled now, with their open Inbox Items (ADR-0029).
        if (run.stageId === 'planning') cancelUnfinishedTasks(tx, run.jobId, ACTOR);
      },
    );
    this.opts.onCommit();
  }

  private event(
    run: StageRunRow,
    executionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.opts.db.transaction((tx) => {
      appendEvent(tx, {
        entityKind: 'harness_run',
        entityId: executionId,
        jobId: run.jobId,
        type,
        actor: ACTOR,
        payload,
      });
    });
    this.opts.onCommit();
  }

  private stageRun(id: string): StageRunRow {
    const run = this.opts.db
      .select()
      .from(schema.stageRuns)
      .where(eq(schema.stageRuns.id, id))
      .get();
    if (run === undefined) throw new Error(`no Stage Run ${id}`);
    return run;
  }

  private repositoriesOf(jobId: string): JobRepository[] {
    return repositoriesOf(this.opts.db, jobId);
  }
}

/** The Stage Run `id` of the Job being changed, which must be in state `expected`. */
function requireStageRun(state: JobState, id: string, expected: StageRunState): StageRunRow {
  const run = state.stageRuns.find((r) => r.id === id);
  if (run?.state !== expected) {
    throw new Error(`Stage Run ${id} is ${String(run?.state)}, not ${expected}`);
  }
  return run;
}

/** Cancels the Job's Tasks that are not finished (none is in flight while planning runs). */
function cancelUnfinishedTasks(tx: Tx, jobId: string, actor: string): void {
  const open = tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        inArray(schema.tasks.state, ['pending', 'ready', 'blocked', 'changes_requested']),
      ),
    )
    .all();
  for (const task of open) {
    stepTask(tx, { jobId, actor }, task, 'cancelled', {
      reason: 'planning_failed',
      cancelReason: 'replan',
    });
    cancelTaskItems(tx, { jobId, actor }, task.id);
  }
}
