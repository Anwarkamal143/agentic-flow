/**
 * Crash recovery on startup (ARCHITECTURE §12, ADR-0012). Runs before the
 * schedulers start and before the API listens. For each Task a previous
 * runtime left in progress it reads the facts (the Attempt's recorded process,
 * checked by pid plus start time; the Worktree's git status; the Retries
 * used), lets `decideRecovery` decide, and records the decision. Nothing that
 * was stored is regenerated, and no process is started here: an Attempt to
 * carry on with is handed to the Task scheduler.
 *
 * The factory never starts a second process beside one that could still be
 * alive: a live developer or reviewer process is re-attached, a live
 * verification command (the factory's own) is stopped before verification
 * runs again, and a dead process's group is killed before a Retry.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { schema, type FactoryDb } from '@factory/db';
import {
  AttemptStateSchema,
  decideRecovery,
  type Blocker,
  type RecoveredProcess,
  type RecoveredWorktree,
} from '@factory/domain';
import { resolveCommit, uncommittedPaths } from '@factory/git';
import { attachGuarded, inspectSpool } from '@factory/harness';
import { and, eq, inArray } from 'drizzle-orm';
import { takeOverClaim } from './claim.js';
import { changeJob, stepAttempt, stepTask, stepWorktree } from './engine.js';
import { leaseExpiry, parseProcess, settleExecution, type Resumption } from './execution.js';
import { releaseAttemptTokens, requireWorktree } from './worktree.js';

const ACTOR = 'system:recovery';
const IN_PROGRESS = ['running', 'verifying', 'in_review'];

export interface RecoveryOptions {
  db: FactoryDb;
  /** The new runtime's lease holder; it takes over the leases of what it carries on with. */
  holder: string;
  spoolRoot: string;
  onCommit: () => void;
  log: (message: string) => void;
}

/** Recovers every Task left in progress. Returns the Attempts to carry on with, in order. */
export async function recoverTasks(opts: RecoveryOptions): Promise<Resumption[]> {
  const { db } = opts;
  const resumptions: Resumption[] = [];
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(inArray(schema.tasks.state, ['claimed', 'running', 'verifying', 'in_review']))
    .all();
  for (const task of tasks) {
    const attempt = db
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, task.id), inArray(schema.attempts.state, IN_PROGRESS)))
      .get();
    const cancelled = executionCancelled(db, task.jobId);
    if (attempt === undefined) {
      // Claimed, but its Attempt never started: nothing ran. Give the claim back.
      changeJob(db, { jobId: task.jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
        releaseAttemptTokens(tx, task.id, undefined);
        const row = tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get();
        if (row?.state !== 'claimed') return;
        stepTask(tx, { jobId: task.jobId, actor: ACTOR }, row, cancelled ? 'cancelled' : 'ready', {
          reason: cancelled ? 'job_cancelled' : 'recovery',
          payload: { detail: 'the runtime stopped before the Attempt started' },
        });
      });
      opts.onCommit();
      continue;
    }

    const recorded = attempt.processJson === null ? undefined : parseProcess(attempt.processJson);
    const spool = recorded === undefined ? undefined : inspectSpool(recorded.spool);
    let process: RecoveredProcess = spool?.state ?? 'none';
    if (
      recorded !== undefined &&
      spool !== undefined &&
      (process === 'alive' || process === 'finished') &&
      (recorded.kind !== 'harness' || recorded.token === undefined)
    ) {
      // Started, but the crash came before its re-attach token was recorded: it can't be
      // watched, so it must not run on beside what comes next. Stopped, it counts as dead.
      await stopIfAlive(recorded.spool, recorded.startedAt);
      if (recorded.kind === 'harness') process = 'dead';
    }
    const worktreeRow = requireWorktree(db, attempt.worktreeId);
    const worktree = await worktreeStatus(worktreeRow.path);
    const state = AttemptStateSchema.parse(attempt.state);
    if (state !== 'running' && state !== 'verifying' && state !== 'in_review') continue;
    const retriesUsed = db
      .select({ id: schema.attempts.id })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.cause, 'retry')))
      .all().length;
    const decision = cancelled
      ? ({ kind: 'cancel' } as const)
      : decideRecovery({
          attemptState: state,
          process,
          worktree,
          retriesUsed,
          maxRetries: task.maxRetries,
        });
    opts.log(
      `recovery: Attempt ${attempt.id} (${state}, process ${process}, Worktree ${worktree}): ${decision.kind}`,
    );

    if (decision.kind === 'reattach') {
      takeOverLeases(db, opts.holder, task.id, attempt.id, worktreeRow.portBase);
      resumptions.push({ kind: 'reattach', attemptId: attempt.id });
      continue;
    }
    // From here on nothing is re-attached: no process of the Attempt may be left running.
    if (recorded !== undefined) await stopIfAlive(recorded.spool, recorded.startedAt);
    if (decision.kind === 'resume' || decision.kind === 'cancel') {
      // A cancelled Job's Attempt is recorded `cancelled` by the scheduler, which owns that step.
      takeOverLeases(db, opts.holder, task.id, attempt.id, worktreeRow.portBase);
      resumptions.push({
        kind: 'resume',
        from: decision.kind === 'resume' ? decision.from : 'verification',
        attemptId: attempt.id,
      });
      continue;
    }

    const head = worktree === 'unknown' ? undefined : await resolveCommit(worktreeRow.path, 'HEAD');
    changeJob(
      db,
      { jobId: task.jobId, expectedVersion: 'current', actor: ACTOR },
      (tx, jobState, step) => {
        const op = { jobId: task.jobId, actor: ACTOR };
        const detail =
          decision.kind === 'retry'
            ? 'the runtime stopped and the Harness process did not survive; the Task gets a Retry'
            : decision.blocker.detail;
        stepAttempt(
          tx,
          op,
          attempt.id,
          state,
          {
            state: 'interrupted',
            exitReason: 'interrupted',
            exitDetail: detail,
            processJson: null,
            ...(head === undefined ? {} : { headSha: head }),
            finishedAt: new Date().toISOString(),
          },
          { exitReason: 'interrupted', process, worktree, decision: decision.kind },
        );
        const row = tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get();
        if (row === undefined) throw new Error(`no Task ${task.id}`);
        const wt = requireWorktree(tx, attempt.worktreeId);
        if (decision.kind === 'retry') {
          stepTask(tx, op, row, 'ready', {
            reason: 'retry',
            payload: { attemptId: attempt.id, retry: retriesUsed + 1, maxRetries: task.maxRetries },
          });
          if (wt.state === 'active') stepWorktree(tx, op, wt, 'active', 'preserved');
        } else {
          const blocker: Blocker = {
            ...decision.blocker,
            taskId: task.id,
            attemptId: attempt.id,
            createdAt: new Date().toISOString(),
          };
          stepTask(tx, op, row, 'blocked', {
            reason: blocker.reason,
            payload: { attemptId: attempt.id },
            blocker,
          });
          // Never deleted: a Worktree of unknown state is quarantined, any other preserved.
          if (wt.state === 'active') {
            stepWorktree(tx, op, wt, 'active', decision.quarantine ? 'quarantined' : 'preserved');
          }
        }
        releaseAttemptTokens(tx, task.id, wt.portBase);
        settleExecution(tx, jobState, step);
      },
    );
    opts.onCommit();
  }
  await removeStaleSpools(db, opts.spoolRoot);
  return resumptions;
}

/** Whether the Job's `execution` was cancelled (its work in flight must stop, not go on). */
function executionCancelled(db: FactoryDb, jobId: string): boolean {
  const run = db
    .select({ state: schema.stageRuns.state })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, 'execution')))
    .get();
  return run?.state === 'cancelled';
}

/** `unknown` when the Worktree is gone or git can't read it. */
async function worktreeStatus(path: string): Promise<RecoveredWorktree> {
  if (!existsSync(path)) return 'unknown';
  try {
    if ((await resolveCommit(path, 'HEAD')) === undefined) return 'unknown';
    return (await uncommittedPaths(path)).length === 0 ? 'clean' : 'dirty';
  } catch {
    return 'unknown';
  }
}

/** Hands the Attempt's leases (its Task with its capacity tokens, its port block) to this runtime, renewed. */
function takeOverLeases(
  db: FactoryDb,
  holder: string,
  taskId: string,
  attemptId: string,
  portBase: number,
): void {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    takeOverClaim(tx, taskId, holder);
    tx.update(schema.leases)
      .set({ holder: `${holder}/${attemptId}`, heartbeatAt: now, expiresAt: leaseExpiry() })
      .where(
        and(
          eq(schema.leases.resourceKind, 'port_block'),
          eq(schema.leases.resourceId, String(portBase)),
        ),
      )
      .run();
  });
}

/**
 * Stops a spooled process that is alive and provably ours (pid plus start
 * time): SIGTERM to its group, then SIGKILL. A dead leader's group is left
 * alone: without the leader, nothing proves the group is still ours.
 */
async function stopIfAlive(spool: string, startedAt: number): Promise<void> {
  if (inspectSpool(spool).state !== 'alive') return;
  await attachGuarded({ spool, startedAt, timeoutMs: Number.MAX_SAFE_INTEGER })?.cancel();
}

/**
 * Removes every spool no Attempt in progress still refers to (they hold raw
 * output), such as a proposal Harness Run's, whose Stage starts again. A
 * process still alive in one is stopped first, so it can't run beside the restart.
 */
async function removeStaleSpools(db: FactoryDb, spoolRoot: string): Promise<void> {
  if (!existsSync(spoolRoot)) return;
  const live = new Set(
    db
      .select({ id: schema.attempts.id })
      .from(schema.attempts)
      .where(inArray(schema.attempts.state, IN_PROGRESS))
      .all()
      .map((a) => a.id),
  );
  for (const entry of readdirSync(spoolRoot)) {
    if (live.has(entry)) continue;
    const dir = join(spoolRoot, entry);
    // An Attempt's directory holds one spool per process; a proposal Run's is the spool itself.
    const spools = existsSync(join(dir, 'pid')) ? [dir] : readdirSync(dir).map((d) => join(dir, d));
    for (const spool of spools) await stopIfAlive(spool, Date.now());
    rmSync(dir, { recursive: true, force: true });
  }
}
