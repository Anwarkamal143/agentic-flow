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
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  EffectiveConfigSchema,
  initialTaskState,
  PlanProposalSchema,
  schemaIssues,
  SpecificationProposalSchema,
  TaskDefinitionSchema,
  type ArtifactKind,
  type PlanContext,
  type RuleIssue,
  type StageFailure,
  type StageRunState,
  type TaskDefinition,
} from '@factory/domain';
import type { AgentHarness, HarnessRawResult, HarnessRun } from '@factory/harness';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { changeJob, readJobState, type JobState } from './engine.js';
import { newId } from './ids.js';
import {
  PROMPT_TEMPLATE_HASH,
  PROMPT_TEMPLATE_ID,
  PROPOSAL_STAGE_IDS,
  proposalStage,
  renderPrompt,
  type ProposalStage,
} from './proposals.js';

const ACTOR = 'system:scheduler';
const POLL_MS = 1_000;
/** Harness Runs per proposal: the first, plus one re-prompt. */
const MAX_RUNS = 2;

export interface SchedulerOptions {
  db: FactoryDb;
  /** `undefined`: no Harness is configured, so queued Stages wait. */
  harness: AgentHarness | undefined;
  artifacts: ArtifactStore;
  onCommit: () => void;
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

export class StageScheduler {
  private timer: NodeJS.Timeout | undefined;
  private wakeScheduled = false;
  private busy: Promise<void> | undefined;
  private current: HarnessRun | undefined;
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
    this.timer = setInterval(() => {
      this.wake();
    }, POLL_MS);
    this.wake();
  }

  /** Asks for a scheduling pass soon. Call after committing a state change. */
  wake(): void {
    if (this.wakeScheduled || this.closed || this.opts.harness === undefined) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      if (this.busy === undefined && !this.closed) {
        this.busy = this.pass().finally(() => {
          this.busy = undefined;
          if (!this.closed) this.wake();
        });
      }
    });
  }

  /**
   * Stops scheduling and cancels a Harness Run in flight. Its Stage Run stays
   * `running` and is resumed at the next start.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.current?.cancel();
    await this.busy;
  }

  /** Runs at most one Stage. */
  private async pass(): Promise<void> {
    const harness = this.opts.harness;
    if (harness === undefined) return;
    let stageRunId: string | undefined;
    try {
      stageRunId = this.orphans.shift() ?? this.claimNext();
      if (stageRunId === undefined) return;
      await this.runStage(harness, stageRunId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`stage scheduler: ${err instanceof Error ? (err.stack ?? message) : message}`);
      // Never leave a claimed Stage Run silently `running`: fail it where it can be seen.
      if (stageRunId !== undefined && !this.closed) {
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
    const inputs = this.opts.artifacts
      .listForJob(job.id)
      .map((a) => ({ kind: a.kind, content: this.opts.artifacts.readJson(a.id) }));

    let rejected: RuleIssue[] | undefined;
    for (let n = 1; n <= MAX_RUNS; n++) {
      const prompt = renderPrompt(stage, {
        job,
        repositories,
        inputs,
        ...(rejected === undefined ? {} : { rejected }),
      });
      const outcome = await this.harnessRun(harness, stage, run, {
        n,
        prompt,
        cwd,
        repositories,
        rejected,
      });
      if (this.closed) return; // shutdown: left running, resumed at the next start
      if (outcome.kind === 'valid') {
        this.succeed(run, stage, outcome.value);
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
      repositories: PlanContext['repositories'];
      rejected: RuleIssue[] | undefined;
    },
  ): Promise<Outcome> {
    let started: HarnessRun;
    try {
      started = await harness.start({
        role: stage.role,
        prompt: input.prompt,
        cwd: input.cwd,
        subject: { jobId: run.jobId, stageId: run.stageId },
        limits: { wallClockMs: this.opts.wallClockMs ?? 600_000 },
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
      ...(input.rejected === undefined ? {} : { reprompt: { issues: input.rejected } }),
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
    const outcome = this.evaluate(stage, result, {
      repositories: input.repositories,
      // Read after the Run: the Specification's criteria, for planning.
      criteria: this.opts.db
        .select()
        .from(schema.acceptanceCriteria)
        .where(eq(schema.acceptanceCriteria.jobId, run.jobId))
        .all(),
    });
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

  /** Decides what a Harness Run's output is worth. The exit code alone proves nothing. */
  private evaluate(
    stage: ProposalStage,
    result: HarnessRawResult,
    ctx: Parameters<ProposalStage['validate']>[1],
  ): Outcome {
    if (result.exit.kind !== 'exited' || result.exit.code !== 0) {
      const how =
        result.exit.kind === 'exited'
          ? `exited with code ${String(result.exit.code)}`
          : result.exit.kind === 'timed_out'
            ? `timed out after ${String(result.exit.afterMs)} ms`
            : 'was cancelled';
      return { kind: 'harness_failed', message: `the ${stage.stageId} Harness Run ${how}` };
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
   * and queues the next Stage. One transaction.
   */
  private succeed(run: StageRunRow, stage: ProposalStage, value: unknown): void {
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
        this.persist(tx, stage.kind, value, {
          jobId: run.jobId,
          artifactId: artifact.id,
          config: state.job.configSnapshotJson,
        });
        step(current, 'succeeded');
        const next = state.stageRuns.find(
          (r) => r.position > current.position && r.state === 'pending',
        );
        if (next !== undefined) step(next, 'queued');
      },
    );
    this.opts.onCommit();
  }

  /** Writes the rows a proposal defines: Acceptance Criteria for a spec, Tasks for a plan. */
  private persist(
    tx: Tx,
    kind: ArtifactKind,
    value: unknown,
    ctx: { jobId: string; artifactId: string; config: string },
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
      const plan = PlanProposalSchema.parse(value);
      const config = EffectiveConfigSchema.parse(JSON.parse(ctx.config));
      const repositories = this.repositoriesOf(ctx.jobId, tx);
      const ids = new Map(plan.tasks.map((t) => [t.key, newId('tsk')]));
      for (const task of plan.tasks) {
        const repo = repositories.find(
          (r) => r.id === task.repository || r.name === task.repository,
        );
        if (repo === undefined) throw new Error(`validated Task ${task.key} has no Repository`);
        const id = taskId(ids, task.key);
        const state = initialTaskState(task.dependsOn);
        tx.insert(schema.tasks)
          .values({
            id,
            jobId: ctx.jobId,
            repositoryId: repo.id,
            planArtifactId: ctx.artifactId,
            key: task.key,
            title: task.title,
            definitionJson: JSON.stringify(
              TaskDefinitionSchema.parse({
                objective: task.objective,
                role: task.role,
                risk: task.risk,
                scope: task.scope,
                dependsOn: task.dependsOn,
                acceptance: task.acceptance,
                verification: task.verification,
              } satisfies TaskDefinition),
            ),
            state,
            priority: 0,
            maxAttempts: config.maxAttempts.value,
            version: 0,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'task',
          entityId: id,
          jobId: ctx.jobId,
          type: 'task.created',
          actor: ACTOR,
          payload: { key: task.key, state, repositoryId: repo.id, planArtifactId: ctx.artifactId },
        });
      }
      for (const task of plan.tasks) {
        for (const dep of task.dependsOn) {
          tx.insert(schema.taskDependencies)
            .values({ taskId: taskId(ids, task.key), dependsOnTaskId: taskId(ids, dep) })
            .run();
        }
      }
    }
  }

  private fail(run: StageRunRow, failure: StageFailure): void {
    changeJob(
      this.opts.db,
      { jobId: run.jobId, expectedVersion: 'current', actor: ACTOR },
      (_, state, step) => {
        step(requireStageRun(state, run.id, 'running'), 'failed', { failure });
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

  private repositoriesOf(jobId: string, db: FactoryDb | Tx = this.opts.db) {
    return db
      .select({
        id: schema.repositories.id,
        name: schema.repositories.name,
        clonePath: schema.repositories.clonePath,
      })
      .from(schema.jobRepositories)
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.jobRepositories.repositoryId),
      )
      .where(eq(schema.jobRepositories.jobId, jobId))
      .all();
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

/** The id given to a validated Plan's Task key (the validator guarantees it exists). */
function taskId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`the validated Plan has no Task ${key}`);
  return id;
}
