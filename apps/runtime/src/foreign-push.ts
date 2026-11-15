/**
 * Foreign pushes to the Integration Branch (#63, ADR-0042; Phase C grilling
 * Q26). Someone other than the factory pushed to `factory/<job-id>/integration`
 * on GitHub: the poller sees a PR head that is not the last one the factory
 * pushed. The factory never overwrites it:
 *
 * - every Gate result for the old head is stale: the `merge` items and
 *   `merge_approval` are superseded, and new `integration_review`,
 *   `pull_request`, `merge_approval` (and `merge`, when it had started) Stage
 *   Runs follow at `attempt + 1` ({@link startForeignPushAdoption});
 * - the approved Integration Task's next Attempt (cause `foreign_push`, no
 *   Harness) fetches that head from GitHub, moves the Integration Branch to it,
 *   and verifies it as the factory's own: the path-scope Gate over the union of
 *   the Plan Tasks' writable globs, every command, then the Integration Review,
 *   which always runs again (nothing is re-anchored);
 * - a foreign commit outside that scope fails the path-scope Gate, and a human
 *   decides through the `foreign_push_out_of_scope` Blocker.
 *
 * The foreign commits are listed in the PR body and the Delivery Report. Every
 * later factory push fast-forwards from that head.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import { ForeignCommitsSchema, type ForeignCommit } from '@factory/domain';
import { and, asc, eq, lte } from 'drizzle-orm';
import { stepTask, type JobState, type StageRunStepper } from './engine.js';
import { passedAttemptOf, rerunDeliveryStages, staleGateResults } from './base-change.js';
import { latestStageRun } from './replan.js';

/**
 * Whether `headSha`, the PR head GitHub reported, is a foreign push to the
 * approved Integration Task's branch (read-only): the Task is approved and
 * `headSha` is neither the head the factory last pushed nor the approved one.
 */
export function foreignPushed(
  db: FactoryDb | Tx,
  input: { taskId: string; pushedSha: string; headSha: string },
): boolean {
  if (input.headSha === input.pushedSha) return false;
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, input.taskId)).get();
  if (task?.kind !== 'integration' || task.state !== 'approved') return false;
  const approved = passedAttemptOf(db, input.taskId);
  return approved !== undefined && approved.headSha !== input.headSha;
}

/**
 * Someone else pushed `foreignHeadSha` to the Integration Branch (#63): in the
 * caller's versioned Job transaction, every Gate result for the approved head
 * goes stale and the delivery Stages re-run at `attempt + 1` (reason
 * `foreign_push`). The Task goes `approved → changes_requested → ready` with
 * `tasks.foreign_head_sha` set, so its next Attempt fetches and verifies the
 * foreign head. `false` (nothing changes) when it is not a foreign push.
 */
export function startForeignPushAdoption(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: { taskId: string; pushedSha: string; foreignHeadSha: string; actor: string },
): boolean {
  const { taskId, foreignHeadSha, actor } = input;
  if (!foreignPushed(tx, { taskId, pushedSha: input.pushedSha, headSha: foreignHeadSha })) {
    return false;
  }
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  const approved = passedAttemptOf(tx, taskId);
  if (task === undefined || approved === undefined) return false;
  if (latestStageRun(state, 'integration_review') === undefined) return false;
  const jobId = task.jobId;
  const reason = `someone else pushed ${foreignHeadSha} to the Integration Branch over ${input.pushedSha}, the head the factory pushed: every Gate result for head ${approved.headSha} is stale, and the factory fetches the foreign head and verifies and reviews it, never overwriting it`;
  const added = rerunDeliveryStages(tx, state, step, {
    jobId,
    actor,
    reason,
    cause: 'foreign_push',
  });
  const op = { jobId, actor };
  const sent = stepTask(tx, op, task, 'changes_requested', {
    reason: 'foreign_push',
    payload: { pushedSha: input.pushedSha, foreignHeadSha },
  });
  stepTask(tx, op, sent, 'ready', {
    reason: 'foreign_push',
    payload: { foreignPush: true, foreignHeadSha },
  });
  tx.update(schema.tasks).set({ foreignHeadSha }).where(eq(schema.tasks.id, taskId)).run();
  appendEvent(tx, {
    entityKind: 'task',
    entityId: taskId,
    jobId,
    type: 'task.foreign_push',
    actor,
    payload: {
      pushedSha: input.pushedSha,
      approvedHeadSha: approved.headSha,
      foreignHeadSha,
      stale: staleGateResults(tx, approved),
      stageRuns: added,
    },
  });
  return true;
}

/**
 * The foreign commits of the Integration Task `taskId` up to Attempt `uptoN`
 * (every one when omitted): each `foreign_push` Attempt's, newest Attempt
 * first, each commit once, with the Attempt that fetched and verified it.
 */
export function foreignCommitsOf(
  db: FactoryDb | Tx,
  taskId: string,
  uptoN?: number,
): (ForeignCommit & { attemptId: string; attemptState: string })[] {
  const rows = db
    .select()
    .from(schema.attempts)
    .where(
      and(
        eq(schema.attempts.taskId, taskId),
        eq(schema.attempts.cause, 'foreign_push'),
        ...(uptoN === undefined ? [] : [lte(schema.attempts.n, uptoN)]),
      ),
    )
    .orderBy(asc(schema.attempts.n))
    .all();
  const seen = new Set<string>();
  const out: (ForeignCommit & { attemptId: string; attemptState: string })[] = [];
  for (const a of rows.reverse()) {
    if (a.foreignCommitsJson === null) continue;
    for (const c of ForeignCommitsSchema.parse(JSON.parse(a.foreignCommitsJson))) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      out.push({ ...c, attemptId: a.id, attemptState: a.state });
    }
  }
  return out;
}

/** The foreign heads `foreign_push` Attempts of `taskId` fetched (ADR-0042): a push from one is a fast-forward. */
export function foreignHeadsOf(db: FactoryDb | Tx, taskId: string): string[] {
  return db
    .select({ headSha: schema.attempts.headSha })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, taskId), eq(schema.attempts.cause, 'foreign_push')))
    .all()
    .flatMap((a) => (a.headSha === null ? [] : [a.headSha]));
}
