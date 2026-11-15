/**
 * The Stage a Task's Attempts run in (ADR-0034, ADR-0035): `execution` for a
 * Plan Task; `integration` for the Integration Task until its Integration
 * Review starts, then `integration_review`. Blocker and Question items hold
 * it, a cleared Blocker re-queues it, and a cancelled Job's work stops when
 * it is cancelled. Depends on the database rows only, so the engine can use it.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import { stageOfTask, TaskKindSchema, type TaskStageId } from '@factory/domain';
import { and, desc, eq } from 'drizzle-orm';

/**
 * Whether the Job's Integration Review has started: its newest
 * `integration_review` Stage Run is neither `pending` nor `skipped`
 * ({@link reviewStarted}). A Replan adds a new, pending one, so the new
 * Integration Task starts in `integration` again.
 */
export function integrationReviewStarted(tx: Tx | FactoryDb, jobId: string): boolean {
  const run = tx
    .select({ state: schema.stageRuns.state })
    .from(schema.stageRuns)
    .where(
      and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, 'integration_review')),
    )
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
  return reviewStarted(run);
}

/** An `integration_review` Stage Run that has started: neither `pending` nor `skipped` (ADR-0035). */
export function reviewStarted(run: { state: string } | undefined): boolean {
  return run !== undefined && run.state !== 'pending' && run.state !== 'skipped';
}

/** The Stage ID of the Task `taskId` (`execution` when the Task is unknown). */
export function stageIdOfTask(tx: Tx | FactoryDb, taskId: string): TaskStageId {
  const task = tx
    .select({ kind: schema.tasks.kind, jobId: schema.tasks.jobId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  if (task === undefined) return 'execution';
  const kind = TaskKindSchema.parse(task.kind);
  return stageOfTask(kind, kind === 'integration' && integrationReviewStarted(tx, task.jobId));
}

/** The Job's newest Stage Run of the Stage the Task `taskId` runs in. */
export function latestStageRunOfTask(
  tx: Tx | FactoryDb,
  jobId: string,
  taskId: string,
): typeof schema.stageRuns.$inferSelect | undefined {
  return tx
    .select()
    .from(schema.stageRuns)
    .where(
      and(
        eq(schema.stageRuns.jobId, jobId),
        eq(schema.stageRuns.stageId, stageIdOfTask(tx, taskId)),
      ),
    )
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
}
