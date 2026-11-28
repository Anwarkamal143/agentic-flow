/**
 * Claiming a ready Task (ARCHITECTURE §12 steps 1–3, ADR-0020) or a queued
 * proposal Stage Run (ADR-0050). Both take their candidates in the fair order
 * (`dispatch.ts`) and take the Job's Project slot (`project-slot.ts`) in the
 * claim's transaction when the Job has nothing else in flight; a Project at
 * its `concurrency.perProjectJobs` refuses a Job not yet in flight.
 *
 * A Task's one `BEGIN IMMEDIATE` transaction inserts the Task lease and one
 * capacity token per limit (global, per Repository, per Job), then moves the
 * Task `ready → claimed` (and its Stage, `execution`, `integration` or
 * `integration_review`, `queued → running`). Any failure rolls all of it back.
 * The tokens share the Task lease's `lease_id`, so they are released with it
 * when the Attempt ends; the Project slot is the Job's, released once the Job
 * has nothing in flight.
 *
 * Exported for the integration tier (#40, #99), which races processes on one
 * database file through {@link claimNextTask} and {@link claimNextProposalStage}.
 * In production only the runtime's schedulers call them: one writer.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CAPACITY_RESOURCE,
  claimCapacity,
  EffectiveConfigSchema,
  type CapacityDecision,
  type HeldCapacityToken,
} from '@factory/domain';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import {
  fairly,
  jobPriorityWeight,
  STAGE_QUEUED_SEQ,
  STAGE_QUEUED_TS,
  TASK_READY_SEQ,
  TASK_READY_TS,
} from './dispatch.js';
import { changeJob, stepTask } from './engine.js';
import { newId } from './ids.js';
import {
  holdProjectSlot,
  releaseIdleProjectSlot,
  takeProjectSlot,
  type ProjectSlotClaim,
} from './project-slot.js';
import { PROPOSAL_STAGE_IDS } from './proposals.js';
import { stageIdOfTask } from './task-stage.js';

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
  /** The Factory Level's `concurrency.global`. */
  globalLimit: number;
  /** Recorded as the actor of `task.claimed`. */
  actor: string;
}

/**
 * The Job's Project slot after a claim: `granted` when this claim took it (the
 * Job had nothing in flight), `held` when the Job already held it.
 */
export interface ClaimedProjectSlot {
  kind: 'granted' | 'held';
  resourceId: string;
}

/** A successful claim: the Task lease and the capacity tokens taken with it. */
export interface Claim {
  jobId: string;
  taskId: string;
  leaseId: string;
  /** Released with the Task lease. */
  tokens: HeldCapacityToken[];
  /** The Job's; released once the Job has nothing in flight. */
  projectSlot: ClaimedProjectSlot;
}

/** Why one claim was refused. Thrown inside the transaction, so nothing is written. */
class ClaimRefused extends Error {
  constructor(
    readonly why: 'not_ready' | 'leased' | 'token_taken' | 'full' | 'project_full',
    readonly decision?: Extract<CapacityDecision, { kind: 'full' }>,
  ) {
    super(`claim refused: ${why}`);
  }
}

/**
 * Claims the first ready Task, in the fair order (ADR-0050), that fits under
 * every concurrency limit, its Project's Job limit included. `undefined` when
 * none does (none is ready, the limits are reached, or another dispatcher took
 * it first).
 */
export function claimNextTask(db: FactoryDb, opts: ClaimOptions): Claim | undefined {
  const rows = db
    .select({
      jobId: schema.tasks.jobId,
      taskId: schema.tasks.id,
      projectId: schema.jobs.projectId,
      priorityWeight: schema.tasks.priority,
      readyTs: TASK_READY_TS,
    })
    .from(schema.tasks)
    // A Plan Task runs in `execution`; the Integration Task in `integration`, or in
    // `integration_review` once its Integration Review started (ADR-0034, ADR-0035). At most
    // one of those two is queued or running at a time.
    .innerJoin(
      schema.stageRuns,
      and(
        eq(schema.stageRuns.jobId, schema.tasks.jobId),
        sql`case when ${schema.tasks.kind} = 'integration' then ${schema.stageRuns.stageId} in ('integration', 'integration_review') else ${schema.stageRuns.stageId} = 'execution' end`,
      ),
    )
    // A Job whose Replan is requested dispatches nothing new, Rework included (ADR-0029).
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.tasks.jobId))
    .where(
      and(
        eq(schema.tasks.state, 'ready'),
        inArray(schema.stageRuns.state, ['queued', 'running']),
        eq(schema.jobs.replanRequested, false),
      ),
    )
    .orderBy(asc(TASK_READY_SEQ), asc(sql`"tasks"."rowid"`))
    .all();
  const candidates = fairly(
    db,
    rows.map((r) => ({ ...r, readyAt: r.readyTs ?? new Date(0).toISOString() })),
  );
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
      if (task?.state !== 'ready' || state.job.replanRequested) throw new ClaimRefused('not_ready');
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
      const projectSlot = projectSlotOf(
        takeProjectSlot(tx, {
          jobId,
          projectId: state.job.projectId,
          holder: opts.holder,
          acquiredAt: now,
          expiresAt: leaseExpiry(),
        }),
      );
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
          projectSlot: `${CAPACITY_RESOURCE.project}/${projectSlot.resourceId} (${projectSlot.kind})`,
        },
      });
      const stageId = stageIdOfTask(tx, task.id);
      const stage = state.stageRuns.filter((r) => r.stageId === stageId).at(-1);
      if (stage?.state === 'queued') step(stage, 'running');
      return { jobId, taskId, leaseId, tokens: decision.tokens, projectSlot };
    },
  );
}

function projectSlotOf(slot: ProjectSlotClaim): ClaimedProjectSlot {
  if (slot.kind === 'full') throw new ClaimRefused('project_full');
  return slot;
}

export interface ProposalClaimOptions {
  /** The holder of the Project slot a claim takes (`runtime:<pid>`). */
  holder: string;
  /** Recorded as the actor of `stage_run.running`. */
  actor: string;
}

/** A queued proposal Stage Run moved to `running`, with its Job's Project slot. */
export interface ProposalClaim {
  jobId: string;
  stageRunId: string;
  projectSlot: ClaimedProjectSlot;
}

/**
 * Moves the first queued proposal Stage Run, in the fair order (ADR-0050),
 * whose Job fits under its Project's Job limit to `running`, taking the Job's
 * Project slot in the same transaction. `undefined` when none fits. The
 * proposal-Stage scheduler runs one Stage at a time, so no other token is taken.
 */
export function claimNextProposalStage(
  db: FactoryDb,
  opts: ProposalClaimOptions,
): ProposalClaim | undefined {
  const rows = db
    .select({
      jobId: schema.stageRuns.jobId,
      stageRunId: schema.stageRuns.id,
      projectId: schema.jobs.projectId,
      jobPriority: schema.jobs.priority,
      readyTs: STAGE_QUEUED_TS,
      createdAt: schema.jobs.createdAt,
    })
    .from(schema.stageRuns)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
    .where(
      and(
        eq(schema.stageRuns.state, 'queued'),
        inArray(schema.stageRuns.stageId, [...PROPOSAL_STAGE_IDS]),
      ),
    )
    .orderBy(asc(STAGE_QUEUED_SEQ), asc(schema.jobs.createdAt), asc(schema.stageRuns.position))
    .all();
  const candidates = fairly(
    db,
    rows.map((r) => ({
      ...r,
      priorityWeight: jobPriorityWeight(r.jobPriority),
      readyAt: r.readyTs ?? r.createdAt,
    })),
  );
  for (const candidate of candidates) {
    try {
      return changeJob(
        db,
        { jobId: candidate.jobId, expectedVersion: 'current', actor: opts.actor },
        (tx, state, step) => {
          const run = state.stageRuns.find((r) => r.id === candidate.stageRunId);
          if (run?.state !== 'queued') throw new ClaimRefused('not_ready');
          const projectSlot = projectSlotOf(
            takeProjectSlot(tx, {
              jobId: candidate.jobId,
              projectId: state.job.projectId,
              holder: opts.holder,
              acquiredAt: new Date().toISOString(),
              expiresAt: leaseExpiry(),
            }),
          );
          step(run, 'running');
          return { jobId: candidate.jobId, stageRunId: run.id, projectSlot };
        },
      );
    } catch (err) {
      if (!(err instanceof ClaimRefused)) throw err;
    }
  }
  return undefined;
}

/**
 * Hands the Project slot of a Job whose proposal Stage Run a previous runtime
 * left `running` to `holder`: the Stage resumes, so the Job stays in flight.
 */
export function resumeProposalSlot(db: FactoryDb, jobId: string, holder: string): void {
  db.transaction(
    (tx) => {
      holdProjectSlot(tx, { jobId, holder, expiresAt: leaseExpiry() });
    },
    { behavior: 'immediate' },
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

/** The tokens that share a Task lease's id (the Project slot is the Job's, never among them). */
const CLAIM_TOKEN_KINDS = [
  CAPACITY_RESOURCE.global,
  CAPACITY_RESOURCE.repository,
  CAPACITY_RESOURCE.job,
];

/**
 * Releases a Task's claim: its lease and the capacity tokens taken with it,
 * and the Job's Project slot when that was the Job's last work in flight.
 * Call in the transaction that ends the Attempt (ARCHITECTURE §12 step 5).
 */
export function releaseClaim(tx: Tx, taskId: string): void {
  const leaseId = taskLeaseId(tx, taskId);
  if (leaseId === undefined) return;
  tx.delete(schema.leases)
    .where(
      and(
        eq(schema.leases.leaseId, leaseId),
        inArray(schema.leases.resourceKind, CLAIM_TOKEN_KINDS),
      ),
    )
    .run();
  tx.delete(schema.leases)
    .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
    .run();
  const jobId = jobOfTask(tx, taskId);
  if (jobId !== undefined) releaseIdleProjectSlot(tx, jobId);
}

function jobOfTask(tx: Tx, taskId: string): string | undefined {
  return tx
    .select({ jobId: schema.tasks.jobId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get()?.jobId;
}

/**
 * Hands a Task's claim (its lease and tokens, and its Job's Project slot) to
 * `holder`, renewed (recovery, ADR-0012).
 */
export function takeOverClaim(tx: Tx, taskId: string, holder: string): void {
  const leaseId = taskLeaseId(tx, taskId);
  if (leaseId === undefined) return;
  const jobId = jobOfTask(tx, taskId);
  if (jobId !== undefined) holdProjectSlot(tx, { jobId, holder, expiresAt: leaseExpiry() });
  const now = new Date().toISOString();
  tx.update(schema.leases)
    .set({ holder, heartbeatAt: now, expiresAt: leaseExpiry() })
    .where(
      and(
        eq(schema.leases.leaseId, leaseId),
        inArray(schema.leases.resourceKind, ['task', ...CLAIM_TOKEN_KINDS]),
      ),
    )
    .run();
}
