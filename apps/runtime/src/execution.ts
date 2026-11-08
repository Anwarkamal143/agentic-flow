/**
 * The Task scheduler, Phase A: one concurrency slot. It runs the `execution`
 * Stage (claim a ready Task, give it a Worktree, run the developer Harness,
 * verify the result itself) and the `closure` Stage (the Delivery Report, then
 * Worktree removal). ARCHITECTURE §7, §10, §12.
 *
 * After a Harness Run the factory trusts nothing it said: the head commit and
 * the commits come from git, leftovers become a flagged WIP commit, and every
 * verification command is run again by the factory, its exit code recorded as
 * Evidence tied to `(head_sha, base_sha)`.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AttemptStateSchema,
  criterionVerdict,
  decideApproval,
  evidenceSource,
  type GateRef,
  EvidenceVerdictSchema,
  isBlocking,
  isCurrent,
  verificationProblems,
  type ApprovalInput,
  type ReviewPacket,
  type ReviewProposal,
  RESULT_FILE,
  schemaIssues,
  SpecificationProposalSchema,
  DiscoveryProposalSchema,
  TaskDefinitionSchema,
  TaskPacketSchema,
  TaskResultSchema,
  type AttemptExitReason,
  type AttemptState,
  type RuleIssue,
  type TaskDefinition,
  type TaskPacket,
  type TaskResult,
  type Usage,
} from '@factory/domain';
import {
  addWorktree,
  changedPaths,
  commitAll,
  commitsBetween,
  fetchRemote,
  removeWorktree,
  resolveCommit,
  uncommittedPaths,
} from '@factory/git';
import {
  describeHarnessExit,
  guardrailEnv,
  spawnGuarded,
  type AgentHarness,
  type GuardedProcess,
  type HarnessRawResult,
  type HarnessRun,
} from '@factory/harness';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ArtifactStore, StoredContent } from './artifacts.js';
import { criteriaCoveredBy } from './criteria.js';
import { buildDeliveryReport } from './delivery.js';
import {
  changeJob,
  stepAttempt,
  stepTask,
  stepWorktree,
  type JobState,
  type StageRunStepper,
} from './engine.js';
import { newId } from './ids.js';
import { PassLoop } from './pass-loop.js';
import {
  buildReviewPacket,
  evaluateReview,
  renderReviewPrompt,
  REVIEW_TEMPLATE_HASH,
  REVIEW_TEMPLATE_ID,
  type ReviewEvaluation,
} from './review.js';
import { renderTaskPrompt, TASK_TEMPLATE_HASH, TASK_TEMPLATE_ID } from './task-packet.js';
import {
  allocatePortBlock,
  excludeResultFile,
  releaseAttemptTokens,
  requireWorktree,
  taskWorktree,
} from './worktree.js';

const ACTOR = 'system:scheduler';
const POLL_MS = 1_000;
const MAX_TURNS = 50;
/** Default wall-clock limit of one developer Harness Run. */
const DEFAULT_HARNESS_WALL_CLOCK_MS = 30 * 60_000;
/** Default wall-clock limit of one verification command. */
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
/** Default wall-clock limit of one reviewer Harness Run. */
const DEFAULT_REVIEW_WALL_CLOCK_MS = 10 * 60_000;
/** Reviewer Harness Runs per review: the first, plus one re-prompt. */
const REVIEW_RUNS = 2;
/** Verification commands budgeted for in an Attempt's lease. */
const LEASE_VERIFICATION_BUDGET = 4;
/** Slack on top of the budget, for the factory's own git work. */
const LEASE_SLACK_MS = 60_000;

/**
 * How long an Attempt's leases (its Task, its port block) run before they
 * expire: one developer Harness Run, a budget of verification commands, the
 * reviewer Runs (with the re-prompt), and slack. There is no heartbeat yet
 * (#13), so this bounds a whole Attempt.
 */
export function attemptLeaseMs(limits: {
  wallClockMs: number;
  verifyTimeoutMs: number;
  reviewWallClockMs: number;
}): number {
  return (
    limits.wallClockMs +
    limits.verifyTimeoutMs * LEASE_VERIFICATION_BUDGET +
    limits.reviewWallClockMs * REVIEW_RUNS +
    LEASE_SLACK_MS
  );
}

export interface TaskSchedulerOptions {
  db: FactoryDb;
  /** `undefined`: no Harness is configured, so ready Tasks wait. */
  harness: AgentHarness | undefined;
  harnessVersion: string | null;
  artifacts: ArtifactStore;
  workspaceRoot: string;
  /** The runtime's environment; only allowlisted variables reach a guarded process. */
  runtimeEnv: NodeJS.ProcessEnv;
  onCommit: () => void;
  log: (message: string) => void;
  /** Wall-clock limit of one developer Harness Run. */
  wallClockMs?: number;
  /** Wall-clock limit of one verification command. */
  verifyTimeoutMs?: number;
  /** Wall-clock limit of one reviewer Harness Run. */
  reviewWallClockMs?: number;
}

type TaskRow = typeof schema.tasks.$inferSelect;

/** What the factory found in the Worktree after the Harness Run. */
interface Inspection {
  headSha: string;
  commits: string[];
  wipCommit: string | null;
  result:
    | { kind: 'missing' }
    | { kind: 'invalid'; issues: RuleIssue[]; content: unknown }
    | { kind: 'valid'; value: TaskResult };
  violations: RuleIssue[];
}

interface VerificationRunRecord {
  key: string;
  command: string;
  required: boolean;
  criteria: string[];
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  durationMs: number;
  /** The command's output, as stored in `content`. */
  output: string;
  content: StoredContent;
}

interface Outcome {
  state: Extract<AttemptState, 'passed' | 'failed'>;
  exitReason: AttemptExitReason;
  detail: string;
}

export class TaskScheduler {
  private readonly loop = new PassLoop(() => this.pass(), POLL_MS);
  private currentRun: HarnessRun | undefined;
  private currentProc: GuardedProcess | undefined;
  private closed = false;
  private readonly holder = `runtime:${String(process.pid)}`;
  private readonly wallClockMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly reviewWallClockMs: number;

  constructor(private readonly opts: TaskSchedulerOptions) {
    this.wallClockMs = opts.wallClockMs ?? DEFAULT_HARNESS_WALL_CLOCK_MS;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.reviewWallClockMs = opts.reviewWallClockMs ?? DEFAULT_REVIEW_WALL_CLOCK_MS;
  }

  /** When an Attempt's leases taken now expire. */
  private leaseExpiry(): string {
    return new Date(
      Date.now() +
        attemptLeaseMs({
          wallClockMs: this.wallClockMs,
          verifyTimeoutMs: this.verifyTimeoutMs,
          reviewWallClockMs: this.reviewWallClockMs,
        }),
    ).toISOString();
  }

  start(): void {
    if (this.opts.harness === undefined) return;
    this.loop.start();
  }

  wake(): void {
    if (this.closed || this.opts.harness === undefined) return;
    this.loop.wake();
  }

  /**
   * Stops scheduling and stops the process in flight (Harness Run or
   * verification command). Its Attempt is left as it is; recovery is #13.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.loop.halt();
    await Promise.all([this.currentRun?.cancel(), this.currentProc?.cancel()]);
    await this.loop.idle();
  }

  /** Runs at most one closure or one Attempt. `true` when it did some work. */
  private async pass(): Promise<boolean> {
    const harness = this.opts.harness;
    if (harness === undefined) return false;
    const closure = this.nextClosure();
    if (closure !== undefined) {
      await this.guard(closure.jobId, () => this.runClosure(closure.id, closure.jobId), {
        closureId: closure.id,
      });
      return true;
    }
    const claimed = this.claimNext();
    if (claimed === undefined) return false;
    await this.guard(claimed.jobId, () => this.runAttempt(harness, claimed.taskId), {
      taskId: claimed.taskId,
    });
    return true;
  }

  /** Runs `body`; an unexpected error fails the work where it can be seen, never silently. */
  private async guard(
    jobId: string,
    body: () => Promise<void>,
    subject: { taskId?: string; closureId?: string },
  ): Promise<void> {
    try {
      await body();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log(`task scheduler: ${err instanceof Error ? (err.stack ?? message) : message}`);
      if (this.closed) return;
      try {
        if (subject.taskId !== undefined) this.failTask(jobId, subject.taskId, message);
        if (subject.closureId !== undefined) this.failClosure(jobId, subject.closureId, message);
      } catch (failErr) {
        this.opts.log(`task scheduler: could not record the failure: ${String(failErr)}`);
      }
    }
  }

  // ---- claim ------------------------------------------------------------------

  /**
   * Claims the oldest Job's next ready Task: inserts its lease and moves it
   * `ready → claimed` in one versioned transaction (and starts `execution`).
   */
  private claimNext(): { jobId: string; taskId: string } | undefined {
    const next = this.opts.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.tasks.jobId))
      .innerJoin(
        schema.stageRuns,
        and(
          eq(schema.stageRuns.jobId, schema.tasks.jobId),
          eq(schema.stageRuns.stageId, 'execution'),
        ),
      )
      .where(
        and(
          eq(schema.tasks.state, 'ready'),
          inArray(schema.stageRuns.state, ['queued', 'running']),
        ),
      )
      .orderBy(asc(schema.jobs.createdAt), asc(schema.tasks.priority), asc(sql`"tasks"."rowid"`))
      .limit(1)
      .get();
    if (next === undefined) return undefined;
    const { jobId, id: taskId } = next.task;
    const now = new Date();
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = requireTask(tx, taskId, 'ready');
        const leaseId = newId('lse');
        const inserted = tx
          .insert(schema.leases)
          .values({
            resourceKind: 'task',
            resourceId: taskId,
            holder: this.holder,
            leaseId,
            acquiredAt: now.toISOString(),
            heartbeatAt: now.toISOString(),
            expiresAt: this.leaseExpiry(),
          })
          .onConflictDoNothing()
          .run();
        if (inserted.changes !== 1) throw new Error(`Task ${taskId} is already leased`);
        stepTask(tx, { jobId, actor: ACTOR }, task, 'claimed', { payload: { leaseId } });
        const execution = state.stageRuns.find((r) => r.stageId === 'execution');
        if (execution?.state === 'queued') step(execution, 'running');
      },
    );
    this.opts.onCommit();
    return { jobId, taskId };
  }

  // ---- an Attempt ----------------------------------------------------------------

  private async runAttempt(harness: AgentHarness, taskId: string): Promise<void> {
    const { db } = this.opts;
    const task = requireTask(db, taskId, 'claimed');
    const definition = TaskDefinitionSchema.parse(JSON.parse(task.definitionJson));
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, task.jobId)).get();
    const repo = db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, task.repositoryId))
      .get();
    if (job === undefined || repo === undefined)
      throw new Error(`Task ${taskId} has no Job or Repository`);

    // The Worktree, from a freshly fetched base, in the Factory Clone only.
    const clone = repo.clonePath;
    await fetchRemote(clone);
    const baseSha =
      (await resolveCommit(clone, `refs/remotes/origin/${repo.defaultBranch}`)) ??
      (await resolveCommit(clone, `refs/heads/${repo.defaultBranch}`));
    if (baseSha === undefined)
      throw new Error(`the Factory Clone has no ${repo.defaultBranch} to start from`);
    const { path, branch } = taskWorktree({
      workspaceRoot: this.opts.workspaceRoot,
      repositoryId: repo.id,
      jobId: job.id,
      taskId: task.id,
      taskKey: task.key,
    });
    const worktreeId = newId('wt');
    const attemptId = newId('att');
    const n = 1;
    const { wallClockMs } = this;
    // Built before the Worktree exists, so nothing between its creation and its row can fail.
    const packet = this.packet({ job, task, definition, repo, path, branch, baseSha, wallClockMs });
    await excludeResultFile(clone);
    mkdirSync(dirname(path), { recursive: true });
    await addWorktree({ repo: clone, path, branch, startSha: baseSha });

    const portBase = changeJob(
      db,
      { jobId: job.id, expectedVersion: 'current', actor: ACTOR },
      (tx) => {
        const base = allocatePortBlock(tx, {
          holder: `${this.holder}/${attemptId}`,
          expiresAt: this.leaseExpiry(),
        });
        const now = new Date().toISOString();
        tx.insert(schema.worktrees)
          .values({
            id: worktreeId,
            jobId: job.id,
            taskId,
            repositoryId: repo.id,
            path,
            branch,
            baseSha,
            state: 'active',
            portBase: base,
            createdAt: now,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'worktree',
          entityId: worktreeId,
          jobId: job.id,
          type: 'worktree.created',
          actor: ACTOR,
          payload: { taskId, to: 'active', path, branch, baseSha, portBase: base },
        });
        tx.insert(schema.attempts)
          .values({
            id: attemptId,
            taskId,
            n,
            state: 'running',
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            promptTemplateId: TASK_TEMPLATE_ID,
            promptTemplateHash: TASK_TEMPLATE_HASH,
            packetJson: JSON.stringify(packet),
            worktreeId,
            baseSha,
            commitsJson: '[]',
            protocolViolationsJson: '[]',
            startedAt: now,
            version: 0,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'attempt',
          entityId: attemptId,
          jobId: job.id,
          type: 'attempt.started',
          actor: ACTOR,
          payload: {
            taskId,
            n,
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
            worktreeId,
            baseSha,
          },
        });
        stepTask(
          tx,
          { jobId: job.id, actor: ACTOR },
          requireTask(tx, taskId, 'claimed'),
          'running',
          {
            payload: { attemptId },
          },
        );
        return base;
      },
    );
    this.opts.onCommit();

    const env = guardrailEnv(this.opts.runtimeEnv, {
      FACTORY_JOB_ID: job.id,
      FACTORY_TASK_ID: taskId,
      FACTORY_ATTEMPT_ID: attemptId,
      FACTORY_PORT_BASE: String(portBase),
      PORT: String(portBase),
      CI: 'true',
    });

    const { result } = await this.harnessRun(harness, {
      role: 'developer',
      template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
      jobId: job.id,
      taskId,
      taskKey: task.key,
      attemptId,
      n,
      prompt: renderTaskPrompt(packet),
      cwd: path,
      env,
      wallClockMs,
    });
    if (this.closed) return; // shutdown: left running (recovery is #13)

    this.toVerifying(job.id, taskId, attemptId);

    // Trust nothing the Harness said: read the Worktree and git.
    const inspection = await inspect(path, baseSha);
    const resultContent =
      inspection.result.kind === 'missing'
        ? undefined
        : this.opts.artifacts.writeContent(
            inspection.result.kind === 'valid'
              ? inspection.result.value
              : inspection.result.content,
          );

    let outcome: Outcome;
    let verificationRuns: VerificationRunRecord[] = [];
    if (result === undefined || result.exit.kind !== 'exited' || result.exit.code !== 0) {
      outcome = {
        state: 'failed',
        exitReason: 'harness_failed',
        detail: `the ${harness.id} Harness Run ${result === undefined ? 'did not start' : describeHarnessExit(result.exit)}`,
      };
    } else if (inspection.result.kind === 'missing') {
      outcome = {
        state: 'failed',
        exitReason: 'invalid_output',
        detail: `[result.missing] no Task Result at ${RESULT_FILE}`,
      };
    } else if (inspection.result.kind === 'invalid') {
      outcome = {
        state: 'failed',
        exitReason: 'invalid_output',
        detail: inspection.result.issues.map((i) => `[${i.rule}] ${i.message}`).join('; '),
      };
    } else if (inspection.result.value.status !== 'done') {
      outcome = {
        state: 'failed',
        exitReason: 'not_done',
        detail: `the Task Result's status is ${inspection.result.value.status}; only done is handled before Phase B`,
      };
    } else {
      const verified = await this.verify(definition, path, env);
      if (verified === undefined) return; // shutdown during verification
      verificationRuns = verified;
      const at = { headSha: inspection.headSha, baseSha };
      const problems = [
        ...verificationProblems(
          at,
          verificationRuns.map((r) => ({ ...r, ...at })),
        ),
        ...(await worktreeProblems(path, inspection.headSha, 'verification')),
        ...commandCriteriaFailures(
          verificationRuns,
          criteriaCoveredBy(this.opts.db, job.id, definition.acceptance),
        ),
      ];
      if (problems.length === 0) {
        // Every factory Gate passed: the independent review decides the rest.
        const usage = usageOf(result);
        this.toReview({
          jobId: job.id,
          taskId,
          attemptId,
          baseSha,
          inspection,
          resultContent,
          verificationRuns,
          usage,
        });
        // The reviewer never sees the implementer's claims (they are stored as an Artifact).
        rmSync(join(path, dirname(RESULT_FILE)), { recursive: true, force: true });
        const reviewed = await this.review(harness, {
          job,
          task,
          definition,
          attemptId,
          path,
          env,
          at,
          runs: verificationRuns,
        });
        if (reviewed === undefined) return; // shutdown during the review
        this.finishReview({
          jobId: job.id,
          taskId,
          attemptId,
          worktreeId,
          inspection,
          usage,
          reviewed,
          current: { headSha: (await resolveCommit(path, 'HEAD')) ?? '(none)', baseSha },
          reviewerChanges: await worktreeProblems(path, inspection.headSha, 'reviewer'),
        });
        return;
      }
      outcome = {
        state: 'failed',
        exitReason: 'gates_failed',
        detail: problems.join('; '),
      };
    }

    this.finish({
      jobId: job.id,
      taskId,
      attemptId,
      worktreeId,
      baseSha,
      inspection,
      resultContent,
      verificationRuns,
      outcome,
      usage: usageOf(result),
    });
  }

  private packet(input: {
    job: typeof schema.jobs.$inferSelect;
    task: TaskRow;
    definition: TaskDefinition;
    repo: typeof schema.repositories.$inferSelect;
    path: string;
    branch: string;
    baseSha: string;
    wallClockMs: number;
  }): TaskPacket {
    const { job, task, definition, repo } = input;
    const artifacts = this.opts.artifacts.listForJob(job.id).filter((a) => a.stageRunId !== null);
    const spec = artifacts.find((a) => a.kind === 'spec');
    const discovery = artifacts.find((a) => a.kind === 'discovery');
    const objective =
      spec === undefined
        ? job.description || job.title
        : SpecificationProposalSchema.parse(this.opts.artifacts.readJson(spec.id)).objective;
    const files =
      discovery === undefined
        ? []
        : DiscoveryProposalSchema.parse(this.opts.artifacts.readJson(discovery.id)).files.map(
            (f) => f.path,
          );
    const criteria = criteriaCoveredBy(this.opts.db, job.id, definition.acceptance);
    return TaskPacketSchema.parse({
      packetVersion: 1,
      job: { id: job.id, title: job.title, objective },
      task: {
        id: task.id,
        key: task.key,
        title: task.title,
        objective: definition.objective,
        role: definition.role,
        risk: definition.risk,
      },
      repository: {
        id: repo.id,
        name: repo.name,
        worktreePath: input.path,
        baseBranch: repo.defaultBranch,
        baseSha: input.baseSha,
        taskBranch: input.branch,
      },
      scope: {
        writable: definition.scope.writable,
        forbidden: definition.scope.forbidden,
        readHints: definition.scope.readHints,
      },
      acceptance: criteria.map((c) => ({ code: c.code, text: c.text, mandatory: c.mandatory })),
      verification: definition.verification.map((v) => ({
        key: v.key,
        command: v.command,
        required: v.required,
      })),
      context: {
        artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, contentHash: a.contentHash })),
        files,
      },
      limits: { maxTurns: MAX_TURNS, wallClockS: input.wallClockMs / 1000 },
      protocol: { resultFile: RESULT_FILE, mayAskQuestions: false },
    } satisfies TaskPacket);
  }

  /**
   * One Harness Run of an Attempt, the developer's or a reviewer's, recorded
   * as `harness_run.started` / `.finished` events. Always `start`: a new
   * Session, never a resumed one. `evaluate` judges the output for the record.
   */
  private async harnessRun(
    harness: AgentHarness,
    input: {
      role: 'developer' | 'reviewer';
      template: { id: string; hash: string };
      jobId: string;
      taskId: string;
      taskKey: string;
      attemptId: string;
      n: number;
      prompt: string;
      cwd: string;
      env: Record<string, string>;
      wallClockMs: number;
      reprompt?: readonly RuleIssue[];
    },
    evaluate?: (result: HarnessRawResult) => { outcome: string; issues?: RuleIssue[] },
  ): Promise<{ result: HarnessRawResult | undefined; sessionRef: string | undefined }> {
    let started: HarnessRun;
    try {
      started = await harness.start({
        role: input.role,
        prompt: input.prompt,
        cwd: input.cwd,
        env: input.env,
        subject: { jobId: input.jobId, stageId: 'execution', taskKey: input.taskKey },
        limits: { wallClockMs: input.wallClockMs, maxTurns: MAX_TURNS },
      });
    } catch (err) {
      this.opts.log(`task scheduler: the ${harness.id} Harness did not start: ${String(err)}`);
      return { result: undefined, sessionRef: undefined };
    }
    this.currentRun = started;
    this.opts.db.transaction((tx) => {
      if (input.role === 'developer' && started.sessionRef !== undefined) {
        tx.update(schema.attempts)
          .set({ sessionRef: started.sessionRef })
          .where(eq(schema.attempts.id, input.attemptId))
          .run();
      }
      appendEvent(tx, {
        entityKind: 'harness_run',
        entityId: started.executionId,
        jobId: input.jobId,
        type: 'harness_run.started',
        actor: ACTOR,
        payload: {
          attemptId: input.attemptId,
          taskId: input.taskId,
          stageId: 'execution',
          role: input.role,
          harnessId: harness.id,
          n: input.n,
          template: input.template,
          ...(started.sessionRef === undefined ? {} : { sessionRef: started.sessionRef }),
          ...(started.pid === undefined ? {} : { pid: started.pid }),
          ...(input.reprompt === undefined ? {} : { reprompt: { issues: input.reprompt } }),
        },
      });
    });
    this.opts.onCommit();
    // Progress isn't stored yet (redaction first, #11), only counted.
    const drained = (async () => {
      let count = 0;
      for await (const event of started.events) if (event.kind !== 'usage') count++;
      return count;
    })();
    const result = await started.result;
    const events = await drained;
    this.currentRun = undefined;
    const judged = evaluate?.(result);
    this.event(input.jobId, 'harness_run', started.executionId, 'harness_run.finished', {
      attemptId: input.attemptId,
      taskId: input.taskId,
      role: input.role,
      harnessId: harness.id,
      n: input.n,
      exit: result.exit,
      durationMs: result.durationMs,
      events,
      usage: result.usage,
      ...(judged === undefined ? {} : judged),
    });
    return { result, sessionRef: started.sessionRef };
  }

  private toVerifying(jobId: string, taskId: string, attemptId: string): void {
    changeJob(this.opts.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      stepAttempt(tx, { jobId, actor: ACTOR }, attemptId, 'running', { state: 'verifying' });
      stepTask(tx, { jobId, actor: ACTOR }, requireTask(tx, taskId, 'running'), 'verifying', {
        payload: { attemptId },
      });
    });
    this.opts.onCommit();
  }

  /** Runs every verification command in the Worktree, in order, under the guardrail. */
  private async verify(
    definition: TaskDefinition,
    cwd: string,
    env: Record<string, string>,
  ): Promise<VerificationRunRecord[] | undefined> {
    const records: VerificationRunRecord[] = [];
    for (const v of definition.verification) {
      const startedAt = new Date().toISOString();
      const proc = spawnGuarded({
        command: 'sh',
        args: ['-c', v.command],
        cwd,
        env,
        timeoutMs: this.verifyTimeoutMs,
      });
      this.currentProc = proc;
      const exit = await proc.exit;
      this.currentProc = undefined;
      if (this.closed) return undefined;
      const exitCode = exit.timedOut ? null : exit.code;
      records.push({
        key: v.key,
        command: v.command,
        required: v.required,
        criteria: v.criteria,
        exitCode,
        timedOut: exit.timedOut,
        startedAt,
        durationMs: exit.durationMs,
        output: exit.output,
        content: this.opts.artifacts.writeContent({
          key: v.key,
          command: v.command,
          exitCode,
          timedOut: exit.timedOut,
          truncated: exit.truncated,
          output: exit.output,
        }),
      });
    }
    return records;
  }

  /**
   * Ends an Attempt that never reached review: records everything the factory
   * found, ends the Attempt, moves the Task, releases its leases, preserves
   * the Worktree and settles `execution`. One transaction.
   */
  private finish(input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    worktreeId: string;
    baseSha: string;
    inspection: Inspection;
    resultContent: StoredContent | undefined;
    verificationRuns: VerificationRunRecord[];
    outcome: Outcome;
    usage: Usage | null;
  }): void {
    changeJob(
      this.opts.db,
      { jobId: input.jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        this.recordVerification(tx, input);
        endAttempt(tx, state, step, { ...input, from: 'verifying' });
      },
    );
    this.opts.onCommit();
  }

  /**
   * Every factory Gate passed: records the claim, the verification runs and
   * their Evidence, and moves the Attempt and the Task to `in_review`. One
   * transaction, before the reviewer starts, so the Evidence it is sent is stored.
   */
  private toReview(input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    baseSha: string;
    inspection: Inspection;
    resultContent: StoredContent | undefined;
    verificationRuns: VerificationRunRecord[];
    usage: Usage | null;
  }): void {
    const { jobId, taskId, attemptId, inspection } = input;
    changeJob(this.opts.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      this.recordVerification(tx, input);
      stepAttempt(
        tx,
        { jobId, actor: ACTOR },
        attemptId,
        'verifying',
        { state: 'in_review', ...inspectionColumns(inspection, input.usage) },
        { headSha: inspection.headSha, baseSha: input.baseSha },
      );
      stepTask(tx, { jobId, actor: ACTOR }, requireTask(tx, taskId, 'verifying'), 'in_review', {
        payload: { attemptId, headSha: inspection.headSha },
      });
    });
    this.opts.onCommit();
  }

  /**
   * The independent review: a reviewer Harness Run in a new Session, in the
   * Worktree at the reviewed head, given the Review Packet only. Its output
   * is checked like any proposal; one re-prompt (again a new Session) carries
   * the problems. `undefined` on shutdown.
   */
  private async review(
    harness: AgentHarness,
    input: {
      job: typeof schema.jobs.$inferSelect;
      task: TaskRow;
      definition: TaskDefinition;
      attemptId: string;
      path: string;
      env: Record<string, string>;
      at: GateRef;
      runs: readonly VerificationRunRecord[];
    },
  ): Promise<Reviewed | undefined> {
    const { db } = this.opts;
    const spec = this.opts.artifacts
      .listForJob(input.job.id)
      .find((a) => a.kind === 'spec' && a.stageRunId !== null);
    if (spec === undefined)
      throw new Error(`Job ${input.job.id} has no Specification to review against`);
    const criteria = criteriaCoveredBy(db, input.job.id, input.definition.acceptance);
    const packet = await buildReviewPacket({
      subject: {
        jobId: input.job.id,
        taskId: input.task.id,
        taskKey: input.task.key,
        attemptId: input.attemptId,
        ...input.at,
      },
      repo: input.path,
      specification: SpecificationProposalSchema.parse(this.opts.artifacts.readJson(spec.id)),
      criteria,
      runs: input.runs,
      commandVerdicts: criteria.map((c) => ({
        code: c.code,
        ...criterionVerdict(input.runs.filter((r) => r.criteria.includes(c.code))),
      })),
    });
    let rejected: RuleIssue[] | undefined;
    for (let n = 1; n <= REVIEW_RUNS; n++) {
      let evaluation: ReviewEvaluation | undefined;
      const { result, sessionRef } = await this.harnessRun(
        harness,
        {
          role: 'reviewer',
          template: { id: REVIEW_TEMPLATE_ID, hash: REVIEW_TEMPLATE_HASH },
          jobId: input.job.id,
          taskId: input.task.id,
          taskKey: input.task.key,
          attemptId: input.attemptId,
          n,
          prompt: renderReviewPrompt(packet, rejected),
          cwd: input.path,
          env: input.env,
          wallClockMs: this.reviewWallClockMs,
          ...(rejected === undefined ? {} : { reprompt: rejected }),
        },
        (r) => {
          evaluation = evaluateReview(r, packet);
          return evaluation.kind === 'invalid'
            ? { outcome: 'invalid', issues: evaluation.issues }
            : { outcome: evaluation.kind };
        },
      );
      if (this.closed) return undefined;
      evaluation ??= evaluateReview(result, packet);
      if (evaluation.kind === 'valid') {
        return {
          kind: 'valid',
          packet,
          value: evaluation.value,
          sessionRef: sessionRef ?? null,
          harnessId: harness.id,
        };
      }
      if (evaluation.kind === 'harness_failed') {
        return { kind: 'failed', exitReason: 'review_failed', detail: evaluation.message };
      }
      rejected = evaluation.issues;
    }
    return {
      kind: 'failed',
      exitReason: 'invalid_output',
      detail: `the review was invalid after ${String(REVIEW_RUNS - 1)} re-prompt: ${(rejected ?? []).map((i) => `[${i.rule}] ${i.message}`).join('; ')}`,
    };
  }

  /**
   * Records a valid review (its Artifact, its row, its Findings and its
   * criterion verdicts as Evidence), then decides approval with the full rule
   * against the Task Branch head as git reads it now, and ends the Attempt. One
   * transaction. No review is stored without a valid proposal: the Attempt fails
   * `invalid_output` (still invalid after the re-prompt) or `review_failed` (the
   * reviewer Run crashed, timed out or did not start).
   */
  private finishReview(input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    worktreeId: string;
    inspection: Inspection;
    usage: Usage | null;
    reviewed: Reviewed;
    current: GateRef;
    reviewerChanges: string[];
  }): void {
    const { jobId, taskId, attemptId, reviewed } = input;
    const reviewedHead = input.inspection.headSha;
    const base = input.current.baseSha;
    const content =
      reviewed.kind === 'valid' ? this.opts.artifacts.writeContent(reviewed.value) : undefined;
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = requireTask(tx, taskId, 'in_review');
        const definition = TaskDefinitionSchema.parse(JSON.parse(task.definitionJson));
        let review: ApprovalInput['review'] = null;
        if (reviewed.kind === 'valid' && content !== undefined) {
          const { value } = reviewed;
          const artifact = this.opts.artifacts.record(
            tx,
            { jobId, taskId, attemptId, kind: 'review', content },
            ACTOR,
          );
          const reviewId = newId('rev');
          tx.insert(schema.reviews)
            .values({
              id: reviewId,
              jobId,
              taskId,
              attemptId,
              reviewerHarnessId: reviewed.harnessId,
              reviewerHarnessVersion: this.opts.harnessVersion,
              sessionRef: reviewed.sessionRef,
              promptTemplateId: REVIEW_TEMPLATE_ID,
              promptTemplateHash: REVIEW_TEMPLATE_HASH,
              packetJson: JSON.stringify(reviewed.packet),
              headSha: reviewedHead,
              baseSha: base,
              outcome: value.outcome,
              summary: value.summary,
              artifactId: artifact.id,
              createdAt: new Date().toISOString(),
            })
            .run();
          value.findings.forEach((f, position) => {
            tx.insert(schema.reviewFindings)
              .values({ id: newId('fnd'), reviewId, position, ...f, blocking: isBlocking(f) })
              .run();
          });
          for (const criterion of criteriaCoveredBy(tx, jobId, definition.acceptance)) {
            const verdict = value.criteria.find((c) => c.code === criterion.code);
            tx.insert(schema.evidence)
              .values({
                id: newId('evd'),
                attemptId,
                kind: 'criterion',
                criterionId: criterion.id,
                reviewId,
                verdict: verdict?.verdict ?? 'not_tested',
                detail: verdict?.detail ?? 'the review gave no verdict',
                headSha: reviewedHead,
                baseSha: base,
                artifactId: artifact.id,
              })
              .run();
          }
          appendEvent(tx, {
            entityKind: 'review',
            entityId: reviewId,
            jobId,
            type: 'review.recorded',
            actor: ACTOR,
            payload: {
              taskId,
              attemptId,
              outcome: value.outcome,
              headSha: reviewedHead,
              baseSha: base,
              findings: value.findings.length,
              blocking: value.findings.filter(isBlocking).length,
            },
          });
          review = {
            outcome: value.outcome,
            blockingFindings: value.findings.filter(isBlocking).length,
            headSha: reviewedHead,
            baseSha: base,
          };
        }
        let outcome: Outcome;
        if (reviewed.kind === 'failed') {
          outcome = { state: 'failed', exitReason: reviewed.exitReason, detail: reviewed.detail };
        } else {
          const decision = decideApproval(
            approvalInput(tx, {
              jobId,
              attemptId,
              definition,
              current: input.current,
              review,
            }),
          );
          const problems = [...decision.problems, ...input.reviewerChanges];
          outcome =
            problems.length === 0
              ? {
                  state: 'passed',
                  exitReason: 'completed',
                  detail: 'every Gate passed and the review approved',
                }
              : {
                  state: 'failed',
                  exitReason:
                    review?.outcome === 'changes_requested' && isCurrent(review, input.current)
                      ? 'changes_requested'
                      : 'gates_failed',
                  detail: problems.join('; '),
                };
        }
        endAttempt(tx, state, step, {
          jobId,
          taskId,
          attemptId,
          worktreeId: input.worktreeId,
          baseSha: base,
          inspection: input.inspection,
          outcome,
          usage: input.usage,
          from: 'in_review',
        });
      },
    );
    this.opts.onCommit();
  }

  /** Records the Task Result claim, the verification runs, their logs and their Evidence. */
  private recordVerification(
    tx: Tx,
    input: {
      jobId: string;
      taskId: string;
      attemptId: string;
      baseSha: string;
      inspection: Inspection;
      resultContent: StoredContent | undefined;
      verificationRuns: VerificationRunRecord[];
    },
  ): void {
    const { jobId, taskId, attemptId } = input;
    const head = input.inspection.headSha;
    const base = input.baseSha;
    if (input.resultContent !== undefined) {
      this.opts.artifacts.record(
        tx,
        { jobId, taskId, attemptId, kind: 'task_result', content: input.resultContent },
        ACTOR,
      );
    }
    const definition = TaskDefinitionSchema.parse(
      JSON.parse(requireTask(tx, taskId, 'verifying').definitionJson),
    );
    for (const run of input.verificationRuns) {
      const log = this.opts.artifacts.record(
        tx,
        { jobId, taskId, attemptId, kind: 'log', content: run.content },
        ACTOR,
      );
      const id = newId('vr');
      tx.insert(schema.verificationRuns)
        .values({
          id,
          attemptId,
          commandKey: run.key,
          command: run.command,
          required: run.required,
          headSha: head,
          baseSha: base,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          startedAt: run.startedAt,
          durationMs: run.durationMs,
          outputArtifactId: log.id,
        })
        .run();
      tx.insert(schema.evidence)
        .values({
          id: newId('evd'),
          attemptId,
          kind: 'verification',
          verificationRunId: id,
          verdict: run.exitCode === 0 ? 'pass' : 'fail',
          detail: run.timedOut
            ? 'timed out'
            : `exit ${String(run.exitCode)}${run.required ? '' : ' (not required)'}`,
          headSha: head,
          baseSha: base,
          artifactId: log.id,
        })
        .run();
    }
    if (input.verificationRuns.length > 0) {
      for (const criterion of criteriaCoveredBy(tx, jobId, definition.acceptance)) {
        const verdict = criterionVerdict(
          input.verificationRuns.filter((r) => r.criteria.includes(criterion.code)),
        );
        tx.insert(schema.evidence)
          .values({
            id: newId('evd'),
            attemptId,
            kind: 'criterion',
            criterionId: criterion.id,
            verdict: verdict.verdict,
            detail: verdict.detail,
            headSha: head,
            baseSha: base,
          })
          .run();
      }
    }
  }

  /** Fails a Task the factory itself could not carry through (`factory_error`). */
  private failTask(jobId: string, taskId: string, message: string): void {
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
        if (task === undefined) return;
        const attempt = tx
          .select()
          .from(schema.attempts)
          .where(
            and(
              eq(schema.attempts.taskId, taskId),
              inArray(schema.attempts.state, ['running', 'verifying']),
            ),
          )
          .get();
        const detail = `the factory could not run this Task: ${message}`;
        let portBase: number | undefined;
        if (attempt !== undefined) {
          stepAttempt(
            tx,
            { jobId, actor: ACTOR },
            attempt.id,
            AttemptStateSchema.parse(attempt.state),
            {
              state: 'failed',
              exitReason: 'factory_error',
              exitDetail: detail,
              finishedAt: new Date().toISOString(),
            },
            { exitReason: 'factory_error' },
          );
          const worktree = requireWorktree(tx, attempt.worktreeId);
          portBase = worktree.portBase;
          if (worktree.state === 'active')
            stepWorktree(tx, { jobId, actor: ACTOR }, worktree, 'active', 'preserved');
        }
        if (['claimed', 'running', 'verifying'].includes(task.state)) {
          stepTask(tx, { jobId, actor: ACTOR }, task, 'failed', {
            reason: 'factory_error',
            payload: { detail },
          });
        }
        releaseAttemptTokens(tx, taskId, portBase);
        settleExecution(tx, state, step);
      },
    );
    this.opts.onCommit();
  }

  // ---- closure ---------------------------------------------------------------------

  private nextClosure(): { id: string; jobId: string } | undefined {
    return this.opts.db
      .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
      .from(schema.stageRuns)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
      .where(and(eq(schema.stageRuns.stageId, 'closure'), eq(schema.stageRuns.state, 'queued')))
      .orderBy(asc(schema.jobs.createdAt))
      .limit(1)
      .get();
  }

  /**
   * Writes the Delivery Report, then removes the Job's Worktrees (their
   * branches stay in the Factory Clone), then completes `closure`. A Worktree
   * that git refuses to remove stays `preserved`.
   */
  private async runClosure(stageRunId: string, jobId: string): Promise<void> {
    const { db } = this.opts;
    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
      step(requireStageRun(state, stageRunId, 'queued'), 'running');
    });
    this.opts.onCommit();

    // A closure that stopped after recording its report resumes from that report:
    // it is never written twice (the full resume is recovery's, #13).
    const existing = this.opts.artifacts.listForJob(jobId).find((a) => a.kind === 'report');
    if (existing === undefined) {
      const content = this.opts.artifacts.writeContent(await buildDeliveryReport(db, jobId));
      db.transaction(
        (tx) => {
          this.opts.artifacts.record(tx, { jobId, kind: 'report', content }, ACTOR);
        },
        { behavior: 'immediate' },
      );
      this.opts.onCommit();
    }

    // Removal only after delivery: the branches hold the work, the report says where.
    const preserved = db
      .select()
      .from(schema.worktrees)
      .where(and(eq(schema.worktrees.jobId, jobId), eq(schema.worktrees.state, 'preserved')))
      .all();
    for (const worktree of preserved) {
      const repo = db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, worktree.repositoryId))
        .get();
      try {
        if (repo === undefined) throw new Error('no Repository');
        await removeWorktree(repo.clonePath, worktree.path);
      } catch (err) {
        this.event(jobId, 'worktree', worktree.id, 'worktree.remove_failed', {
          path: worktree.path,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
        stepWorktree(
          tx,
          { jobId, actor: ACTOR },
          requireWorktree(tx, worktree.id),
          'preserved',
          'removed',
        );
      });
      this.opts.onCommit();
    }

    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
      step(requireStageRun(state, stageRunId, 'running'), 'succeeded');
    });
    this.opts.onCommit();
  }

  private failClosure(jobId: string, stageRunId: string, message: string): void {
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (_, state, step) => {
        const run = state.stageRuns.find((r) => r.id === stageRunId);
        if (run?.state !== 'running') return;
        step(run, 'failed', {
          failure: { reason: 'factory_error', message: `closure failed: ${message}`, issues: [] },
        });
      },
    );
    this.opts.onCommit();
  }

  private event(
    jobId: string,
    entityKind: string,
    entityId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.opts.db.transaction((tx) => {
      appendEvent(tx, { entityKind, entityId, jobId, type, actor: ACTOR, payload });
    });
    this.opts.onCommit();
  }
}

// ---- after the Harness Run ---------------------------------------------------------

/**
 * What is really in the Worktree: leftovers committed as a flagged WIP commit
 * (never discarded), the head and commits read from git, and the Task Result
 * parsed and checked against git.
 */
async function inspect(worktree: string, baseSha: string): Promise<Inspection> {
  const leftovers = await uncommittedPaths(worktree);
  let wipCommit: string | null = null;
  if (leftovers.length > 0) {
    wipCommit = await commitAll(
      worktree,
      `wip: uncommitted changes left by the Harness\n\n` +
        `The factory committed these so nothing is lost. Review them.\n\n` +
        `Factory-WIP: true\n` +
        leftovers.map((p) => `Factory-WIP-Path: ${p}`).join('\n'),
    );
  }
  const headSha = await resolveCommit(worktree, 'HEAD');
  if (headSha === undefined) throw new Error(`the Worktree ${worktree} has no HEAD`);
  const commits = (await commitsBetween(worktree, baseSha, headSha)).map((c) => c.sha);

  const file = join(worktree, RESULT_FILE);
  let result: Inspection['result'] = { kind: 'missing' };
  // Untrusted: never follow a link out of the Worktree, never read without a bound.
  const stat = lstatOrUndefined(file);
  if (stat !== undefined && (!stat.isFile() || stat.size > MAX_RESULT_BYTES)) {
    result = {
      kind: 'invalid',
      content: null,
      issues: [
        {
          rule: 'result.regular_file',
          message: `${RESULT_FILE} must be a regular file of at most ${String(MAX_RESULT_BYTES)} bytes (found ${stat.isSymbolicLink() ? 'a symbolic link' : stat.isFile() ? `${String(stat.size)} bytes` : 'no regular file'}); it was not read`,
        },
      ],
    };
  } else if (stat !== undefined) {
    const raw = readFileSync(file, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      result = {
        kind: 'invalid',
        content: raw,
        issues: [
          {
            rule: 'json',
            message: `the Task Result is not JSON (${err instanceof Error ? err.message : String(err)})`,
          },
        ],
      };
    }
    if (result.kind === 'missing') {
      const parsed = TaskResultSchema.safeParse(json);
      result = parsed.success
        ? { kind: 'valid', value: parsed.data }
        : { kind: 'invalid', content: json, issues: schemaIssues(parsed.error) };
    }
  }
  const violations: RuleIssue[] = [];
  const committed = (await changedPaths(worktree, baseSha, headSha)).filter(
    (p) => p === RESULT_FILE || p.startsWith(`${dirname(RESULT_FILE)}/`),
  );
  if (committed.length > 0) {
    violations.push({
      rule: 'result.not_committed',
      message: `the Task Branch commits the reserved ${dirname(RESULT_FILE)}/ path: ${committed.join(', ')}`,
    });
  }
  if (result.kind === 'valid') {
    for (const claimed of result.value.commits) {
      const lower = claimed.toLowerCase();
      if (lower.length < 7 || !commits.some((c) => c.startsWith(lower))) {
        violations.push({
          rule: 'result.commits_exist',
          message: `the Task Result lists commit ${claimed}, which is not on the Task Branch (base..head)`,
        });
      }
    }
  }
  return { headSha, commits, wipCommit, result, violations };
}

/** The reviewer's proposal and what it was given, or why there is none. */
type Reviewed =
  | {
      kind: 'valid';
      packet: ReviewPacket;
      value: ReviewProposal;
      sessionRef: string | null;
      harnessId: string;
    }
  | { kind: 'failed'; exitReason: 'review_failed' | 'invalid_output'; detail: string };

function usageOf(result: HarnessRawResult | undefined): Usage {
  return result === undefined
    ? { tag: 'unknown', inputTokens: null, outputTokens: null, costUsd: null, durationMs: 0 }
    : { ...result.usage, durationMs: Math.round(result.durationMs) };
}

/** What the factory read from git about an Attempt, as Attempt columns. */
function inspectionColumns(inspection: Inspection, usage: Usage | null) {
  return {
    headSha: inspection.headSha,
    commitsJson: JSON.stringify(inspection.commits),
    wipCommit: inspection.wipCommit,
    protocolViolationsJson: JSON.stringify(inspection.violations),
    usageJson: usage === null ? null : JSON.stringify(usage),
  };
}

/**
 * Whether the Worktree is still exactly `head`: `who` (verification, the
 * reviewer) must leave no modified or untracked files, and, for
 * verification, must not move HEAD (the review's staleness is the approval
 * rule's to judge).
 */
async function worktreeProblems(
  path: string,
  head: string,
  after: 'verification' | 'reviewer',
): Promise<string[]> {
  const problems: string[] = [];
  if (after === 'verification' && (await resolveCommit(path, 'HEAD')) !== head) {
    problems.push('HEAD moved during verification, so the Evidence is stale');
  }
  const changed = await uncommittedPaths(path);
  if (changed.length > 0) {
    // The Gates didn't see exactly head_sha, so their Evidence can't be tied to it.
    const who = after === 'verification' ? 'verification' : 'the reviewer';
    const fix =
      after === 'verification'
        ? 'make the commands leave no untracked or modified files (or ignore them)'
        : 'the reviewer must change nothing';
    problems.push(
      `${who} changed the Worktree (${changed.slice(0, 10).join(', ')}), so the Gates do not match head_sha; ${fix}`,
    );
  }
  return problems;
}

/** Mandatory criteria whose verifying commands failed: no review can make them pass. */
function commandCriteriaFailures(
  runs: readonly VerificationRunRecord[],
  criteria: readonly { code: string; mandatory: boolean }[],
): string[] {
  return criteria
    .filter((c) => c.mandatory)
    .filter(
      (c) => criterionVerdict(runs.filter((r) => r.criteria.includes(c.code))).verdict === 'fail',
    )
    .map((c) => `mandatory ${c.code} has Evidence fail from its verifying commands`);
}

/** The approval rule's input, read from what is recorded for the Attempt. */
function approvalInput(
  tx: Tx,
  input: {
    jobId: string;
    attemptId: string;
    definition: TaskDefinition;
    current: GateRef;
    review: ApprovalInput['review'];
  },
): ApprovalInput {
  const { jobId, attemptId, definition, current, review } = input;
  const runs = tx
    .select()
    .from(schema.verificationRuns)
    .where(eq(schema.verificationRuns.attemptId, attemptId))
    .all();
  const evidence = tx
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.attemptId, attemptId), eq(schema.evidence.kind, 'criterion')))
    .all();
  return {
    current,
    verification: runs.map((r) => ({
      key: r.commandKey,
      required: r.required,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      headSha: r.headSha,
      baseSha: r.baseSha,
    })),
    criteria: criteriaCoveredBy(tx, jobId, definition.acceptance).map((c) => ({
      code: c.code,
      mandatory: c.mandatory,
      evidence: evidence
        .filter((e) => e.criterionId === c.id)
        .map((e) => ({
          source: evidenceSource(e),
          verdict: EvidenceVerdictSchema.parse(e.verdict),
          headSha: e.headSha,
          baseSha: e.baseSha,
        })),
    })),
    review,
  };
}

/**
 * Ends the Attempt with `outcome`, moves the Task to `approved` or `failed`,
 * releases the Attempt's leases, preserves the Worktree and settles `execution`.
 */
function endAttempt(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    worktreeId: string;
    baseSha: string;
    inspection: Inspection;
    outcome: Outcome;
    usage: Usage | null;
    from: 'verifying' | 'in_review';
  },
): void {
  const { jobId, taskId, attemptId, outcome, inspection } = input;
  const op = { jobId, actor: ACTOR };
  stepAttempt(
    tx,
    op,
    attemptId,
    input.from,
    {
      state: outcome.state,
      exitReason: outcome.exitReason,
      exitDetail: outcome.detail,
      ...inspectionColumns(inspection, input.usage),
      finishedAt: new Date().toISOString(),
    },
    {
      exitReason: outcome.exitReason,
      headSha: inspection.headSha,
      baseSha: input.baseSha,
      wipCommit: inspection.wipCommit,
    },
  );
  stepTask(
    tx,
    op,
    requireTask(tx, taskId, input.from),
    outcome.state === 'passed' ? 'approved' : 'failed',
    { reason: outcome.exitReason, payload: { attemptId, headSha: inspection.headSha } },
  );
  const worktree = requireWorktree(tx, input.worktreeId);
  releaseAttemptTokens(tx, taskId, worktree.portBase);
  stepWorktree(tx, op, worktree, 'active', 'preserved');
  settleExecution(tx, state, step);
}

const MAX_RESULT_BYTES = 1024 * 1024;

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// ---- rows and transitions -------------------------------------------------------------

function requireTask(db: FactoryDb | Tx, id: string, expected: string): TaskRow {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (task?.state !== expected) {
    throw new Error(`Task ${id} is ${String(task?.state)}, not ${expected}`);
  }
  return task;
}

function requireStageRun(state: JobState, id: string, expected: string) {
  const run = state.stageRuns.find((r) => r.id === id);
  if (run?.state !== expected)
    throw new Error(`Stage Run ${id} is ${String(run?.state)}, not ${expected}`);
  return run;
}

/**
 * Ends `execution` once its Tasks have: `failed` if any Task failed (no Rework
 * route exists before #9), `succeeded` (and `closure` queued) when all are approved.
 */
function settleExecution(tx: Tx, state: JobState, step: StageRunStepper): void {
  const execution = state.stageRuns.find((r) => r.stageId === 'execution');
  if (execution?.state !== 'running') return;
  const tasks = tx.select().from(schema.tasks).where(eq(schema.tasks.jobId, state.job.id)).all();
  const failed = tasks.find((t) => t.state === 'failed');
  if (failed !== undefined) {
    step(execution, 'failed', {
      failure: {
        reason: 'task_failed',
        message: `Task ${failed.key} failed, and Rework is not built yet`,
        issues: [],
      },
    });
    return;
  }
  if (tasks.length > 0 && tasks.every((t) => t.state === 'approved')) {
    step(execution, 'succeeded');
    const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
    if (closure !== undefined) step(closure, 'queued');
  }
}
