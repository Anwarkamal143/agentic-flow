/**
 * Project slots (ADR-0050, ADR-0058): `concurrency.perProjectJobs` counts a
 * Project's Jobs with work in flight, a Task lease (a claimed or running
 * Attempt) or a running proposal Stage Run. A Job's first claim takes a
 * `capacity.project` token in the claim's transaction; later claims of the
 * same Job take none. The token belongs to the Job (lease id
 * `projectSlotLeaseId`), not to a claim, and goes in the transaction that
 * leaves the Job with nothing in flight, so a Job waiting on a human holds no
 * slot.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CAPACITY_RESOURCE,
  fairnessConstants,
  ProjectConfigSchema,
  projectSlotDecision,
  projectSlotLeaseId,
  resolveProjectJobLimit,
  type FairnessConstants,
  type ProjectJobLimit,
  type ProjectSlotDecision,
} from '@factory/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { read as readFactoryLevel } from './factory-level.js';
import { PROPOSAL_STAGE_IDS } from './proposals.js';

const KIND = CAPACITY_RESOURCE.project;

/** The Project's Job limit now: its own, else the Factory Level's, else unlimited. */
export function projectJobLimit(tx: Tx | FactoryDb, projectId: string): ProjectJobLimit {
  const project = tx
    .select({ configJson: schema.projects.configJson })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  const config = ProjectConfigSchema.parse(JSON.parse(project?.configJson ?? '{}'));
  return resolveProjectJobLimit(readFactoryLevel(tx)?.config ?? {}, config).value;
}

/** The Factory Level's aging constants now. */
export function schedulingConstants(tx: Tx | FactoryDb): FairnessConstants {
  return fairnessConstants(readFactoryLevel(tx)?.config.scheduling);
}

/** What the fair ordering reads: each Project's Jobs in flight and its limit. */
export function projectLoad(db: Tx | FactoryDb): {
  inFlight: Map<string, number>;
  limits: Map<string, ProjectJobLimit>;
  constants: FairnessConstants;
} {
  const inFlight = new Map<string, number>();
  for (const { resourceId } of heldSlots(db)) {
    const projectId = resourceId.slice(0, resourceId.lastIndexOf(':'));
    inFlight.set(projectId, (inFlight.get(projectId) ?? 0) + 1);
  }
  const limits = new Map<string, ProjectJobLimit>();
  for (const { id } of db.select({ id: schema.projects.id }).from(schema.projects).all()) {
    limits.set(id, projectJobLimit(db, id));
  }
  return { inFlight, limits, constants: schedulingConstants(db) };
}

function heldSlots(tx: Tx | FactoryDb): { resourceId: string; leaseId: string }[] {
  return tx
    .select({ resourceId: schema.leases.resourceId, leaseId: schema.leases.leaseId })
    .from(schema.leases)
    .where(eq(schema.leases.resourceKind, KIND))
    .all();
}

function jobSlot(tx: Tx, jobId: string): { resourceId: string } | undefined {
  return tx
    .select({ resourceId: schema.leases.resourceId })
    .from(schema.leases)
    .where(
      and(
        eq(schema.leases.resourceKind, KIND),
        eq(schema.leases.leaseId, projectSlotLeaseId(jobId)),
      ),
    )
    .get();
}

/** A Project slot taken (or already held) by a claim of `jobId`. */
export type ProjectSlotClaim =
  | { kind: 'held'; resourceId: string }
  | { kind: 'granted'; resourceId: string }
  | Extract<ProjectSlotDecision, { kind: 'full' }>;

/**
 * Takes a Project slot for `jobId` under its Project's limit, inside the claim's
 * transaction. `held` when the Job is already in flight (no new slot); `full`
 * when the Project is at its limit (nothing is written).
 */
export function takeProjectSlot(
  tx: Tx,
  input: {
    jobId: string;
    projectId: string;
    holder: string;
    /** The lease timestamps of the claim. */
    acquiredAt: string;
    expiresAt: string;
  },
): ProjectSlotClaim {
  const own = jobSlot(tx, input.jobId);
  if (own !== undefined) return { kind: 'held', resourceId: own.resourceId };
  const decision = projectSlotDecision({
    projectId: input.projectId,
    limit: projectJobLimit(tx, input.projectId),
    held: heldSlots(tx).map((s) => s.resourceId),
    jobHoldsSlot: false,
  });
  if (decision.kind === 'full') return decision;
  if (decision.kind === 'held') throw new Error('unreachable: the Job holds no slot');
  insertSlot(tx, { ...input, resourceId: decision.resourceId });
  return { kind: 'granted', resourceId: decision.resourceId };
}

function insertSlot(
  tx: Tx,
  input: {
    jobId: string;
    holder: string;
    resourceId: string;
    acquiredAt: string;
    expiresAt: string;
  },
): void {
  const inserted = tx
    .insert(schema.leases)
    .values({
      resourceKind: KIND,
      resourceId: input.resourceId,
      holder: input.holder,
      leaseId: projectSlotLeaseId(input.jobId),
      acquiredAt: input.acquiredAt,
      heartbeatAt: input.acquiredAt,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .run();
  if (inserted.changes !== 1) {
    // The transaction is `BEGIN IMMEDIATE` and the slot was read free in it: a writer bypassed it.
    throw new Error(`Project slot ${input.resourceId} is taken`);
  }
}

/**
 * Hands the Job's Project slot to `holder` (recovery, an orphaned proposal Stage
 * Run), or takes one past the limit when the Job has none: its work is already
 * in flight, so it is counted, never stopped.
 */
export function holdProjectSlot(
  tx: Tx,
  input: { jobId: string; holder: string; expiresAt: string },
): void {
  const now = new Date().toISOString();
  if (jobSlot(tx, input.jobId) !== undefined) {
    tx.update(schema.leases)
      .set({ holder: input.holder, heartbeatAt: now, expiresAt: input.expiresAt })
      .where(
        and(
          eq(schema.leases.resourceKind, KIND),
          eq(schema.leases.leaseId, projectSlotLeaseId(input.jobId)),
        ),
      )
      .run();
    return;
  }
  const job = tx
    .select({ projectId: schema.jobs.projectId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .get();
  if (job === undefined) return;
  const decision = projectSlotDecision({
    projectId: job.projectId,
    limit: 'unlimited',
    held: heldSlots(tx).map((s) => s.resourceId),
    jobHoldsSlot: false,
  });
  if (decision.kind !== 'granted') return;
  insertSlot(tx, { ...input, resourceId: decision.resourceId, acquiredAt: now });
}

/**
 * Releases the Job's Project slot when it has nothing in flight: no Task
 * lease and no running proposal Stage Run. Call in every transaction that may
 * end a Job's work in flight; a no-op otherwise.
 */
export function releaseIdleProjectSlot(tx: Tx, jobId: string): void {
  if (jobSlot(tx, jobId) === undefined) return;
  const leased = tx
    .select({ n: sql<number>`count(*)` })
    .from(schema.leases)
    .innerJoin(
      schema.tasks,
      and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, schema.tasks.id)),
    )
    .where(eq(schema.tasks.jobId, jobId))
    .get();
  const proposing = tx
    .select({ n: sql<number>`count(*)` })
    .from(schema.stageRuns)
    .where(
      and(
        eq(schema.stageRuns.jobId, jobId),
        eq(schema.stageRuns.state, 'running'),
        inArray(schema.stageRuns.stageId, [...PROPOSAL_STAGE_IDS]),
      ),
    )
    .get();
  if ((leased?.n ?? 0) > 0 || (proposing?.n ?? 0) > 0) return;
  tx.delete(schema.leases)
    .where(
      and(
        eq(schema.leases.resourceKind, KIND),
        eq(schema.leases.leaseId, projectSlotLeaseId(jobId)),
      ),
    )
    .run();
}
