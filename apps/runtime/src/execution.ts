/**
 * The Task scheduler, multi-slot (ADR-0020): every Task it can claim under
 * the global, per-Repository and per-Job limits (`claim.ts`) runs at once.
 * It runs the `execution` Stage (claim a ready Task, give it a Worktree from
 * its Dependency Base, run the developer Harness, verify the result itself,
 * then hand it to the review flow in `review.ts`) and the `closure` Stage
 * (`closure.ts`). ARCHITECTURE §7, §10, §12. The proposal scheduler keeps
 * its one slot.
 *
 * After a Harness Run the factory trusts nothing it said: the head commit and
 * the commits come from git, leftovers become a flagged WIP commit, and every
 * verification command is run again by the factory, its exit code recorded as
 * Evidence tied to `(head_sha, base_sha)`.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AttemptCauseSchema,
  AttemptStateSchema,
  checkPathScope,
  criterionVerdict,
  addUsage,
  attemptsCountedForRework,
  HarnessExitSchema,
  inboxQuestionsOf,
  questionProtocolIssues,
  questionRoute,
  resultAsks,
  UsageSchema,
  type HarnessExit,
  routeFailedAttempt,
  type AttemptCause,
  type AnsweredQuestion,
  type GrantGuidance,
  type AttemptFinding,
  type Blocker,
  type HarnessLogContent,
  type VerificationLogContent,
  verificationProblems,
  RESULT_FILE,
  RuleIssueSchema,
  schemaIssues,
  SpecificationProposalSchema,
  DiscoveryProposalSchema,
  TaskDefinitionSchema,
  TaskPacketSchema,
  TaskResultSchema,
  type RuleIssue,
  type TaskDefinition,
  type TaskPacket,
  type TaskResult,
  type Usage,
  toolPolicyOf,
  type SecurityTier,
} from '@factory/domain';
import {
  addWorktree,
  changedPathKinds,
  changedPaths,
  commitsBetween,
  fetchRemote,
  resolveCommit,
  uncommittedPaths,
  updateRef,
} from '@factory/git';
import {
  attachGuarded,
  describeHarnessExit,
  guardrailEnv,
  inspectSpool,
  spawnGuarded,
  type AgentHarness,
  type GuardedProcess,
  type HarnessRawResult,
  type HarnessRun,
} from '@factory/harness';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactStore, StoredContent } from './artifacts.js';
import { claimNextTask, heartbeatIntervalMs, leaseExpiry } from './claim.js';
import { heartbeatTick, sweptAttempt } from './sweeper.js';
import { criteriaCoveredBy } from './criteria.js';
import { blockOnBaseConflict, makeDependencyBase } from './dependency-base.js';
import { settleExecution } from './keep-going.js';
import {
  failClosure,
  nextClosure,
  runClosure,
  runningClosures,
  type CrashPoint,
} from './closure.js';
import { attemptFindings, gateFinding, scopeFinding } from './findings.js';
import {
  changeJob,
  readJobState,
  stepAttempt,
  stepTask,
  stepWorktree,
  type JobState,
  type StageRunStepper,
} from './engine.js';
import { newId } from './ids.js';
import { PassLoop } from './pass-loop.js';
import { routeToPlanning } from './plan-route.js';
import { answersAfter, openQuestionItem } from './questions.js';
import { guidanceAfter } from './blocker-approvals.js';
import { finishReview, recordedRuns, runReview, type AttemptOutcome } from './review.js';
import { renderTaskPrompt, TASK_TEMPLATE_HASH, TASK_TEMPLATE_ID } from './task-packet.js';
import {
  allocatePortBlock,
  commitLeftovers,
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
/** Developer Harness Runs per Attempt: the first, plus one re-prompt for an invalid Task Result. */
const DEVELOPER_RUNS = 2;
/** The security tier every Harness Run runs under in Phase A: Tier 0, the local guardrail. */
const TIER: SecurityTier = 'local';

export { LEASE_HEARTBEAT_MS, LEASE_TTL_MS, leaseExpiry } from './claim.js';
export { claimNextTask, type Claim, type ClaimOptions } from './claim.js';

export interface TaskSchedulerOptions {
  db: FactoryDb;
  /** `undefined`: no Harness is configured, so ready Tasks wait. */
  harness: AgentHarness | undefined;
  /** `config.json` `concurrency.global`: Tasks in flight at once, over every Job. */
  globalConcurrency: number;
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
  /** Where each process's spool directory goes (ADR-0012). */
  spoolRoot: string;
  /** What recovery found to carry on with, before any new claim (ADR-0012). */
  recovered?: readonly Resumption[];
  /**
   * Test-only fault injection: the runtime kills itself (SIGKILL) at this
   * point. Unset in normal use. `closure.after_report`: once the Delivery
   * Report is recorded.
   */
  crashAt?: CrashPoint;
}

export { CRASH_POINTS, type CrashPoint } from './closure.js';

/** An Attempt (or a closure) a previous runtime left in progress, to carry on with. */
export type Resumption =
  | { kind: 'reattach'; attemptId: string }
  | { kind: 'resume'; from: 'verification' | 'review'; attemptId: string }
  | { kind: 'closure'; stageRunId: string; jobId: string };

/** See {@link AttemptProcessSchema}. */
export type AttemptProcess = z.infer<typeof AttemptProcessSchema>;

/**
 * One unit of work in flight (an Attempt or a closure), and the process it
 * waits on now, so a cancel or a shutdown can stop it.
 */
interface Slot {
  jobId: string;
  done: Promise<void>;
  run: HarnessRun | undefined;
  proc: GuardedProcess | undefined;
}

/** Everything an Attempt's steps need, rebuilt from the database when it is resumed. */
interface AttemptContext {
  harness: AgentHarness;
  slot: Slot;
  job: typeof schema.jobs.$inferSelect;
  task: TaskRow;
  definition: TaskDefinition;
  repo: typeof schema.repositories.$inferSelect;
  attemptId: string;
  n: number;
  path: string;
  baseSha: string;
  worktreeId: string;
  env: Record<string, string>;
  packet: TaskPacket;
}

type TaskRow = typeof schema.tasks.$inferSelect;

/** What the factory read from git about an Attempt (as stored on its row). */
interface GitFacts {
  headSha: string;
  commits: string[];
  wipCommit: string | null;
  violations: RuleIssue[];
}

/** What the factory found in the Worktree after the Harness Run. */
interface Inspection extends GitFacts {
  result:
    | { kind: 'missing' }
    | { kind: 'invalid'; issues: RuleIssue[]; content: unknown }
    | { kind: 'valid'; value: TaskResult };
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

/** One Harness Run of an Attempt's loop (developer or reviewer). */
interface RunInput {
  role: 'developer' | 'reviewer';
  template: { id: string; hash: string };
  /** 1, or 2 for the re-prompt. */
  run: number;
  prompt: string;
  wallClockMs: number;
  reprompt?: readonly RuleIssue[];
}

/**
 * The process an Attempt is waiting on, recorded on the Attempt
 * (`process_json`) before it starts and cleared once its end is recorded.
 * `run`: the Harness Run's number in its loop (2 for the re-prompt).
 * `startedAt`: ms since the epoch. `token`: the Harness's re-attach token.
 */
const AttemptProcessSchema = z.object({
  kind: z.enum(['harness', 'verification']),
  role: z.enum(['developer', 'reviewer']).optional(),
  run: z.number().int().optional(),
  spool: z.string(),
  startedAt: z.number(),
  wallClockMs: z.number(),
  executionId: z.string().optional(),
  token: z.string().optional(),
  pid: z.number().int().optional(),
});

/** An Attempt's `process_json`. */
export function parseProcess(json: string): AttemptProcess {
  return AttemptProcessSchema.parse(JSON.parse(json));
}

type Outcome = AttemptOutcome;

/** Where a pinned ref keeps each Attempt's head, so later Attempts can't lose its commits. */
export function attemptRef(attemptId: string): string {
  return `refs/factory/attempts/${attemptId}`;
}

export class TaskScheduler {
  private readonly loop = new PassLoop(() => this.pass(), POLL_MS);
  /** The work in flight, by Task id (an Attempt) or `closure:<Stage Run id>`. */
  private readonly slots = new Map<string, Slot>();
  /** Serializes the git setup of new Worktrees per Factory Clone (fetch, Dependency Base, `worktree add`). */
  private readonly cloneLocks = new Map<string, Promise<void>>();
  private closed = false;
  private readonly holder = `runtime:${String(process.pid)}`;
  private readonly wallClockMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly reviewWallClockMs: number;
  /** Work a previous runtime left in progress; carried on with before any new claim. */
  private readonly resumptions: Resumption[];
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly opts: TaskSchedulerOptions) {
    this.wallClockMs = opts.wallClockMs ?? DEFAULT_HARNESS_WALL_CLOCK_MS;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.reviewWallClockMs = opts.reviewWallClockMs ?? DEFAULT_REVIEW_WALL_CLOCK_MS;
    this.resumptions = [...(opts.recovered ?? [])];
  }

  /** The lease holder of this runtime: recovery hands the leases it takes over to it. */
  get leaseHolder(): string {
    return this.holder;
  }

  start(): void {
    if (this.opts.harness === undefined) return;
    // A closure left running resumes too (it never writes its report twice).
    for (const run of runningClosures(this.opts.db)) {
      this.resumptions.push({ kind: 'closure', stageRunId: run.id, jobId: run.jobId });
    }
    this.renewLeases();
    this.heartbeat = setInterval(() => {
      this.renewLeases();
    }, heartbeatIntervalMs());
    this.heartbeat.unref();
    this.loop.start();
  }

  wake(): void {
    if (this.closed || this.opts.harness === undefined) return;
    this.loop.wake();
  }

  /**
   * Stops scheduling and stops every process in flight (Harness Runs and
   * verification commands). Their Attempts are left as they are, for
   * recovery at the next start (ADR-0012). The leases stop being renewed.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.loop.halt();
    const slots = [...this.slots.values()];
    await Promise.all(slots.map((s) => Promise.all([s.run?.cancel(), s.proc?.cancel()])));
    await Promise.all(slots.map((s) => s.done));
    await this.loop.idle();
  }

  /**
   * Stops a cancelled Job's work in flight (#12): each process group gets
   * SIGTERM, then SIGKILL after the grace period; each Attempt and its Task
   * are then recorded `cancelled`, the Worktree preserved and the leases
   * released. Settles once all of that is recorded. The Job's own
   * cancellation is already committed.
   */
  async cancelJob(jobId: string): Promise<void> {
    for (const r of this.resumptions.filter((r) => this.jobOf(r) === jobId)) {
      this.resumptions.splice(this.resumptions.indexOf(r), 1);
      // A closure the cancellation already ended has nothing left to stop.
      if (r.kind !== 'closure') await this.cancelLeftAttempt(r.attemptId);
    }
    const slots = [...this.slots.values()].filter((s) => s.jobId === jobId);
    await Promise.all(slots.map((s) => Promise.all([s.run?.cancel(), s.proc?.cancel()])));
    await Promise.all(slots.map((s) => s.done));
  }

  /** The heartbeat tick: renews every lease this runtime holds, then sweeps expired ones (ADR-0024). */
  private renewLeases(): void {
    if (this.closed) return;
    heartbeatTick({
      db: this.opts.db,
      holder: this.holder,
      spoolRoot: this.opts.spoolRoot,
      inFlight: (taskId) => this.slots.get(taskId)?.done,
      closed: () => this.closed,
      onCommit: this.opts.onCommit,
      log: this.opts.log,
    });
  }

  private jobOf(r: Resumption): string | undefined {
    if (r.kind === 'closure') return r.jobId;
    const attempt = this.opts.db
      .select({ jobId: schema.tasks.jobId })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .where(eq(schema.attempts.id, r.attemptId))
      .get();
    return attempt?.jobId;
  }

  /**
   * Starts all the work that can start now, without waiting for it: what a
   * previous runtime left in progress, every queued closure, then every
   * ready Task the concurrency limits let it claim. `true` when it started some.
   */
  private pass(): Promise<boolean> {
    try {
      return Promise.resolve(this.startWork());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private startWork(): boolean {
    const harness = this.opts.harness;
    if (harness === undefined) return false;
    let started = false;
    for (let r = this.resumptions.shift(); r !== undefined; r = this.resumptions.shift()) {
      const resumption = r;
      const jobId = this.jobOf(resumption);
      if (jobId === undefined) continue;
      started = true;
      if (resumption.kind === 'closure') {
        this.launch(`closure:${resumption.stageRunId}`, jobId, () =>
          this.guard(jobId, () => runClosure(this.opts, resumption.stageRunId, jobId, 'running'), {
            closureId: resumption.stageRunId,
          }),
        );
        continue;
      }
      const { taskId } = requireAttempt(this.opts.db, resumption.attemptId);
      this.launch(taskId, jobId, (slot) =>
        this.guard(jobId, () => this.resumeAttempt(harness, resumption, slot), { taskId }),
      );
    }
    // A closure moves to `running` before its first await, so the next lookup finds the next one.
    for (
      let closure = nextClosure(this.opts.db);
      closure !== undefined && !this.slots.has(`closure:${closure.id}`);
      closure = nextClosure(this.opts.db)
    ) {
      const { id, jobId } = closure;
      started = true;
      this.launch(`closure:${id}`, jobId, () =>
        this.guard(jobId, () => runClosure(this.opts, id, jobId, 'queued'), { closureId: id }),
      );
    }
    for (;;) {
      const claimed = claimNextTask(this.opts.db, {
        holder: this.holder,
        globalLimit: this.opts.globalConcurrency,
        actor: ACTOR,
      });
      if (claimed === undefined) break;
      this.opts.onCommit();
      started = true;
      const { jobId, taskId } = claimed;
      this.launch(taskId, jobId, (slot) =>
        this.guard(jobId, () => this.runAttempt(harness, taskId, slot), { taskId }),
      );
    }
    return started;
  }

  /** Runs `body` in a new slot, without waiting for it; the slot goes once it ends. */
  private launch(key: string, jobId: string, body: (slot: Slot) => Promise<void>): void {
    const slot: Slot = { jobId, done: Promise.resolve(), run: undefined, proc: undefined };
    this.slots.set(key, slot);
    slot.done = body(slot).finally(() => {
      // A swept slot can end after a Retry of its Task took the key ("retry now", ADR-0026).
      if (this.slots.get(key) === slot) this.slots.delete(key);
      this.wake();
    });
  }

  /** Runs `body` while holding the clone's setup lock (one Worktree setup at a time per clone). */
  private async withClone<T>(clone: string, body: () => Promise<T>): Promise<T> {
    const before = this.cloneLocks.get(clone) ?? Promise.resolve();
    const run = before.then(body);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.cloneLocks.set(clone, settled);
    try {
      return await run;
    } finally {
      if (this.cloneLocks.get(clone) === settled) this.cloneLocks.delete(clone);
    }
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
        if (subject.closureId !== undefined)
          failClosure(this.opts, jobId, subject.closureId, message);
      } catch (failErr) {
        this.opts.log(`task scheduler: could not record the failure: ${String(failErr)}`);
      }
    }
  }

  /**
   * Why the Attempt's work must stop now: the runtime is shutting down (the
   * Attempt is left for recovery), or its Job was cancelled.
   */
  private stopReason(jobId: string): 'closed' | 'cancelled' | undefined {
    if (this.closed) return 'closed';
    const execution = this.opts.db
      .select({ state: schema.stageRuns.state })
      .from(schema.stageRuns)
      .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, 'execution')))
      .orderBy(desc(schema.stageRuns.attempt))
      .get();
    return execution?.state === 'cancelled' ? 'cancelled' : undefined;
  }

  /**
   * `true` when the Attempt must stop here. A cancelled Job's Attempt is
   * recorded `cancelled` first; on shutdown it is left as it is.
   */
  private async stopped(ctx: AttemptContext): Promise<boolean> {
    if (sweptAttempt(ctx.attemptId)) return true; // its lease expired: the sweeper ends it (ADR-0024)
    const reason = this.stopReason(ctx.job.id);
    if (reason === undefined) return false;
    if (reason === 'cancelled') await this.recordCancelled(ctx.attemptId);
    return true;
  }

  // ---- an Attempt ----------------------------------------------------------------

  private async runAttempt(harness: AgentHarness, taskId: string, slot: Slot): Promise<void> {
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

    // The Task's earlier Attempt, if any: this one is then Rework, in the same Worktree.
    const previous = db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, taskId))
      .orderBy(desc(schema.attempts.n))
      .get();
    const clone = repo.clonePath;
    const attemptId = newId('att');
    const n = (previous?.n ?? 0) + 1;
    // A Retry redoes an interrupted Attempt, and an answer Attempt goes on from one that
    // asked: both carry its packet's Findings, none of its own (it raised none).
    const cause: AttemptCause =
      previous === undefined
        ? 'initial'
        : previous.state === 'interrupted'
          ? 'retry'
          : previous.state === 'needs_decision'
            ? 'answer'
            : 'rework';
    const priorFindings =
      previous === undefined
        ? []
        : cause === 'retry' || cause === 'answer'
          ? TaskPacketSchema.parse(JSON.parse(previous.packetJson)).context.priorFindings
          : attemptFindings(db, previous);
    // Every question asked so far on this Task, with the human's answers (ADR-0023).
    const answers =
      previous === undefined ? [] : db.transaction((tx) => answersAfter(tx, previous));
    // Every grant's guidance so far on this Task (ADR-0026).
    const guidance =
      previous === undefined ? [] : db.transaction((tx) => guidanceAfter(tx, previous));
    const { wallClockMs } = this;
    let worktree: {
      id: string;
      path: string;
      branch: string;
      baseSha: string;
      reused: boolean;
      /** The Tasks whose approved heads the base holds (the Dependency Base). */
      dependencies?: string[];
    };
    if (previous === undefined) {
      // A new Worktree in the Factory Clone only: from its Dependency Base, or else
      // from the freshly fetched default branch. One setup per clone at a time.
      const base = await this.withClone(clone, async () => {
        await fetchRemote(clone);
        const dependencyBase = await makeDependencyBase(db, clone, task);
        if (dependencyBase.kind !== 'none') return dependencyBase;
        const sha =
          (await resolveCommit(clone, `refs/remotes/origin/${repo.defaultBranch}`)) ??
          (await resolveCommit(clone, `refs/heads/${repo.defaultBranch}`));
        if (sha === undefined)
          throw new Error(`the Factory Clone has no ${repo.defaultBranch} to start from`);
        return { sha, dependencies: [] };
      });
      if ('paths' in base) {
        // A human Blocker, never a replan (ADR-0028): no Attempt or Worktree is made.
        blockOnBaseConflict(db, { jobId: job.id, actor: ACTOR }, taskId, base);
        this.opts.onCommit();
        return;
      }
      const at = taskWorktree({
        workspaceRoot: this.opts.workspaceRoot,
        repositoryId: repo.id,
        jobId: job.id,
        taskId: task.id,
        taskKey: task.key,
      });
      worktree = {
        id: newId('wt'),
        ...at,
        baseSha: base.sha,
        reused: false,
        dependencies: base.dependencies,
      };
    } else {
      // Rework continues on the Task Branch, from the same base: the earlier work is kept.
      const row = requireWorktree(db, previous.worktreeId);
      if (row.state !== 'preserved')
        throw new Error(`the Worktree of Task ${task.key} is ${row.state}, not preserved`);
      worktree = {
        id: row.id,
        path: row.path,
        branch: row.branch,
        baseSha: row.baseSha,
        reused: true,
      };
    }
    const { path, branch, baseSha } = worktree;
    const worktreeId = worktree.id;
    // Built before the Worktree is touched, so nothing between that and its row can fail.
    const packet = this.packet({
      job,
      task,
      definition,
      repo,
      path,
      branch,
      baseSha,
      wallClockMs,
      priorFindings,
      answers,
      guidance,
    });
    await this.withClone(clone, async () => {
      await excludeResultFile(clone);
      if (worktree.reused) {
        // A Task Result left by the Attempt before must never be read as this one's.
        rmSync(join(path, dirname(RESULT_FILE)), { recursive: true, force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        await addWorktree({ repo: clone, path, branch, startSha: baseSha });
      }
    });

    const portBase = changeJob(
      db,
      { jobId: job.id, expectedVersion: 'current', actor: ACTOR },
      (tx) => {
        const base = allocatePortBlock(tx, {
          holder: `${this.holder}/${attemptId}`,
          expiresAt: leaseExpiry(),
        });
        const now = new Date().toISOString();
        if (worktree.reused) {
          tx.update(schema.worktrees)
            .set({ portBase: base })
            .where(eq(schema.worktrees.id, worktreeId))
            .run();
          stepWorktree(
            tx,
            { jobId: job.id, actor: ACTOR },
            requireWorktree(tx, worktreeId),
            'preserved',
            'active',
            { attemptId, portBase: base },
          );
        } else {
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
            payload: {
              taskId,
              to: 'active',
              path,
              branch,
              baseSha,
              portBase: base,
              // The Dependency Base: the Tasks whose approved heads `baseSha` holds (ADR-0021).
              dependencyBase: worktree.dependencies ?? [],
            },
          });
        }
        tx.insert(schema.attempts)
          .values({
            id: attemptId,
            taskId,
            n,
            cause,
            state: 'running',
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            tier: TIER,
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
            cause,
            harnessId: harness.id,
            harnessVersion: this.opts.harnessVersion,
            tier: TIER,
            template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
            worktreeId,
            baseSha,
            priorFindings: priorFindings.length,
            answers: answers.length,
            guidance: guidance.length,
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
    const ctx: AttemptContext = {
      harness,
      slot,
      job,
      task,
      definition,
      repo,
      attemptId,
      n,
      path,
      baseSha,
      worktreeId,
      env,
      packet,
    };
    if (await this.stopped(ctx)) return;
    await this.develop(ctx);
  }

  /**
   * Carries on with an Attempt a previous runtime left in progress, as
   * recovery decided (ADR-0012): re-attached to its Harness process, or
   * resumed at the factory's own step. Nothing that was stored is redone.
   */
  private async resumeAttempt(
    harness: AgentHarness,
    r: Extract<Resumption, { kind: 'reattach' | 'resume' }>,
    slot: Slot,
  ): Promise<void> {
    const ctx = this.contextOf(harness, r.attemptId, slot);
    const attempt = requireAttempt(this.opts.db, r.attemptId);
    if (await this.stopped(ctx)) return;
    const recorded = attempt.processJson === null ? undefined : parseProcess(attempt.processJson);
    if (r.kind === 'reattach' && recorded?.kind === 'harness') {
      const reattached = await this.reattachRun(harness, ctx, recorded);
      if (recorded.role === 'developer') {
        await this.develop(ctx, { run: recorded.run ?? 1, reattached });
      } else {
        await this.reviewStep(ctx, { run: recorded.run ?? 1, reattached });
      }
      return;
    }
    if (attempt.state === 'running') {
      await this.develop(ctx);
    } else if (attempt.state === 'verifying') {
      await this.verifyStep(ctx);
    } else {
      await this.reviewStep(ctx);
    }
  }

  /** The Attempt's context, rebuilt from its rows and its Task Packet. */
  private contextOf(harness: AgentHarness, attemptId: string, slot: Slot): AttemptContext {
    const { db } = this.opts;
    const attempt = requireAttempt(db, attemptId);
    const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, attempt.taskId)).get();
    if (task === undefined) throw new Error(`Attempt ${attemptId} has no Task`);
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, task.jobId)).get();
    const repo = db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, task.repositoryId))
      .get();
    if (job === undefined || repo === undefined)
      throw new Error(`Task ${task.id} has no Job or Repository`);
    const worktree = requireWorktree(db, attempt.worktreeId);
    const packet = TaskPacketSchema.parse(JSON.parse(attempt.packetJson));
    return {
      harness,
      slot,
      job,
      task,
      definition: TaskDefinitionSchema.parse(JSON.parse(task.definitionJson)),
      repo,
      attemptId,
      n: attempt.n,
      path: worktree.path,
      baseSha: attempt.baseSha,
      worktreeId: worktree.id,
      env: guardrailEnv(this.opts.runtimeEnv, {
        FACTORY_JOB_ID: job.id,
        FACTORY_TASK_ID: task.id,
        FACTORY_ATTEMPT_ID: attemptId,
        FACTORY_PORT_BASE: String(worktree.portBase),
        PORT: String(worktree.portBase),
        CI: 'true',
      }),
      packet,
    };
  }

  /**
   * The developer Harness Runs: one, plus one re-prompt (a new Session, same
   * Attempt) when it exits cleanly without a valid Task Result. The re-prompt
   * carries the violated rules. `from`: a re-attached Run to take as Run `run`.
   */
  private async develop(
    ctx: AttemptContext,
    from?: { run: number; reattached: HarnessRun | undefined },
  ): Promise<void> {
    const { path } = ctx;
    let result: HarnessRawResult | undefined;
    let rejected: RuleIssue[] | undefined;
    for (let run = from?.run ?? 1; run <= DEVELOPER_RUNS; run++) {
      /** What is wrong with this Harness Run's Task Result; `undefined` when it did not exit 0. */
      let issues: RuleIssue[] | undefined;
      const evaluate = (r: HarnessRawResult) => {
        if (!exitedCleanly(r)) return { outcome: 'harness_failed' };
        issues = taskResultIssues(readTaskResult(path));
        return issues.length === 0 ? { outcome: 'valid' } : { outcome: 'invalid', issues };
      };
      const input = {
        role: 'developer' as const,
        template: { id: TASK_TEMPLATE_ID, hash: TASK_TEMPLATE_HASH },
        run,
        prompt: renderTaskPrompt(ctx.packet, rejected),
        wallClockMs: this.wallClockMs,
        ...(rejected === undefined ? {} : { reprompt: rejected }),
      };
      ({ result } =
        run === from?.run
          ? await this.finishRun(ctx, input, from.reattached, evaluate)
          : await this.harnessRun(ctx, input, evaluate));
      if (await this.stopped(ctx)) return;
      if (issues === undefined || issues.length === 0) break;
      rejected = issues;
      // The re-prompted Harness Run writes its own Task Result; the rejected one is never read again.
      if (run < DEVELOPER_RUNS)
        rmSync(join(path, dirname(RESULT_FILE)), { recursive: true, force: true });
    }
    this.toVerifying(ctx, result);
    await this.verifyStep(ctx);
  }

  /**
   * The factory's own Gates on what the developer left: the WIP commit, the
   * path-scope Gate, every verification command. Then the Attempt ends, or
   * goes to review. Reads what it needs from the Attempt's row, so a resumed
   * verification starts here too.
   */
  private async verifyStep(ctx: AttemptContext): Promise<void> {
    const { path, baseSha, attemptId, definition, harness } = ctx;
    const attempt = requireAttempt(this.opts.db, attemptId);
    const developerExit: HarnessExit | null =
      attempt.developerExitJson === null
        ? null
        : HarnessExitSchema.parse(JSON.parse(attempt.developerExitJson));
    const usage =
      attempt.usageJson === null ? null : UsageSchema.parse(JSON.parse(attempt.usageJson));
    const cleanExit = developerExit?.kind === 'exited' && developerExit.code === 0;

    // Trust nothing the Harness said: read the Worktree and git.
    const inspection = await inspect(path, baseSha);
    // Every Attempt's head stays reachable, whatever a later Attempt does to the branch.
    await updateRef(ctx.repo.clonePath, attemptRef(attemptId), inspection.headSha);
    const scopeViolations = checkPathScope(
      await changedPathKinds(path, baseSha, inspection.headSha),
      definition.scope,
    );
    const self = { id: attemptId, n: ctx.n };
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
    if (!cleanExit) {
      outcome = {
        state: 'failed',
        exitReason: 'harness_failed',
        detail: `the ${harness.id} Harness Run ${developerExit === null ? 'did not start' : describeHarnessExit(developerExit)}`,
      };
    } else if (inspection.result.kind !== 'valid') {
      outcome = {
        state: 'failed',
        exitReason: 'invalid_output',
        detail: `the Task Result was invalid after ${String(DEVELOPER_RUNS - 1)} re-prompt: ${taskResultIssues(
          inspection.result,
        )
          .map((i) => `[${i.rule}] ${i.message}`)
          .join('; ')}`,
      };
    } else if (resultAsks(inspection.result.value)) {
      // A Question (ARCHITECTURE §8): no Gate runs on work that waits for an answer.
      this.askHuman(ctx, { inspection, resultContent, usage, result: inspection.result.value });
      return;
    } else if (inspection.result.value.status !== 'done') {
      outcome = {
        state: 'failed',
        exitReason: 'not_done',
        detail: `the Task Result's status is ${inspection.result.value.status}, not done or needs_decision`,
      };
    } else if (scopeViolations.length > 0) {
      // The path-scope Gate (ARCHITECTURE §7 step 3): nothing runs on out-of-scope work.
      outcome = {
        state: 'failed',
        exitReason: 'gates_failed',
        detail: scopeViolations.map((v) => `[${v.rule}] ${v.message}`).join('; '),
        findings: scopeViolations.map((v) => scopeFinding(self, v)),
      };
    } else {
      const verified = await this.verify(ctx);
      if (verified === undefined) return; // stopped during verification
      verificationRuns = verified;
      const at = { headSha: inspection.headSha, baseSha };
      const problems: [rule: string, problem: string][] = [
        ...verificationProblems(
          at,
          verificationRuns.map((r) => ({ ...r, ...at })),
        ).map((p) => ['verification', p] as [string, string]),
        ...(await worktreeProblems(path, inspection.headSha, 'verification')).map(
          (p) => ['worktree.clean', p] as [string, string],
        ),
        ...commandCriteriaFailures(
          verificationRuns,
          criteriaCoveredBy(this.opts.db, ctx.job.id, definition.acceptance),
        ).map((p) => ['criteria', p] as [string, string]),
      ];
      if (problems.length === 0) {
        // Every factory Gate passed: the independent review decides the rest.
        this.toReview({
          jobId: ctx.job.id,
          taskId: ctx.task.id,
          attemptId,
          baseSha,
          inspection,
          resultContent,
          verificationRuns,
          usage,
        });
        // The reviewer never sees the implementer's claims (they are stored as an Artifact).
        rmSync(join(path, dirname(RESULT_FILE)), { recursive: true, force: true });
        await this.reviewStep(ctx);
        return;
      }
      outcome = {
        state: 'failed',
        exitReason: 'gates_failed',
        detail: problems.map(([, p]) => p).join('; '),
        findings: problems.map(([rule, p]) => gateFinding(self, rule, p)),
      };
    }

    this.finish({
      jobId: ctx.job.id,
      taskId: ctx.task.id,
      attemptId,
      worktreeId: ctx.worktreeId,
      baseSha,
      inspection,
      resultContent,
      verificationRuns,
      outcome,
      usage,
    });
  }

  /**
   * The independent review of an Attempt in `in_review`, then its end. Reads
   * the reviewed head and the factory's verification from the database, so a
   * resumed review (the same head) starts here too. `from`: a re-attached
   * reviewer Run to take as Run `run`.
   */
  private async reviewStep(
    ctx: AttemptContext,
    from?: { run: number; reattached: HarnessRun | undefined },
  ): Promise<void> {
    const attempt = requireAttempt(this.opts.db, ctx.attemptId);
    if (attempt.headSha === null) throw new Error(`Attempt ${ctx.attemptId} has no reviewed head`);
    const facts: GitFacts = {
      headSha: attempt.headSha,
      commits: z.array(z.string()).parse(JSON.parse(attempt.commitsJson)),
      wipCommit: attempt.wipCommit,
      violations: z.array(RuleIssueSchema).parse(JSON.parse(attempt.protocolViolationsJson)),
    };
    const usage =
      attempt.usageJson === null ? null : UsageSchema.parse(JSON.parse(attempt.usageJson));
    const reviewed = await runReview(
      this.opts,
      {
        subject: {
          jobId: ctx.job.id,
          taskId: ctx.task.id,
          taskKey: ctx.task.key,
          attemptId: ctx.attemptId,
        },
        worktree: ctx.path,
        definition: ctx.definition,
        at: { headSha: facts.headSha, baseSha: ctx.baseSha },
        runs: recordedRuns(this.opts, ctx.attemptId, ctx.definition),
        harnessId: ctx.harness.id,
        wallClockMs: this.reviewWallClockMs,
        firstRun: from?.run ?? 1,
      },
      {
        run: (input, evaluate) =>
          input.run === from?.run
            ? this.finishRun(ctx, input, from.reattached, evaluate)
            : this.harnessRun(ctx, input, evaluate),
        stopped: () => this.stopped(ctx),
      },
    );
    if (reviewed === undefined) return; // stopped during the review
    finishReview(
      this.opts,
      {
        jobId: ctx.job.id,
        taskId: ctx.task.id,
        attemptId: ctx.attemptId,
        reviewedHead: facts.headSha,
        reviewed,
        current: {
          headSha: (await resolveCommit(ctx.path, 'HEAD')) ?? '(none)',
          baseSha: ctx.baseSha,
        },
        reviewerChanges: await worktreeProblems(ctx.path, facts.headSha, 'reviewer'),
      },
      (tx, state, step, outcome) => {
        endAttempt(tx, state, step, {
          jobId: ctx.job.id,
          taskId: ctx.task.id,
          attemptId: ctx.attemptId,
          worktreeId: ctx.worktreeId,
          baseSha: ctx.baseSha,
          inspection: facts,
          outcome,
          usage,
          from: 'in_review',
          artifacts: this.opts.artifacts,
        });
      },
    );
    this.dropSpools(ctx.attemptId);
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
    priorFindings: AttemptFinding[];
    answers: AnsweredQuestion[];
    guidance: GrantGuidance[];
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
        priorFindings: input.priorFindings,
        answers: input.answers,
        guidance: input.guidance,
      },
      limits: { maxTurns: MAX_TURNS, wallClockS: input.wallClockMs / 1000 },
      // The developer may ask (ARCHITECTURE §7 Question rules); the reviewer never can.
      protocol: { resultFile: RESULT_FILE, mayAskQuestions: true },
    } satisfies TaskPacket);
  }

  /** The spool directory of one process of an Attempt (ADR-0012). */
  private spoolOf(attemptId: string, label: string): string {
    return join(this.opts.spoolRoot, attemptId, label);
  }

  /** Records the process the Attempt waits on (or, with `undefined`, that it waits on none). */
  private recordProcess(
    tx: Tx | FactoryDb,
    attemptId: string,
    p: AttemptProcess | undefined,
  ): void {
    tx.update(schema.attempts)
      .set({ processJson: p === undefined ? null : JSON.stringify(p) })
      .where(eq(schema.attempts.id, attemptId))
      .run();
  }

  /**
   * One Harness Run of an Attempt, the developer's or a reviewer's, recorded
   * as `harness_run.started` / `.finished` events. Always `start`: a new
   * Session, never a resumed one. The process is recorded on the Attempt
   * before it starts, so a later runtime can find it. `evaluate` judges the
   * output for the record.
   */
  private async harnessRun(
    ctx: AttemptContext,
    input: RunInput,
    evaluate?: (result: HarnessRawResult) => { outcome: string; issues?: RuleIssue[] },
  ): Promise<{ result: HarnessRawResult | undefined; sessionRef: string | undefined }> {
    const { harness } = ctx;
    const spool = this.spoolOf(ctx.attemptId, `${input.role}-${String(input.run)}`);
    rmSync(spool, { recursive: true, force: true });
    const record: AttemptProcess = {
      kind: 'harness',
      role: input.role,
      run: input.run,
      spool,
      startedAt: Date.now(),
      wallClockMs: input.wallClockMs,
    };
    this.recordProcess(this.opts.db, ctx.attemptId, record);
    let started: HarnessRun;
    try {
      started = await harness.start({
        role: input.role,
        prompt: input.prompt,
        cwd: ctx.path,
        env: ctx.env,
        subject: { jobId: ctx.job.id, stageId: 'execution', taskKey: ctx.task.key },
        limits: { wallClockMs: input.wallClockMs, maxTurns: MAX_TURNS },
        policy: toolPolicyOf(ctx.job.configSnapshotJson, input.role),
        spool,
      });
    } catch (err) {
      this.opts.log(`task scheduler: the ${harness.id} Harness did not start: ${String(err)}`);
      this.recordProcess(this.opts.db, ctx.attemptId, undefined);
      return { result: undefined, sessionRef: undefined };
    }
    this.opts.db.transaction((tx) => {
      if (input.role === 'developer' && started.sessionRef !== undefined) {
        tx.update(schema.attempts)
          .set({ sessionRef: started.sessionRef })
          .where(eq(schema.attempts.id, ctx.attemptId))
          .run();
      }
      this.recordProcess(tx, ctx.attemptId, {
        ...record,
        executionId: started.executionId,
        ...(started.process === undefined
          ? {}
          : { pid: started.process.pid, token: started.process.token }),
      });
      appendEvent(tx, {
        entityKind: 'harness_run',
        entityId: started.executionId,
        jobId: ctx.job.id,
        type: 'harness_run.started',
        actor: ACTOR,
        payload: {
          attemptId: ctx.attemptId,
          taskId: ctx.task.id,
          stageId: 'execution',
          role: input.role,
          harnessId: harness.id,
          n: input.run,
          template: input.template,
          ...(started.sessionRef === undefined ? {} : { sessionRef: started.sessionRef }),
          ...(started.pid === undefined ? {} : { pid: started.pid }),
          ...(input.reprompt === undefined ? {} : { reprompt: { issues: input.reprompt } }),
        },
      });
    });
    this.opts.onCommit();
    return this.finishRun(ctx, input, started, evaluate);
  }

  /**
   * A Harness process a previous runtime started, re-attached: watched to its
   * end, never started again (ADR-0012). `undefined` when it can't be.
   */
  private async reattachRun(
    harness: AgentHarness,
    ctx: AttemptContext,
    recorded: AttemptProcess,
  ): Promise<HarnessRun | undefined> {
    if (harness.reattach === undefined || recorded.token === undefined) return undefined;
    const run = await harness.reattach({
      spool: recorded.spool,
      token: recorded.token,
      startedAt: recorded.startedAt,
      limits: { wallClockMs: recorded.wallClockMs },
    });
    this.event(
      ctx.job.id,
      'harness_run',
      recorded.executionId ?? ctx.attemptId,
      'harness_run.reattached',
      {
        attemptId: ctx.attemptId,
        taskId: ctx.task.id,
        role: recorded.role,
        n: recorded.run,
        ...(recorded.pid === undefined ? {} : { pid: recorded.pid }),
        attached: run !== undefined,
      },
    );
    return run;
  }

  /**
   * Waits for a started (or re-attached) Harness Run to end, then stores its
   * output as a `log` Artifact and records `harness_run.finished` with it. A
   * developer Run's usage is added to the Attempt's. The spool goes once that
   * is recorded.
   */
  private async finishRun(
    ctx: AttemptContext,
    input: RunInput,
    started: HarnessRun | undefined,
    evaluate?: (result: HarnessRawResult) => { outcome: string; issues?: RuleIssue[] },
  ): Promise<{ result: HarnessRawResult | undefined; sessionRef: string | undefined }> {
    const { harness } = ctx;
    const recorded = requireAttempt(this.opts.db, ctx.attemptId).processJson;
    const spool = recorded === null ? undefined : parseProcess(recorded).spool;
    if (started === undefined) {
      this.recordProcess(this.opts.db, ctx.attemptId, undefined);
      if (spool !== undefined) rmSync(spool, { recursive: true, force: true });
      return { result: undefined, sessionRef: undefined };
    }
    ctx.slot.run = started;
    // Progress events are counted; the Run's output is stored as its log (below).
    const drained = (async () => {
      let count = 0;
      for await (const event of started.events) if (event.kind !== 'usage') count++;
      return count;
    })();
    const result = await started.result;
    const events = await drained;
    ctx.slot.run = undefined;
    const judged = evaluate?.(result);
    // The Run's output, redacted on write like every Artifact (ADR-0011), for `factory logs`.
    const content = this.opts.artifacts.writeContent({
      source: 'harness',
      role: input.role,
      n: input.run,
      harnessId: harness.id,
      executionId: started.executionId,
      exit: result.exit,
      durationMs: result.durationMs,
      output: result.output,
    } satisfies HarnessLogContent);
    this.opts.db.transaction((tx) => {
      const log = this.opts.artifacts.record(
        tx,
        {
          jobId: ctx.job.id,
          taskId: ctx.task.id,
          attemptId: ctx.attemptId,
          kind: 'log',
          content,
        },
        ACTOR,
      );
      const attempt = requireAttempt(tx, ctx.attemptId);
      tx.update(schema.attempts)
        .set({
          processJson: null,
          ...(input.role === 'developer'
            ? {
                usageJson: JSON.stringify(
                  attempt.usageJson === null
                    ? usageOf(result)
                    : addUsage(UsageSchema.parse(JSON.parse(attempt.usageJson)), usageOf(result)),
                ),
              }
            : {}),
        })
        .where(eq(schema.attempts.id, ctx.attemptId))
        .run();
      appendEvent(tx, {
        entityKind: 'harness_run',
        entityId: started.executionId,
        jobId: ctx.job.id,
        type: 'harness_run.finished',
        actor: ACTOR,
        payload: {
          attemptId: ctx.attemptId,
          taskId: ctx.task.id,
          role: input.role,
          harnessId: harness.id,
          n: input.run,
          exit: result.exit,
          durationMs: result.durationMs,
          events,
          usage: result.usage,
          outputArtifactId: log.id,
          ...(judged === undefined ? {} : judged),
        },
      });
    });
    this.opts.onCommit();
    if (spool !== undefined) rmSync(spool, { recursive: true, force: true });
    return { result, sessionRef: started.sessionRef };
  }

  /** The developer is done: records how its last Run ended, and moves the Attempt and the Task to `verifying`. */
  private toVerifying(ctx: AttemptContext, result: HarnessRawResult | undefined): void {
    const jobId = ctx.job.id;
    changeJob(this.opts.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      stepAttempt(tx, { jobId, actor: ACTOR }, ctx.attemptId, 'running', {
        state: 'verifying',
        developerExitJson: result === undefined ? null : JSON.stringify(result.exit),
      });
      stepTask(tx, { jobId, actor: ACTOR }, requireTask(tx, ctx.task.id, 'running'), 'verifying', {
        payload: { attemptId: ctx.attemptId },
      });
    });
    this.opts.onCommit();
  }

  /**
   * Runs every verification command in the Worktree, in order, under the
   * guardrail, each recorded on the Attempt while it runs. `undefined` when
   * the work stopped (shutdown or cancellation).
   */
  private async verify(ctx: AttemptContext): Promise<VerificationRunRecord[] | undefined> {
    const records: VerificationRunRecord[] = [];
    for (const v of ctx.definition.verification) {
      if (await this.stopped(ctx)) return undefined;
      const startedAt = new Date().toISOString();
      const spool = this.spoolOf(ctx.attemptId, `verify-${v.key}`);
      rmSync(spool, { recursive: true, force: true });
      this.recordProcess(this.opts.db, ctx.attemptId, {
        kind: 'verification',
        spool,
        startedAt: Date.now(),
        wallClockMs: this.verifyTimeoutMs,
      });
      const proc = spawnGuarded({
        command: 'sh',
        args: ['-c', v.command],
        cwd: ctx.path,
        env: ctx.env,
        timeoutMs: this.verifyTimeoutMs,
        spool,
      });
      ctx.slot.proc = proc;
      const exit = await proc.exit;
      ctx.slot.proc = undefined;
      this.recordProcess(this.opts.db, ctx.attemptId, undefined);
      rmSync(spool, { recursive: true, force: true });
      if (await this.stopped(ctx)) return undefined;
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
          source: 'verification',
          key: v.key,
          command: v.command,
          exitCode,
          timedOut: exit.timedOut,
          truncated: exit.truncated,
          output: exit.output,
        } satisfies VerificationLogContent),
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
        endAttempt(tx, state, step, {
          ...input,
          from: 'verifying',
          artifacts: this.opts.artifacts,
        });
      },
    );
    this.opts.onCommit();
    this.dropSpools(input.attemptId);
  }

  /**
   * The developer asked a human (ARCHITECTURE §8 step 2), in one transaction:
   * the Task Result is recorded, the Attempt ends `needs_decision`, one
   * `question` Inbox Item batches its questions (or, at `max_questions`, a
   * `question_cap_reached` Blocker opens none), the Task is `blocked`, its
   * lease and capacity tokens are released and the Worktree is preserved. No
   * process stays alive while it waits.
   */
  private askHuman(
    ctx: AttemptContext,
    input: {
      inspection: Inspection;
      resultContent: StoredContent | undefined;
      usage: Usage | null;
      result: TaskResult;
    },
  ): void {
    const jobId = ctx.job.id;
    const taskId = ctx.task.id;
    const { attemptId } = ctx;
    const questions = inboxQuestionsOf(input.result);
    changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const op = { jobId, actor: ACTOR };
        const evidence = this.recordVerification(tx, {
          jobId,
          taskId,
          attemptId,
          baseSha: ctx.baseSha,
          inspection: input.inspection,
          resultContent: input.resultContent,
          verificationRuns: [],
        });
        const task = requireTask(tx, taskId, 'verifying');
        const answerAttemptsUsed = tx
          .select({ id: schema.attempts.id })
          .from(schema.attempts)
          .where(and(eq(schema.attempts.taskId, taskId), eq(schema.attempts.cause, 'answer')))
          .all().length;
        const route = questionRoute({ answerAttemptsUsed, maxQuestions: task.maxQuestions });
        const itemId =
          route.kind === 'ask'
            ? openQuestionItem(tx, {
                jobId,
                taskId,
                taskKey: task.key,
                attemptId,
                questions,
                evidence,
                requestedBy: `agent:${ctx.harness.id}/${attemptId}`,
                actor: ACTOR,
              })
            : undefined;
        stepAttempt(
          tx,
          op,
          attemptId,
          'verifying',
          {
            state: 'needs_decision',
            exitReason: 'needs_decision',
            exitDetail:
              itemId === undefined
                ? `the developer asked ${String(questions.length)} question(s) with no answer Attempt left (maxQuestions ${String(task.maxQuestions)})`
                : `the developer asked ${String(questions.length)} question(s); Inbox Item ${itemId} waits for the answers`,
            ...inspectionColumns(input.inspection, input.usage),
            processJson: null,
            finishedAt: new Date().toISOString(),
          },
          {
            exitReason: 'needs_decision',
            headSha: input.inspection.headSha,
            baseSha: ctx.baseSha,
            questions: questions.length,
            ...(itemId === undefined ? {} : { approvalId: itemId }),
          },
        );
        const blocker: Blocker = {
          ...(route.kind === 'ask'
            ? {
                kind: 'human' as const,
                reason: 'awaiting_human' as const,
                detail: `the developer asked ${String(questions.length)} question(s) and waits for the answers`,
                requiredAction: `answer Inbox Item ${String(itemId)} (factory inbox answer ${String(itemId)})`,
              }
            : route.blocker),
          taskId,
          attemptId,
          createdAt: new Date().toISOString(),
        };
        stepTask(tx, op, task, 'blocked', {
          reason: blocker.reason,
          payload: {
            attemptId,
            headSha: input.inspection.headSha,
            ...(itemId === undefined ? {} : { approvalId: itemId }),
          },
          blocker,
        });
        const worktree = requireWorktree(tx, ctx.worktreeId);
        releaseAttemptTokens(tx, taskId, worktree.portBase);
        stepWorktree(tx, op, worktree, 'active', 'preserved');
        settleExecution(tx, state, step);
      },
    );
    this.opts.onCommit();
    this.dropSpools(attemptId);
  }

  /** Removes an ended Attempt's spool directories (they hold raw process output). */
  private dropSpools(attemptId: string): void {
    rmSync(join(this.opts.spoolRoot, attemptId), { recursive: true, force: true });
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
   * Records a cancelled Job's Attempt as `cancelled` (#12), in one
   * transaction: the Attempt, its Task, the Worktree (`preserved`, never
   * removed) and the leases. Its process is already gone.
   */
  private async recordCancelled(attemptId: string): Promise<void> {
    const { db } = this.opts;
    const attempt = requireAttempt(db, attemptId);
    const worktree = requireWorktree(db, attempt.worktreeId);
    const head = existsSync(worktree.path) ? await resolveCommit(worktree.path, 'HEAD') : undefined;
    const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, attempt.taskId)).get();
    if (task === undefined) return;
    changeJob(
      db,
      { jobId: task.jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const row = requireAttempt(tx, attemptId);
        const from = AttemptStateSchema.parse(row.state);
        if (!['running', 'verifying', 'in_review'].includes(from)) return;
        const op = { jobId: task.jobId, actor: ACTOR };
        stepAttempt(
          tx,
          op,
          attemptId,
          from,
          {
            state: 'cancelled',
            exitReason: 'cancelled',
            exitDetail: 'the Job was cancelled; its processes were stopped',
            processJson: null,
            ...(head === undefined ? {} : { headSha: head }),
            finishedAt: new Date().toISOString(),
          },
          { exitReason: 'cancelled', ...(head === undefined ? {} : { headSha: head }) },
        );
        const current = tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get();
        if (
          current !== undefined &&
          ['claimed', 'running', 'verifying', 'in_review'].includes(current.state)
        ) {
          stepTask(tx, op, current, 'cancelled', {
            reason: 'job_cancelled',
            payload: { attemptId },
          });
        }
        const wt = requireWorktree(tx, row.worktreeId);
        if (wt.state === 'active') stepWorktree(tx, op, wt, 'active', 'preserved');
        releaseAttemptTokens(tx, task.id, wt.portBase);
        settleExecution(tx, state, step);
      },
    );
    this.opts.onCommit();
    this.dropSpools(attemptId);
  }

  /**
   * A cancelled Job's Attempt that recovery left to carry on with: its
   * process (if alive) is stopped, then it is recorded `cancelled`.
   */
  private async cancelLeftAttempt(attemptId: string): Promise<void> {
    const attempt = requireAttempt(this.opts.db, attemptId);
    if (attempt.processJson !== null) {
      const recorded = parseProcess(attempt.processJson);
      if (inspectSpool(recorded.spool).state === 'alive') {
        await attachGuarded({
          spool: recorded.spool,
          startedAt: recorded.startedAt,
          timeoutMs: recorded.wallClockMs,
        })?.cancel();
      }
    }
    await this.recordCancelled(attemptId);
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
  ): string[] {
    const { jobId, taskId, attemptId } = input;
    const head = input.inspection.headSha;
    const base = input.baseSha;
    const recorded: string[] = [];
    if (input.resultContent !== undefined) {
      recorded.push(
        this.opts.artifacts.record(
          tx,
          { jobId, taskId, attemptId, kind: 'task_result', content: input.resultContent },
          ACTOR,
        ).id,
      );
    }
    // The questions the Task Result asked, kept on the Attempt (redacted on write, ADR-0011).
    if (input.inspection.result.kind === 'valid') {
      tx.update(schema.attempts)
        .set({ questionsJson: JSON.stringify(inboxQuestionsOf(input.inspection.result.value)) })
        .where(eq(schema.attempts.id, attemptId))
        .run();
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
    return recorded;
  }

  /** Fails a Task the factory itself could not carry through (`factory_error`). */
  private failTask(jobId: string, taskId: string, message: string): void {
    const ended = changeJob(
      this.opts.db,
      { jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, state, step) => {
        const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
        if (task === undefined) return undefined;
        const attempt = tx
          .select()
          .from(schema.attempts)
          .where(
            and(
              eq(schema.attempts.taskId, taskId),
              inArray(schema.attempts.state, ['running', 'verifying', 'in_review']),
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
              processJson: null,
              finishedAt: new Date().toISOString(),
            },
            { exitReason: 'factory_error' },
          );
          const worktree = requireWorktree(tx, attempt.worktreeId);
          portBase = worktree.portBase;
          if (worktree.state === 'active')
            stepWorktree(tx, { jobId, actor: ACTOR }, worktree, 'active', 'preserved');
        }
        if (['claimed', 'running', 'verifying', 'in_review'].includes(task.state)) {
          stepTask(tx, { jobId, actor: ACTOR }, task, 'failed', {
            reason: 'factory_error',
            payload: { detail },
          });
        }
        releaseAttemptTokens(tx, taskId, portBase);
        settleExecution(tx, state, step);
        return attempt?.id;
      },
    );
    this.opts.onCommit();
    if (ended !== undefined) this.dropSpools(ended);
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
  const wipCommit = (await commitLeftovers(worktree))?.sha ?? null;
  const headSha = await resolveCommit(worktree, 'HEAD');
  if (headSha === undefined) throw new Error(`the Worktree ${worktree} has no HEAD`);
  const commits = (await commitsBetween(worktree, baseSha, headSha)).map((c) => c.sha);

  const result = readTaskResult(worktree);
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

/** The Task Result the Harness left in the Worktree, parsed and schema-checked. */
function readTaskResult(worktree: string): Inspection['result'] {
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
      // A result that contradicts the question protocol is invalid too (one re-prompt, ADR-0023).
      const protocol = parsed.success ? questionProtocolIssues(parsed.data) : [];
      result = !parsed.success
        ? { kind: 'invalid', content: json, issues: schemaIssues(parsed.error) }
        : protocol.length > 0
          ? { kind: 'invalid', content: json, issues: protocol }
          : { kind: 'valid', value: parsed.data };
    }
  }
  return result;
}

/** Why a Task Result is not valid, each problem naming its rule; empty when it is valid. */
function taskResultIssues(result: Inspection['result']): RuleIssue[] {
  if (result.kind === 'missing')
    return [{ rule: 'result.missing', message: `no Task Result at ${RESULT_FILE}` }];
  return result.kind === 'invalid' ? result.issues : [];
}

/** The Harness Run exited by itself with code 0. That proves nothing about its work. */
function exitedCleanly(
  result: HarnessRawResult | undefined,
): result is HarnessRawResult & { exit: { kind: 'exited'; code: 0 } } {
  return result !== undefined && result.exit.kind === 'exited' && result.exit.code === 0;
}

function usageOf(result: HarnessRawResult | undefined): Usage {
  return result === undefined
    ? { tag: 'unknown', inputTokens: null, outputTokens: null, costUsd: null, durationMs: 0 }
    : { ...result.usage, durationMs: Math.round(result.durationMs) };
}

/** What the factory read from git about an Attempt, as Attempt columns. */
function inspectionColumns(inspection: GitFacts, usage: Usage | null) {
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

/**
 * Ends the Attempt with `outcome`, releases its leases, preserves the Worktree,
 * and moves the Task: `approved`; or, after a failure, where Rework routing
 * sends it (ARCHITECTURE §4.6): back to `ready` for a Rework Attempt (through
 * `changes_requested`), `blocked` with a Blocker (the cap is reached, or a
 * blocking Finding blames the Specification or the infrastructure),
 * `cancelled` with its dependents and a Replan asked for (a blocking Finding
 * blames the Plan, ADR-0030), or `failed`. Then settles `execution`.
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
    inspection: GitFacts;
    outcome: Outcome;
    usage: Usage | null;
    from: 'verifying' | 'in_review';
    artifacts: ArtifactStore;
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
      gateFindingsJson: JSON.stringify(outcome.findings ?? []),
      processJson: null,
      finishedAt: new Date().toISOString(),
    },
    {
      exitReason: outcome.exitReason,
      headSha: inspection.headSha,
      baseSha: input.baseSha,
      wipCommit: inspection.wipCommit,
      findings: outcome.findings?.length ?? 0,
    },
  );
  let replanned = false;
  const task = requireTask(tx, taskId, input.from);
  const payload = { attemptId, headSha: inspection.headSha };
  const reason = outcome.exitReason;
  if (outcome.state === 'passed') {
    stepTask(tx, op, task, 'approved', { reason, payload });
    readyDependents(tx, op, taskId);
  } else {
    const attempt = requireAttempt(tx, attemptId);
    const route = routeFailedAttempt({
      exitReason: outcome.exitReason,
      findings: attemptFindings(tx, attempt),
      // A Retry redoes an interrupted Attempt: it never counts toward the Rework cap.
      n: attemptsCountedForRework(
        tx
          .select({ cause: schema.attempts.cause })
          .from(schema.attempts)
          .where(eq(schema.attempts.taskId, taskId))
          .all()
          .map((a) => ({ cause: AttemptCauseSchema.parse(a.cause) })),
      ),
      maxAttempts: task.maxAttempts,
    });
    if (route.kind === 'fail') {
      stepTask(tx, op, task, 'failed', { reason, payload });
    } else if (route.kind === 'replan') {
      routeToPlanning(
        tx,
        input.artifacts,
        op,
        {
          task,
          attemptId,
          attemptN: attempt.n,
          headSha: inspection.headSha,
          findings: attemptFindings(tx, attempt),
        },
        step,
      );
      replanned = true;
    } else if (route.kind === 'rework') {
      const back = stepTask(tx, op, task, 'changes_requested', { reason, payload });
      stepTask(tx, op, back, 'ready', {
        reason: 'rework',
        payload: { ...payload, nextAttempt: attempt.n + 1, maxAttempts: task.maxAttempts },
      });
    } else {
      const blocker: Blocker = {
        ...route.blocker,
        taskId,
        attemptId,
        createdAt: new Date().toISOString(),
      };
      // The cap is a Gate's or review's verdict that routes back here, with nowhere to go.
      const from =
        blocker.reason === 'rework_cap_reached'
          ? stepTask(tx, op, task, 'changes_requested', { reason, payload })
          : task;
      stepTask(tx, op, from, 'blocked', { reason: blocker.reason, payload, blocker });
    }
  }
  const worktree = requireWorktree(tx, input.worktreeId);
  releaseAttemptTokens(tx, taskId, worktree.portBase);
  stepWorktree(tx, op, worktree, 'active', 'preserved');
  // The Replan may have superseded `execution` already: settle on what is stored now.
  settleExecution(tx, replanned ? readJobState(tx, jobId) : state, step);
}

/**
 * Moves each `pending` Task that depends on the just-approved `taskId` to
 * `ready` once every Task it depends on is approved (ARCHITECTURE §4.4). In
 * the transaction that approves `taskId`, so a dependent is never claimed
 * before its last dependency's `approved` event.
 */
function readyDependents(tx: Tx, op: { jobId: string; actor: string }, taskId: string): void {
  const dependents = tx
    .select({ task: schema.tasks })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(
      and(eq(schema.taskDependencies.dependsOnTaskId, taskId), eq(schema.tasks.state, 'pending')),
    )
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
  for (const { task } of dependents) {
    const deps = tx
      .select({ key: schema.tasks.key, state: schema.tasks.state })
      .from(schema.taskDependencies)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.dependsOnTaskId))
      .where(eq(schema.taskDependencies.taskId, task.id))
      .all();
    if (!deps.every((d) => d.state === 'approved' || d.state === 'integrated')) continue;
    stepTask(tx, op, task, 'ready', {
      reason: 'dependencies_approved',
      payload: { dependsOn: deps.map((d) => d.key) },
    });
  }
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

function requireAttempt(db: FactoryDb | Tx, id: string) {
  const attempt = db.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (attempt === undefined) throw new Error(`no Attempt ${id}`);
  return attempt;
}

// Ending `execution` lives with the keep-going rules (ADR-0028).
export { settleExecution } from './keep-going.js';
