/**
 * Ending the `execution` Stage under keep-going (ARCHITECTURE §4.4,
 * ADR-0028): it runs while any Task of the newest Plan is in progress, waits
 * on a Blocker once nothing else is, and fails only when nothing else can
 * make progress. A failed execution still queues `closure`, so the Delivery
 * Report lists the approved Task Branches as partial results.
 */
import { schema, type Tx } from '@factory/db';
import { BlockerSchema, executionOutcome, TaskStateSchema, type Blocker } from '@factory/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { JobState, StageRunStepper } from './engine.js';
import { latestArtifact } from './plan-approval.js';
import { latestStageRun, startRequestedReplan } from './replan.js';

/**
 * Ends `execution` once no Task is in progress: `waiting_human` if a Replan
 * waits at the cap in a `replan_cap_reached` Blocker Approval (ADR-0030);
 * else `waiting_human` or `blocked` if a Task is blocked (the Stage Run carries the first Blocker, human ones
 * first, so the Job shows why); then `failed` if a Task failed (and `closure`
 * queued for the partial results); `succeeded` (and `closure` queued) when
 * every Task is approved. Only the Tasks of the Job's newest Plan count: a
 * Plan replaced at `plan_approval` left its Tasks cancelled, never run
 * (ADR-0019).
 */
export function settleExecution(tx: Tx, state: JobState, step: StageRunStepper): void {
  // A requested Replan starts planning once the last Attempt in flight settles (ADR-0029).
  if (startRequestedReplan(tx, state.job.id, step, 'system:scheduler')) return;
  const execution = latestStageRun(state, 'execution');
  if (execution?.state !== 'running') return;
  const plan = latestArtifact(tx, state.job.id, 'plan');
  const tasks = tx
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.jobId, state.job.id), eq(schema.tasks.planArtifactId, plan?.id ?? '')),
    )
    .orderBy(asc(sql`rowid`))
    .all();
  const outcome = executionOutcome(
    tasks.map((t) => ({
      key: t.key,
      state: TaskStateSchema.parse(t.state),
      blocker: t.blockerJson === null ? null : BlockerSchema.parse(JSON.parse(t.blockerJson)),
    })),
  );
  const queueClosure = () => {
    const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
    if (closure !== undefined) step(closure, 'queued');
  };
  if (outcome.kind !== 'running') {
    // A Replan held at the cap decides what happens to the rest: wait for the human.
    const held = heldReplanBlocker(tx, state.job.id);
    if (held !== undefined) {
      step(execution, 'waiting_human', { blocker: held });
      return;
    }
  }
  switch (outcome.kind) {
    case 'running':
    case 'unchanged':
      return;
    case 'waiting_human':
    case 'blocked':
      step(execution, outcome.kind, { blocker: outcome.blocker });
      return;
    case 'failed':
      step(execution, 'failed', {
        failure: {
          reason: 'task_failed',
          message: `Task ${outcome.failedKeys.join(', ')} failed, with no Rework route; nothing else can make progress`,
          issues: [],
        },
      });
      queueClosure();
      return;
    case 'succeeded':
      step(execution, 'succeeded');
      queueClosure();
      return;
  }
}

/**
 * The Job-level Blocker of a Replan held at `maxReplans` (its open
 * `replan_cap_reached` Approval offers `grant_replan`), or `undefined`. It
 * holds no Task: `taskId` is the Job's id and `attemptId` the held request
 * Artifact, the subject of its Approval (ADR-0030).
 */
function heldReplanBlocker(tx: Tx, jobId: string): Blocker | undefined {
  const item = tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.kind, 'blocker'),
        eq(schema.approvals.state, 'open'),
      ),
    )
    .orderBy(asc(sql`rowid`))
    .all()
    .find((a) => a.optionsJson.includes('"grant_replan"'));
  if (item === undefined) return undefined;
  return {
    kind: 'human',
    reason: 'replan_cap_reached',
    detail: item.why,
    requiredAction: `decide Inbox Item ${item.id}: grant one more Replan, or cancel the Job`,
    taskId: jobId,
    attemptId: item.subjectRef,
    createdAt: item.createdAt,
  };
}
