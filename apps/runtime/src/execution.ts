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
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AttemptCauseSchema,
  AttemptStateSchema,
  BlockerSchema,
  checkPathScope,
  criterionVerdict,
  addUsage,
  attemptsCountedForRework,
  HarnessExitSchema,
  UsageSchema,
  VerificationLogContentSchema,
  type HarnessExit,
  routeFailedAttempt,
  type AttemptCause,
  type AttemptFinding,
  type Blocker,
  decideApproval,
  evidenceSource,
  type GateRef,
  type HarnessLogContent,
  type VerificationLogContent,
  EvidenceVerdictSchema,
  isBlocking,
  isCurrent,
  verificationProblems,
  type ApprovalInput,
  type ReviewPacket,
  type ReviewProposal,
  RESULT_FILE,
  RuleIssueSchema,
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
  toolPolicyOf,
  type SecurityTier,
} from '@factory/domain';
import {
  addWorktree,
  changedPathKinds,
  changedPaths,
  commitAll,
  commitsBetween,
  fetchRemote,
  removeWorktree,
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
import { criteriaCoveredBy } from './criteria.js';
import { buildDeliveryReport } from './delivery.js';
import { attemptFindings, gateFinding, scopeFinding } from './findings.js';
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
/** Developer Harness Runs per Attempt: the first, plus one re-prompt for an invalid Task Result. */
const DEVELOPER_RUNS = 2;
/** Reviewer Harness Runs per review: the first, plus one re-prompt. */
const REVIEW_RUNS = 2;
/** How often the runtime renews the leases it holds (ARCHITECTURE §12 step 4). */
/** The security tier every Harness Run runs under in Phase A: Tier 0, the local guardrail. */
const TIER: SecurityTier = 'local';

export const LEASE_HEARTBEAT_MS = 15_000;
/** A lease expires this long after its last heartbeat. */
export const LEASE_TTL_MS = 90_000;

/** When a lease renewed now expires. */
export function leaseExpiry(now = Date.now()): string {
  return new Date(now + LEASE_TTL_MS).toISOString();
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

/** Where the test-only fault injection (`FACTORY_TEST_CRASH_AT`) can kill the runtime. */
export const CRASH_POINTS = ['closure.after_report'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** An Attempt (or a closure) a previous runtime left in progress, to carry on with. */
export type Resumption =
  | { kind: 'reattach'; attemptId: string }
  | { kind: 'resume'; from: 'verification' | 'review'; attemptId: string }
  | { kind: 'closure'; stageRunId: string; jobId: string };

/** See {@link AttemptProcessSchema}. */
export type AttemptProcess = z.infer<typeof AttemptProcessSchema>;

/** Everything an Attempt's steps need, rebuilt from the database when it is resumed. */
interface AttemptContext {
  harness: AgentHarness;
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

/** A verification run as recorded, without its stored content. */
type RecordedRun = Omit<VerificationRunRecord, 'content'>;

interface Outcome {
  state: Extract<AttemptState, 'passed' | 'failed'>;
  exitReason: AttemptExitReason;
  detail: string;
  /** What the factory's Gates found (the review's Findings are recorded with the review). */
  findings?: AttemptFinding[];
}

/** Where a pinned ref keeps each Attempt's head, so later Attempts can't lose its commits. */
export function attemptRef(attemptId: string): string {
  return `refs/factory/attempts/${attemptId}`;
}

export class TaskScheduler {
  private readonly loop = new PassLoop(() => this.pass(), POLL_MS);
  private currentRun: HarnessRun | undefined;
  private currentProc: GuardedProcess | undefined;
  /** The Job whose work the slot holds, and when that work ends. */
  private inflight: { jobId: string; done: Promise<void> } | undefined;
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
    for (const run of this.opts.db
      .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
      .from(schema.stageRuns)
      .where(and(eq(schema.stageRuns.stageId, 'closure'), eq(schema.stageRuns.state, 'running')))
      .all()) {
      this.resumptions.push({ kind: 'closure', stageRunId: run.id, jobId: run.jobId });
    }
    this.renewLeases();
    this.heartbeat = setInterval(() => {
      this.renewLeases();
    }, LEASE_HEARTBEAT_MS);
    this.heartbeat.unref();
    this.loop.start();
  }

  wake(): void {
    if (this.closed || this.opts.harness === undefined) return;
    this.loop.wake();
  }

  /**
   * Stops scheduling and stops the process in flight (Harness Run or
   * verification command). Its Attempt is left as it is, for recovery at the
   * next start (ADR-0012). The leases stop being renewed.
   */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.loop.halt();
    await Promise.all([this.currentRun?.cancel(), this.currentProc?.cancel()]);
    await this.loop.idle();
  }

  /**
   * Stops a cancelled Job's work in flight (#12): its process group gets
   * SIGTERM, then SIGKILL after the grace period; the Attempt and the Task are
   * then recorded `cancelled`, the Worktree preserved and the leases released.
   * Settles once that is recorded. The Job's own cancellation is already committed.
   */
  async cancelJob(jobId: string): Promise<void> {
    for (const r of this.resumptions.filter((r) => this.jobOf(r) === jobId)) {
      this.resumptions.splice(this.resumptions.indexOf(r), 1);
      // A closure the cancellation already ended has nothing left to stop.
      if (r.kind !== 'closure') await this.cancelLeftAttempt(r.attemptId);
    }
    const inflight = this.inflight;
    if (inflight?.jobId !== jobId) return;
    await Promise.all([this.currentRun?.cancel(), this.currentProc?.cancel()]);
    await inflight.done;
  }

  /** Renews every lease this runtime holds (ARCHITECTURE §12 step 4). */
  private renewLeases(): void {
    if (this.closed) return;
    const now = Date.now();
    this.opts.db
      .update(schema.leases)
      .set({ heartbeatAt: new Date(now).toISOString(), expiresAt: leaseExpiry(now) })
      .where(
        sql`${schema.leases.holder} = ${this.holder} OR ${schema.leases.holder} LIKE ${`${this.holder}/%`}`,
      )
      .run();
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

  /** Runs at most one closure or one Attempt. `true` when it did some work. */
  private async pass(): Promise<boolean> {
    const harness = this.opts.harness;
    if (harness === undefined) return false;
    const resumption = this.resumptions.shift();
    if (resumption !== undefined) {
      const jobId = this.jobOf(resumption);
      if (jobId === undefined) return true;
      if (resumption.kind === 'closure') {
        await this.hold(jobId, () =>
          this.guard(jobId, () => this.runClosure(resumption.stageRunId, jobId, 'running'), {
            closureId: resumption.stageRunId,
          }),
        );
        return true;
      }
      const attempt = requireAttempt(this.opts.db, resumption.attemptId);
      await this.hold(jobId, () =>
        this.guard(jobId, () => this.resumeAttempt(harness, resumption), {
          taskId: attempt.taskId,
        }),
      );
      return true;
    }
    const closure = this.nextClosure();
    if (closure !== undefined) {
      await this.hold(closure.jobId, () =>
        this.guard(closure.jobId, () => this.runClosure(closure.id, closure.jobId, 'queued'), {
          closureId: closure.id,
        }),
      );
      return true;
    }
    const claimed = this.claimNext();
    if (claimed === undefined) return false;
    await this.hold(claimed.jobId, () =>
      this.guard(claimed.jobId, () => this.runAttempt(harness, claimed.taskId), {
        taskId: claimed.taskId,
      }),
    );
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

  /** Marks the slot as holding `jobId`'s work while `body` runs (for {@link cancelJob}). */
  private async hold(jobId: string, body: () => Promise<void>): Promise<void> {
    const done = body();
    this.inflight = { jobId, done };
    try {
      await done;
    } finally {
      this.inflight = undefined;
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
      .get();
    return execution?.state === 'cancelled' ? 'cancelled' : undefined;
  }

  /**
   * `true` when the Attempt must stop here. A cancelled Job's Attempt is
   * recorded `cancelled` first; on shutdown it is left as it is.
   */
  private async stopped(ctx: AttemptContext): Promise<boolean> {
    const reason = this.stopReason(ctx.job.id);
    if (reason === undefined) return false;
    if (reason === 'cancelled') await this.recordCancelled(ctx.attemptId);
    return true;
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
            expiresAt: leaseExpiry(),
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
    // A Retry redoes an interrupted Attempt: its packet's Findings, none of its own.
    const cause: AttemptCause =
      previous === undefined ? 'initial' : previous.state === 'interrupted' ? 'retry' : 'rework';
    const priorFindings =
      previous === undefined
        ? []
        : cause === 'retry'
          ? TaskPacketSchema.parse(JSON.parse(previous.packetJson)).context.priorFindings
          : attemptFindings(db, previous);
    const { wallClockMs } = this;
    let worktree: { id: string; path: string; branch: string; baseSha: string; reused: boolean };
    if (previous === undefined) {
      // A new Worktree, from a freshly fetched base, in the Factory Clone only.
      await fetchRemote(clone);
      const baseSha =
        (await resolveCommit(clone, `refs/remotes/origin/${repo.defaultBranch}`)) ??
        (await resolveCommit(clone, `refs/heads/${repo.defaultBranch}`));
      if (baseSha === undefined)
        throw new Error(`the Factory Clone has no ${repo.defaultBranch} to start from`);
      const at = taskWorktree({
        workspaceRoot: this.opts.workspaceRoot,
        repositoryId: repo.id,
        jobId: job.id,
        taskId: task.id,
        taskKey: task.key,
      });
      worktree = { id: newId('wt'), ...at, baseSha, reused: false };
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
    });
    await excludeResultFile(clone);
    if (worktree.reused) {
      // A Task Result left by the Attempt before must never be read as this one's.
      rmSync(join(path, dirname(RESULT_FILE)), { recursive: true, force: true });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      await addWorktree({ repo: clone, path, branch, startSha: baseSha });
    }

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
            payload: { taskId, to: 'active', path, branch, baseSha, portBase: base },
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
  ): Promise<void> {
    const ctx = this.contextOf(harness, r.attemptId);
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
  private contextOf(harness: AgentHarness, attemptId: string): AttemptContext {
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
    } else if (inspection.result.value.status !== 'done') {
      outcome = {
        state: 'failed',
        exitReason: 'not_done',
        detail: `the Task Result's status is ${inspection.result.value.status}; only done is handled before Phase B`,
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
    const at = { headSha: facts.headSha, baseSha: ctx.baseSha };
    const reviewed = await this.review(ctx, at, this.recordedRuns(ctx), from);
    if (reviewed === undefined) return; // stopped during the review
    this.finishReview({
      jobId: ctx.job.id,
      taskId: ctx.task.id,
      attemptId: ctx.attemptId,
      worktreeId: ctx.worktreeId,
      inspection: facts,
      usage,
      reviewed,
      current: {
        headSha: (await resolveCommit(ctx.path, 'HEAD')) ?? '(none)',
        baseSha: ctx.baseSha,
      },
      reviewerChanges: await worktreeProblems(ctx.path, facts.headSha, 'reviewer'),
    });
  }

  /** The Attempt's recorded verification runs, with their output, as the review is sent them. */
  private recordedRuns(ctx: AttemptContext): RecordedRun[] {
    return this.opts.db
      .select()
      .from(schema.verificationRuns)
      .where(eq(schema.verificationRuns.attemptId, ctx.attemptId))
      .orderBy(asc(sql`rowid`))
      .all()
      .map((r) => {
        const log = VerificationLogContentSchema.parse(
          this.opts.artifacts.readJson(r.outputArtifactId),
        );
        return {
          key: r.commandKey,
          command: r.command,
          required: r.required,
          criteria: ctx.definition.verification.find((v) => v.key === r.commandKey)?.criteria ?? [],
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          output: log.output,
        };
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
    priorFindings: AttemptFinding[];
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
      },
      limits: { maxTurns: MAX_TURNS, wallClockS: input.wallClockMs / 1000 },
      protocol: { resultFile: RESULT_FILE, mayAskQuestions: false },
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
    this.currentRun = started;
    // Progress events are counted; the Run's output is stored as its log (below).
    const drained = (async () => {
      let count = 0;
      for await (const event of started.events) if (event.kind !== 'usage') count++;
      return count;
    })();
    const result = await started.result;
    const events = await drained;
    this.currentRun = undefined;
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
      this.currentProc = proc;
      const exit = await proc.exit;
      this.currentProc = undefined;
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
        endAttempt(tx, state, step, { ...input, from: 'verifying' });
      },
    );
    this.opts.onCommit();
    this.dropSpools(input.attemptId);
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
   * The independent review: a reviewer Harness Run in a new Session, in the
   * Worktree at the reviewed head, given the Review Packet only. Its output
   * is checked like any proposal; one re-prompt (again a new Session) carries
   * the problems. `undefined` when the work stopped.
   */
  private async review(
    ctx: AttemptContext,
    at: GateRef,
    runs: readonly RecordedRun[],
    from?: { run: number; reattached: HarnessRun | undefined },
  ): Promise<Reviewed | undefined> {
    const { db } = this.opts;
    const { job, task, definition, attemptId, harness } = ctx;
    const spec = this.opts.artifacts
      .listForJob(job.id)
      .find((a) => a.kind === 'spec' && a.stageRunId !== null);
    if (spec === undefined) throw new Error(`Job ${job.id} has no Specification to review against`);
    const criteria = criteriaCoveredBy(db, job.id, definition.acceptance);
    const packet = await buildReviewPacket({
      subject: { jobId: job.id, taskId: task.id, taskKey: task.key, attemptId, ...at },
      repo: ctx.path,
      specification: SpecificationProposalSchema.parse(this.opts.artifacts.readJson(spec.id)),
      criteria,
      runs,
      commandVerdicts: criteria.map((c) => ({
        code: c.code,
        ...criterionVerdict(runs.filter((r) => r.criteria.includes(c.code))),
      })),
    });
    let rejected: RuleIssue[] | undefined;
    for (let n = from?.run ?? 1; n <= REVIEW_RUNS; n++) {
      let evaluation: ReviewEvaluation | undefined;
      const evaluate = (r: HarnessRawResult) => {
        evaluation = evaluateReview(r, packet);
        return evaluation.kind === 'invalid'
          ? { outcome: 'invalid', issues: evaluation.issues }
          : { outcome: evaluation.kind };
      };
      const input: RunInput = {
        role: 'reviewer',
        template: { id: REVIEW_TEMPLATE_ID, hash: REVIEW_TEMPLATE_HASH },
        run: n,
        prompt: renderReviewPrompt(packet, rejected),
        wallClockMs: this.reviewWallClockMs,
        ...(rejected === undefined ? {} : { reprompt: rejected }),
      };
      const { result, sessionRef } =
        n === from?.run
          ? await this.finishRun(ctx, input, from.reattached, evaluate)
          : await this.harnessRun(ctx, input, evaluate);
      if (await this.stopped(ctx)) return undefined;
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
    inspection: GitFacts;
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
          const changesRequested =
            review?.outcome === 'changes_requested' && isCurrent(review, input.current);
          const self = { id: attemptId, n: requireAttempt(tx, attemptId).n };
          outcome =
            problems.length === 0
              ? {
                  state: 'passed',
                  exitReason: 'completed',
                  detail: 'every Gate passed and the review approved',
                }
              : {
                  state: 'failed',
                  exitReason: changesRequested ? 'changes_requested' : 'gates_failed',
                  detail: problems.join('; '),
                  // A review that requested changes brings its own Findings; the rest are the Gates'.
                  findings: [
                    ...(changesRequested
                      ? []
                      : decision.problems.map((p) => gateFinding(self, 'approval', p))),
                    ...input.reviewerChanges.map((p) => gateFinding(self, 'worktree.clean', p)),
                  ],
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
    this.dropSpools(attemptId);
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
  private async runClosure(
    stageRunId: string,
    jobId: string,
    from: 'queued' | 'running',
  ): Promise<void> {
    const { db } = this.opts;
    if (from === 'queued') {
      changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
        step(requireStageRun(state, stageRunId, 'queued'), 'running');
      });
      this.opts.onCommit();
    }

    // A closure that stopped after recording its report resumes from that report:
    // it is never written twice.
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
      if (this.opts.crashAt === 'closure.after_report') process.kill(process.pid, 'SIGKILL');
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
      result = parsed.success
        ? { kind: 'valid', value: parsed.data }
        : { kind: 'invalid', content: json, issues: schemaIssues(parsed.error) };
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
 * Ends the Attempt with `outcome`, releases its leases, preserves the Worktree,
 * and moves the Task: `approved`; or, after a failure, where Rework routing
 * sends it (ARCHITECTURE §4.6): back to `ready` for a Rework Attempt (through
 * `changes_requested`), `blocked` with a Blocker (the cap is reached, or a
 * blocking Finding blames the Plan, the Specification or the infrastructure),
 * or `failed`. Then settles `execution`.
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
  const task = requireTask(tx, taskId, input.from);
  const payload = { attemptId, headSha: inspection.headSha };
  const reason = outcome.exitReason;
  if (outcome.state === 'passed') {
    stepTask(tx, op, task, 'approved', { reason, payload });
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

function requireAttempt(db: FactoryDb | Tx, id: string) {
  const attempt = db.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (attempt === undefined) throw new Error(`no Attempt ${id}`);
  return attempt;
}

function requireStageRun(state: JobState, id: string, expected: string) {
  const run = state.stageRuns.find((r) => r.id === id);
  if (run?.state !== expected)
    throw new Error(`Stage Run ${id} is ${String(run?.state)}, not ${expected}`);
  return run;
}

/** Task states in which the Task is still being worked on, or is about to be. */
const IN_PROGRESS = ['ready', 'claimed', 'running', 'verifying', 'in_review', 'changes_requested'];

/**
 * Ends `execution` once no Task is in progress: `failed` if a Task failed
 * (with no Rework route); `waiting_human` or `blocked` if a Task is blocked
 * (the Stage Run carries the first Blocker, human ones first, so the Job
 * shows why); `succeeded` (and `closure` queued) when every Task is approved.
 */
export function settleExecution(tx: Tx, state: JobState, step: StageRunStepper): void {
  const execution = state.stageRuns.find((r) => r.stageId === 'execution');
  if (execution?.state !== 'running') return;
  const tasks = tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, state.job.id))
    .orderBy(asc(sql`rowid`))
    .all();
  const failed = tasks.find((t) => t.state === 'failed');
  if (failed !== undefined) {
    step(execution, 'failed', {
      failure: {
        reason: 'task_failed',
        message: `Task ${failed.key} failed, with no Rework route`,
        issues: [],
      },
    });
    return;
  }
  if (tasks.some((t) => IN_PROGRESS.includes(t.state))) return;
  const blockers = tasks
    .filter((t) => t.state === 'blocked' && t.blockerJson !== null)
    .map((t) => BlockerSchema.parse(JSON.parse(t.blockerJson ?? 'null')));
  const blocker = blockers.find((b) => b.kind === 'human') ?? blockers[0];
  if (blocker !== undefined) {
    step(execution, blocker.kind === 'human' ? 'waiting_human' : 'blocked', { blocker });
    return;
  }
  if (tasks.length > 0 && tasks.every((t) => t.state === 'approved')) {
    step(execution, 'succeeded');
    const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
    if (closure !== undefined) step(closure, 'queued');
  }
}
