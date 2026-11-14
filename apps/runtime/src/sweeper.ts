/**
 * The heartbeat tick and the lease-expiry sweeper (ARCHITECTURE §12 steps 4
 * and 6, ADR-0024). On every tick the runtime renews the leases it holds,
 * then sweeps: an Attempt whose Task lease is past `expires_at` has its
 * process group killed (pid plus start time checked, ADR-0012), is marked
 * `interrupted`, keeps its Worktree `preserved`, and gives back its lease and
 * capacity tokens in that same transaction. The Task gets a Retry only when
 * the process is confirmed dead; otherwise it is blocked with
 * `recovery_uncertain`. Nothing is ever started here, so an Attempt never
 * runs twice.
 *
 * An expired Attempt can still be in flight in this runtime (its heartbeat
 * stopped, but its slot did not). Its slot is told to stop first
 * ({@link sweptAttempt}) and waited for, so nothing it does lands after the
 * Attempt's end, and the Retry's claim never meets it.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { schema, type FactoryDb } from '@factory/db';
import { AttemptStateSchema, type Blocker, type RecoveredWorktree } from '@factory/domain';
import { resolveCommit } from '@factory/git';
import { inspectSpool, type SpoolState } from '@factory/harness';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { leaseExpiry, releaseClaim, setLeaseTtlForTests } from './claim.js';
import { changeJob, stepAttempt, stepTask, stepWorktree } from './engine.js';
import { parseProcess, settleExecution } from './execution.js';
import { stopIfAlive, worktreeStatus } from './recovery.js';
import { releaseAttemptTokens, requireWorktree } from './worktree.js';

const ACTOR = 'system:sweeper';
const IN_PROGRESS = ['running', 'verifying', 'in_review'];

// ---- test-only knobs (ADR-0024, in the style of ADR-0012's crash point) -----------

/** The lease knobs read from the environment. Unset: no effect. */
export interface LeaseKnobs {
  /** `FACTORY_TEST_FREEZE_HEARTBEAT=1`: leases are never renewed (the sweeper still runs). */
  freezeHeartbeat: boolean;
  /** `FACTORY_TEST_LEASE_TTL_MS=<positive integer>`: every lease lasts this long. */
  leaseTtlMs: number | undefined;
}

/** Reads the knobs; an unknown value is an error, never ignored. */
export function parseLeaseKnobs(
  env: NodeJS.ProcessEnv,
): { ok: true; knobs: LeaseKnobs } | { ok: false; error: string } {
  const freeze = env['FACTORY_TEST_FREEZE_HEARTBEAT'];
  if (freeze !== undefined && freeze !== '1') {
    return { ok: false, error: `unknown FACTORY_TEST_FREEZE_HEARTBEAT: ${freeze}` };
  }
  const ttl = env['FACTORY_TEST_LEASE_TTL_MS'];
  const ttlMs = ttl === undefined ? undefined : Number(ttl);
  if (ttl !== undefined && (!/^\d+$/.test(ttl) || ttlMs === undefined || ttlMs < 1)) {
    return { ok: false, error: `unknown FACTORY_TEST_LEASE_TTL_MS: ${ttl}` };
  }
  return { ok: true, knobs: { freezeHeartbeat: freeze === '1', leaseTtlMs: ttlMs } };
}

let frozen = false;

/** Applies the knobs, once, at startup, before any lease is taken. */
export function applyLeaseKnobs(knobs: LeaseKnobs): void {
  frozen = knobs.freezeHeartbeat;
  if (knobs.leaseTtlMs !== undefined) setLeaseTtlForTests(knobs.leaseTtlMs);
}

// ---- the tick --------------------------------------------------------------------

export interface HeartbeatOptions {
  db: FactoryDb;
  /** This runtime's lease holder (`runtime:<pid>`); Attempt tokens are `<holder>/<attempt id>`. */
  holder: string;
  spoolRoot: string;
  /** The slot of the Task in flight in this runtime, as a promise of its end; `undefined` if none. */
  inFlight: (taskId: string) => Promise<void> | undefined;
  /** `true` once the runtime is shutting down: what is left goes to recovery at the next start. */
  closed: () => boolean;
  onCommit: () => void;
  log: (message: string) => void;
}

/** Tasks being swept now, so one tick never sweeps what an earlier one still is. */
const sweeping = new Set<string>();
/** Attempts the sweeper ended (or is ending): their slot must stop at its next check. */
const swept = new Set<string>();

/**
 * Whether the sweeper took this Attempt over: its slot stops at its next
 * check and records nothing more (the sweeper records the Attempt's end).
 */
export function sweptAttempt(attemptId: string): boolean {
  return swept.has(attemptId);
}

/** One heartbeat tick: renew this runtime's leases (unless frozen), then sweep the expired ones. */
export function heartbeatTick(opts: HeartbeatOptions): void {
  if (!frozen) renewLeases(opts.db, opts.holder);
  sweepExpired(opts);
}

/**
 * Renews every lease this runtime holds (ARCHITECTURE §12 step 4). One
 * statement, so atomic; no event, as a renewal changes no state (ADR-0024).
 */
function renewLeases(db: FactoryDb, holder: string): void {
  const now = Date.now();
  db.update(schema.leases)
    .set({ heartbeatAt: new Date(now).toISOString(), expiresAt: leaseExpiry(now) })
    .where(
      sql`${schema.leases.holder} = ${holder} OR ${schema.leases.holder} LIKE ${`${holder}/%`}`,
    )
    .run();
}

function sweepExpired(opts: HeartbeatOptions): void {
  const { db } = opts;
  const expired = db
    .select({ taskId: schema.leases.resourceId, expiresAt: schema.leases.expiresAt })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.resourceKind, 'task'),
        lt(schema.leases.expiresAt, new Date().toISOString()),
      ),
    )
    .all();
  for (const { taskId, expiresAt } of expired) {
    if (sweeping.has(taskId)) continue;
    const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (task === undefined) continue;
    const attempt = db
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, taskId), inArray(schema.attempts.state, IN_PROGRESS)))
      .get();
    if (attempt === undefined) {
      // Claimed, and still being set up here: its Attempt is swept once it starts.
      if (opts.inFlight(taskId) !== undefined) continue;
      releaseUnstarted(opts, task, expiresAt);
      continue;
    }
    sweeping.add(taskId);
    swept.add(attempt.id);
    void sweepAttempt(opts, attempt.id, expiresAt)
      .catch((err: unknown) => {
        opts.log(
          `sweeper: Attempt ${attempt.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      })
      .finally(() => {
        sweeping.delete(taskId);
      });
  }
}

/** An expired claim whose Attempt never started (nothing ran): the claim is given back. */
function releaseUnstarted(
  opts: HeartbeatOptions,
  task: typeof schema.tasks.$inferSelect,
  expiresAt: string,
): void {
  changeJob(opts.db, { jobId: task.jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
    releaseClaim(tx, task.id);
    const row = tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get();
    if (row?.state !== 'claimed') return;
    stepTask(tx, { jobId: task.jobId, actor: ACTOR }, row, 'ready', {
      reason: 'lease_expired',
      payload: { expiresAt, detail: 'the claim expired before its Attempt started' },
    });
  });
  opts.onCommit();
}

/** What the sweeper found of the Attempt's process once it tried to stop it. */
type SweptProcess = SpoolState['state'] | 'unrecorded';

async function sweepAttempt(
  opts: HeartbeatOptions,
  attemptId: string,
  expiresAt: string,
): Promise<void> {
  const { db } = opts;
  const { taskId } = requireAttempt(db, attemptId);
  let process = await stopProcess(db, attemptId);
  // In flight here: once its process is gone, its slot stops at its next check.
  // Awaited only then: a slot whose process can't be stopped may never end.
  const slot = opts.inFlight(taskId);
  if (slot !== undefined && confirmedDead(process)) {
    await slot.catch(() => undefined);
    // It may have started another process before it stopped (it checks before each start).
    process = await stopProcess(db, attemptId);
  }
  if (opts.closed()) return; // shutting down: recovery decides at the next start
  const attempt = requireAttempt(db, attemptId);
  if (!IN_PROGRESS.includes(attempt.state)) return; // it ended on its own meanwhile
  const state = AttemptStateSchema.parse(attempt.state);

  const worktreeRow = requireWorktree(db, attempt.worktreeId);
  const worktree = await worktreeStatus(worktreeRow.path);
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, attempt.taskId)).get();
  if (task === undefined) throw new Error(`Attempt ${attemptId} has no Task`);
  const retriesUsed = db
    .select({ id: schema.attempts.id })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.cause, 'retry')))
    .all().length;
  const dead = confirmedDead(process);
  const decision = decideExpiry({ dead, worktree, retriesUsed, maxRetries: task.maxRetries });
  opts.log(
    `sweeper: the lease of Attempt ${attemptId} expired at ${expiresAt} (${state}, process ${process}, Worktree ${worktree}): ${decision.kind}`,
  );
  const head = worktree === 'unknown' ? undefined : await resolveCommit(worktreeRow.path, 'HEAD');

  changeJob(
    db,
    { jobId: task.jobId, expectedVersion: 'current', actor: ACTOR },
    (tx, jobState, step) => {
      const op = { jobId: task.jobId, actor: ACTOR };
      stepAttempt(
        tx,
        op,
        attemptId,
        state,
        {
          state: 'interrupted',
          exitReason: 'interrupted',
          exitDetail:
            decision.kind === 'retry'
              ? 'its lease expired without a heartbeat; its process is dead, so the Task gets a Retry'
              : decision.blocker.detail,
          // An unconfirmed process stays on record, for whoever checks it again.
          ...(dead ? { processJson: null } : {}),
          ...(head === undefined ? {} : { headSha: head }),
          finishedAt: new Date().toISOString(),
        },
        {
          exitReason: 'interrupted',
          cause: 'lease_expired',
          expiresAt,
          process: dead ? 'dead' : 'unconfirmed',
          observed: process,
          worktree,
          decision: decision.kind,
        },
      );
      const row = tx.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)).get();
      if (row === undefined) throw new Error(`no Task ${task.id}`);
      const wt = requireWorktree(tx, attempt.worktreeId);
      if (decision.kind === 'retry') {
        stepTask(tx, op, row, 'ready', {
          reason: 'retry',
          payload: { attemptId, retry: retriesUsed + 1, maxRetries: task.maxRetries },
        });
        if (wt.state === 'active') stepWorktree(tx, op, wt, 'active', 'preserved');
      } else {
        const blocker: Blocker = {
          ...decision.blocker,
          taskId: task.id,
          attemptId,
          createdAt: new Date().toISOString(),
        };
        stepTask(tx, op, row, 'blocked', {
          reason: blocker.reason,
          payload: { attemptId },
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
  // Its raw output goes once nothing can still be writing it; an unconfirmed one is kept.
  if (dead) rmSync(join(opts.spoolRoot, attemptId), { recursive: true, force: true });
}

function requireAttempt(db: FactoryDb, id: string): typeof schema.attempts.$inferSelect {
  const row = db.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (row === undefined) throw new Error(`no Attempt ${id}`);
  return row;
}

/**
 * Stops the Attempt's recorded process if it is alive and provably ours (pid
 * plus start time), then reports what is left of it. `unrecorded`: the
 * Attempt is between processes.
 */
async function stopProcess(db: FactoryDb, attemptId: string): Promise<SweptProcess> {
  const json = requireAttempt(db, attemptId).processJson;
  if (json === null) return 'unrecorded';
  const recorded = parseProcess(json);
  await stopIfAlive(recorded.spool, recorded.startedAt);
  const state = inspectSpool(recorded.spool).state;
  // Its slot here saw it end, recorded that, and removed the spool meanwhile.
  if (state === 'none' && requireAttempt(db, attemptId).processJson !== json) return 'finished';
  return state;
}

/** Dead for sure: it exited, it is gone without an exit status, or there was none. */
function confirmedDead(process: SweptProcess): boolean {
  return process === 'dead' || process === 'finished' || process === 'unrecorded';
}

type ExpiryDecision =
  | { kind: 'retry' }
  | {
      kind: 'blocked';
      quarantine: boolean;
      blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'>;
    };

/**
 * What an expired Attempt's Task does next (ADR-0024). A Retry only when the
 * process is confirmed dead, the Worktree is clean, and a Retry is left: the
 * same rules as crash recovery (ADR-0012). Pure.
 */
function decideExpiry(input: {
  dead: boolean;
  worktree: RecoveredWorktree;
  retriesUsed: number;
  maxRetries: number;
}): ExpiryDecision {
  const uncertain = (quarantine: boolean, detail: string, requiredAction: string) =>
    ({
      kind: 'blocked',
      quarantine,
      blocker: { kind: 'recovery', reason: 'recovery_uncertain', detail, requiredAction },
    }) as const;
  if (!input.dead) {
    return uncertain(
      false,
      "the Attempt's lease expired, and its process could not be proven dead (its pid and start time can't be checked, or it would not stop)",
      'check whether the process is still running before the Task goes on; the factory never starts a second one beside it',
    );
  }
  if (input.worktree === 'unknown') {
    return uncertain(
      true,
      "the Attempt's lease expired, and its Worktree is missing or git cannot read it",
      'inspect the quarantined Worktree; the factory never deletes it, and nothing more runs there',
    );
  }
  if (input.worktree === 'dirty') {
    return uncertain(
      false,
      "the Attempt's lease expired and its process was stopped, leaving uncommitted changes, so a Retry could build on half-done work",
      'look at the uncommitted changes in the preserved Worktree and decide how the Task goes on',
    );
  }
  if (input.retriesUsed >= input.maxRetries) {
    return {
      kind: 'blocked',
      quarantine: false,
      blocker: {
        kind: 'recovery',
        reason: 'retry_cap_reached',
        detail: `the Attempt's lease expired and its process was stopped, and the Task has had ${String(input.retriesUsed)} of at most ${String(input.maxRetries)} Retries`,
        requiredAction:
          'find out why the Attempts keep being interrupted, then decide how the Task goes on',
      },
    };
  }
  return { kind: 'retry' };
}
