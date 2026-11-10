/**
 * Claiming a ready Task (ARCHITECTURE §12 steps 1–3, ADR-0020). One
 * `BEGIN IMMEDIATE` transaction inserts the Task lease and one capacity token
 * per limit (global, per Repository, per Job), then moves the Task
 * `ready → claimed` (and `execution` `queued → running`). Any failure rolls
 * all of it back. The tokens share the Task lease's `lease_id`, so they are
 * released with it when the Attempt ends.
 *
 * Exported for the integration tier (#40), which races two processes on one
 * database file through {@link claimNextTask}. In production only the
 * runtime's Task scheduler calls it: one writer.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CAPACITY_RESOURCE,
  claimCapacity,
  EffectiveConfigSchema,
  type CapacityDecision,
  type HeldCapacityToken,
} from '@factory/domain';
import { and, eq, inArray, like } from 'drizzle-orm';
import { READY_TASK_ORDER } from './dispatch.js';
import { changeJob, stepTask } from './engine.js';
import { newId } from './ids.js';

/** How long a lease lasts without a heartbeat (ARCHITECTURE §12 step 4). */
export const LEASE_TTL_MS = 90_000;
/** How often the runtime renews the leases it holds (ARCHITECTURE §12 step 4). */
export const LEASE_HEARTBEAT_MS = 15_000;

/** The lease TTL in force: {@link LEASE_TTL_MS}, unless a test shortened it (ADR-0024). */
let leaseTtlMs = LEASE_TTL_MS;

/**
 * Test-only (ADR-0024): shortens every lease to `ms`, set once at startup
 * from `FACTORY_TEST_LEASE_TTL_MS`. The heartbeat (and so the sweeper) then
 * ticks three times per TTL.
 */
export function setLeaseTtlForTests(ms: number): void {
  leaseTtlMs = ms;
}

/** How often the heartbeat ticks: every 15 s, or a third of a shortened TTL. */
export function heartbeatIntervalMs(): number {
  return Math.min(LEASE_HEARTBEAT_MS, Math.max(1, Math.floor(leaseTtlMs / 3)));
}

/** When a lease renewed now expires. */
export function leaseExpiry(now = Date.now()): string {
  return new Date(now + leaseTtlMs).toISOString();
}

export interface ClaimOptions {
  /** The lease holder (`runtime:<pid>`). */
  holder: string;
  /** `config.json` `concurrency.global`. */
  globalLimit: number;
  /** Recorded as the actor of `task.claimed`. */
  actor: string;
}

/** A successful claim: the Task lease and the capacity tokens taken with it. */
export interface Claim {
  jobId: string;
  taskId: string;
  leaseId: string;
  tokens: HeldCapacityToken[];
}

/** Why one Task was not claimed. Thrown inside the transaction, so nothing is written. */
class ClaimRefused extends Error {
  constructor(
    readonly why: 'not_ready' | 'leased' | 'token_taken' | 'full',
    readonly decision?: Extract<CapacityDecision, { kind: 'full' }>,
  ) {
    super(`claim refused: ${why}`);
  }
}

/**
 * Claims the first ready Task, by priority then time ready (ADR-0017), that
 * fits under every concurrency limit. `undefined` when none does (none is
 * ready, the limits are reached, or another dispatcher took it first).
 */
export function claimNextTask(db: FactoryDb, opts: ClaimOptions): Claim | undefined {
  const candidates = db
    .select({ jobId: schema.tasks.jobId, taskId: schema.tasks.id })
    .from(schema.tasks)
    .innerJoin(
      schema.stageRuns,
      and(
        eq(schema.stageRuns.jobId, schema.tasks.jobId),
        eq(schema.stageRuns.stageId, 'execution'),
      ),
    )
    .where(
      and(eq(schema.tasks.state, 'ready'), inArray(schema.stageRuns.state, ['queued', 'running'])),
    )
    .orderBy(...READY_TASK_ORDER)
    .all();
  for (const candidate of candidates) {
    try {
      return claimTask(db, candidate, opts);
    } catch (err) {
      if (!(err instanceof ClaimRefused)) throw err;
      // The global limit holds for every candidate: nothing else can be claimed now.
      if (err.decision?.limit === 'global') return undefined;
    }
  }
  return undefined;
}

function claimTask(
  db: FactoryDb,
  candidate: { jobId: string; taskId: string },
  opts: ClaimOptions,
): Claim {
  const { jobId, taskId } = candidate;
  return changeJob(
    db,
    { jobId, expectedVersion: 'current', actor: opts.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'ready') throw new ClaimRefused('not_ready');
      const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
      const decision = claimCapacity({
        limits: {
          global: opts.globalLimit,
          perRepository: config.concurrency.perRepository.value,
          perJob: config.concurrency.perJob.value,
        },
        repositoryId: task.repositoryId,
        jobId,
        held: heldTokens(tx),
      });
      if (decision.kind === 'full') throw new ClaimRefused('full', decision);

      const leaseId = newId('lse');
      const now = new Date().toISOString();
      const lease = (resourceKind: string, resourceId: string) =>
        tx
          .insert(schema.leases)
          .values({
            resourceKind,
            resourceId,
            holder: opts.holder,
            leaseId,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: leaseExpiry(),
          })
          .onConflictDoNothing()
          .run().changes === 1;
      if (!lease('task', taskId)) throw new ClaimRefused('leased');
      for (const token of decision.tokens) {
        if (!lease(token.resourceKind, token.resourceId)) throw new ClaimRefused('token_taken');
      }
      stepTask(tx, { jobId, actor: opts.actor }, task, 'claimed', {
        payload: {
          leaseId,
          capacity: decision.tokens.map((t) => `${t.resourceKind}/${t.resourceId}`),
        },
      });
      const execution = state.stageRuns.find((r) => r.stageId === 'execution');
      if (execution?.state === 'queued') step(execution, 'running');
      return { jobId, taskId, leaseId, tokens: decision.tokens };
    },
  );
}

/** Every capacity token held now, by any Task. */
function heldTokens(tx: Tx): HeldCapacityToken[] {
  return tx
    .select({ resourceKind: schema.leases.resourceKind, resourceId: schema.leases.resourceId })
    .from(schema.leases)
    .where(like(schema.leases.resourceKind, 'capacity.%'))
    .all();
}

/** The `lease_id` of the Task's lease, which its capacity tokens share; `undefined` when unleased. */
function taskLeaseId(tx: Tx, taskId: string): string | undefined {
  return tx
    .select({ leaseId: schema.leases.leaseId })
    .from(schema.leases)
    .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
    .get()?.leaseId;
}

const CAPACITY_KINDS = Object.values(CAPACITY_RESOURCE);

/**
 * Releases a Task's claim: its lease and the capacity tokens taken with it.
 * Call in the transaction that ends the Attempt (ARCHITECTURE §12 step 5).
 */
export function releaseClaim(tx: Tx, taskId: string): void {
  const leaseId = taskLeaseId(tx, taskId);
  if (leaseId === undefined) return;
  tx.delete(schema.leases)
    .where(
      and(eq(schema.leases.leaseId, leaseId), inArray(schema.leases.resourceKind, CAPACITY_KINDS)),
    )
    .run();
  tx.delete(schema.leases)
    .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
    .run();
}

/** Hands a Task's claim (its lease and tokens) to `holder`, renewed (recovery, ADR-0012). */
export function takeOverClaim(tx: Tx, taskId: string, holder: string): void {
  const leaseId = taskLeaseId(tx, taskId);
  if (leaseId === undefined) return;
  const now = new Date().toISOString();
  tx.update(schema.leases)
    .set({ holder, heartbeatAt: now, expiresAt: leaseExpiry() })
    .where(
      and(
        eq(schema.leases.leaseId, leaseId),
        inArray(schema.leases.resourceKind, ['task', ...CAPACITY_KINDS]),
      ),
    )
    .run();
}
