/**
 * The Stage a Task's Attempts run in (ADR-0034): `execution` for a Plan Task,
 * `integration` for the Integration Task. Blocker and Question items hold it,
 * a cleared Blocker re-queues it, and a cancelled Job's work stops when it is
 * cancelled. Depends on the database rows only, so the engine can use it.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import { stageOfTask, TaskKindSchema } from '@factory/domain';
import { and, desc, eq } from 'drizzle-orm';

/** The Stage ID of the Task `taskId` (`execution` when the Task is unknown). */
export function stageIdOfTask(tx: Tx | FactoryDb, taskId: string): 'execution' | 'integration' {
  const task = tx
    .select({ kind: schema.tasks.kind })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  return stageOfTask(TaskKindSchema.parse(task?.kind ?? 'plan'));
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
