/**
 * The only way Job and Stage Run state changes (ARCHITECTURE §4.5). Each
 * operation is one `BEGIN IMMEDIATE` transaction: an optimistic version check,
 * then the guards, then the state updates, then the events (the outbox).
 *
 * Lives in the runtime until the Stage handlers arrive; then it moves to
 * `packages/engine` (ADR-0005).
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  canTransitionStageRun,
  deriveJobStatus,
  FINISHED_STAGE_RUN_STATES,
  StageIdSchema,
  StageRunStateSchema,
  type JobStatus,
  type StageRunState,
} from '@factory/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiFailure } from './errors.js';

/** A Job's row and its Stage Runs, as read inside a transaction. */
export interface JobState {
  readonly job: typeof schema.jobs.$inferSelect;
  readonly stageRuns: (typeof schema.stageRuns.$inferSelect)[];
}

export interface JobOperation {
  jobId: string;
  /** The Job version the caller saw, or `current` for the factory's own decisions. */
  expectedVersion: number | 'current';
  actor: string;
}

/**
 * Runs `body` as one versioned change to a Job. The Job's version is checked
 * and bumped first; a stale version fails with 409 `version_conflict` and
 * nothing is written. Afterwards the Job status is re-derived from its Stage
 * Runs and stored, with a `job.status_changed` event when it changed.
 */
export function changeJob<T>(
  db: FactoryDb,
  op: JobOperation,
  body: (tx: Tx, state: JobState, step: StageRunStepper) => T,
): T {
  return db.transaction((tx) => changeJobIn(tx, op, body), { behavior: 'immediate' });
}

/** {@link changeJob} inside a transaction the caller already holds. */
export function changeJobIn<T>(
  tx: Tx,
  op: JobOperation,
  body: (tx: Tx, state: JobState, step: StageRunStepper) => T,
): T {
  const current = tx.select().from(schema.jobs).where(eq(schema.jobs.id, op.jobId)).get();
  if (current === undefined) {
    throw new ApiFailure(404, 'job_not_found', `no Job ${op.jobId}`);
  }
  const expected = op.expectedVersion === 'current' ? current.version : op.expectedVersion;
  const bumped = tx
    .update(schema.jobs)
    .set({ version: sql`${schema.jobs.version} + 1` })
    .where(and(eq(schema.jobs.id, op.jobId), eq(schema.jobs.version, expected)))
    .run();
  if (bumped.changes !== 1) {
    throw new ApiFailure(
      409,
      'version_conflict',
      `Job ${op.jobId} is at version ${String(current.version)}, not ${String(expected)}. Re-read it and decide again`,
    );
  }
  const state = readJobState(tx, op.jobId);
  const step = stageRunStepper(tx, op.jobId, op.actor);
  const result = body(tx, state, step);

  const runs = readJobState(tx, op.jobId).stageRuns;
  const status = deriveJobStatus(
    runs.map((r) => ({
      stageId: StageIdSchema.parse(r.stageId),
      state: StageRunStateSchema.parse(r.state),
    })),
  );
  if (status !== current.status) {
    tx.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, op.jobId)).run();
    appendEvent(tx, {
      entityKind: 'job',
      entityId: op.jobId,
      jobId: op.jobId,
      type: 'job.status_changed',
      actor: op.actor,
      payload: { from: current.status, to: status satisfies JobStatus },
    });
  }
  return result;
}

export function readJobState(tx: Tx | FactoryDb, jobId: string): JobState {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new ApiFailure(404, 'job_not_found', `no Job ${jobId}`);
  const stageRuns = tx
    .select()
    .from(schema.stageRuns)
    .where(eq(schema.stageRuns.jobId, jobId))
    .orderBy(asc(schema.stageRuns.position), asc(schema.stageRuns.attempt))
    .all();
  return { job, stageRuns };
}

/** Moves one Stage Run of the Job being changed, writing its event. */
export type StageRunStepper = (
  run: typeof schema.stageRuns.$inferSelect,
  to: StageRunState,
  reason?: string,
) => void;

function stageRunStepper(tx: Tx, jobId: string, actor: string): StageRunStepper {
  return (run, to, reason) => {
    const from = StageRunStateSchema.parse(run.state);
    if (!canTransitionStageRun(from, to)) {
      throw new Error(`illegal Stage Run transition ${from} → ${to} (${run.id})`);
    }
    const now = new Date().toISOString();
    const updated = tx
      .update(schema.stageRuns)
      .set({
        state: to,
        version: sql`${schema.stageRuns.version} + 1`,
        ...(to === 'running' ? { startedAt: now } : {}),
        ...(isFinished(to) ? { finishedAt: now } : {}),
      })
      .where(
        and(
          eq(schema.stageRuns.id, run.id),
          eq(schema.stageRuns.state, from),
          eq(schema.stageRuns.version, run.version),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      // The Job version check above makes this unreachable unless a writer bypassed it.
      throw new Error(`Stage Run ${run.id} changed under a versioned Job operation`);
    }
    appendEvent(tx, {
      entityKind: 'stage_run',
      entityId: run.id,
      jobId,
      type: `stage_run.${to}`,
      actor,
      payload: { stageId: run.stageId, from, to, ...(reason === undefined ? {} : { reason }) },
    });
  };
}

function isFinished(state: StageRunState): boolean {
  return FINISHED_STAGE_RUN_STATES.includes(state);
}
