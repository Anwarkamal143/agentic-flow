/**
 * The `plan` Fault Origin route (ARCHITECTURE §4.6, Phase B decision Q28,
 * ADR-0030): a blocking Finding blames the Plan, so the Task that raised it
 * and every Task depending on it, directly or transitively, are cancelled at
 * once (they can't have started), with their open Inbox Items. The raising
 * Task's Worktree stays `preserved` and its branch is kept (the caller
 * preserves it). Every other Task follows the requested-Replan rule
 * (ADR-0029): the Findings are the feedback, the Replan counts against
 * `maxReplans`, and at the cap it waits in a `replan_cap_reached` Blocker
 * Approval. Runs inside the transaction that ends the raising Attempt.
 */
import { schema, type Tx } from '@factory/db';
import { dependentsToCancel, faultFindingsFeedback, TaskStateSchema } from '@factory/domain';
import { asc, eq, sql } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { stepTask, type StageRunStepper } from './engine.js';
import type { FaultRouteInput } from './fault-route.js';
import { cancelTaskItems } from './plans.js';
import { isPendingReplan, requestReplanIn } from './replan.js';

/**
 * Cancels `task` (just failed its review in `attemptId`) and its dependents,
 * one `task.cancelled` each (`cancel_reason` `replan`), cancels their open
 * Inbox Items, then asks for a Replan with the blocking `plan` Findings as
 * its feedback, unless one is already pending.
 */
export function routeToPlanning(
  tx: Tx,
  artifacts: Pick<ArtifactStore, 'writeContent' | 'record'>,
  op: { jobId: string; actor: string },
  input: FaultRouteInput,
  step: StageRunStepper,
): void {
  const { task } = input;
  stepTask(tx, op, task, 'cancelled', {
    reason: 'fault_origin_plan',
    cancelReason: 'replan',
    payload: { route: 'plan', attemptId: input.attemptId, headSha: input.headSha },
  });
  cancelTaskItems(tx, op, task.id);
  const rows = tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, op.jobId))
    .orderBy(asc(sql`rowid`))
    .all();
  const edges = tx
    .select({ taskId: schema.taskDependencies.taskId, on: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.jobId, op.jobId))
    .all();
  const doomed = dependentsToCancel(
    task.id,
    rows.map((t) => ({
      id: t.id,
      state: TaskStateSchema.parse(t.state),
      dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.on),
    })),
  );
  for (const id of doomed) {
    const row = rows.find((t) => t.id === id);
    if (row === undefined) continue;
    stepTask(tx, op, row, 'cancelled', {
      reason: 'fault_origin_plan',
      cancelReason: 'replan',
      payload: { route: 'plan', raisedBy: task.key, raisedByTaskId: task.id },
    });
    cancelTaskItems(tx, op, id);
  }

  try {
    requestReplanIn(
      tx,
      artifacts,
      {
        jobId: op.jobId,
        feedback: faultFindingsFeedback(
          'plan',
          { taskKey: task.key, attemptN: input.attemptN },
          input.findings,
        ),
        actor: op.actor,
        approvalId: null,
      },
      step,
    );
  } catch (error) {
    // Refused before anything is written: the pending Replan re-plans these Tasks too.
    // A Replan already pending covers this one, as does a pending re-specification,
    // whose approval replans (ADR-0031).
    if (isPendingReplan(error)) return;
    throw error;
  }
}
