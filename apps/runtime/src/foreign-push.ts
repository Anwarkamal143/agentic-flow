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
import { ForeignCommitsSchema, type Blocker, type ForeignCommit } from '@factory/domain';
import { and, asc, eq, lte } from 'drizzle-orm';
import { changeJob, stepTask, type JobState, type StageRunStepper } from './engine.js';
import { settleIntegration } from './integration.js';
import { releaseAttemptTokens } from './worktree.js';
import { newId } from './ids.js';
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
  /** `dropped`: the approved commits an adopted rewrite dropped instead (ADR-0042). */
  which: 'foreign' | 'dropped' = 'foreign',
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
    const json = which === 'foreign' ? a.foreignCommitsJson : a.droppedCommitsJson;
    if (json === null) continue;
    for (const c of ForeignCommitsSchema.parse(JSON.parse(json))) {
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

/**
 * Blocks the `claimed` Integration Task whose fetched foreign head rewrote the
 * Integration Branch (it no longer holds the approved head), in one
 * transaction: the human Blocker `foreign_push_rewrite` (its Blocker
 * Approval, adopt the rewrite or cancel the Job, opened by `stepTask`), the
 * rewrite recorded as the head to adopt, the lease and tokens released, and
 * `integration_review` settled. No Attempt is made and nothing is checked out
 * or pushed: the Blocker names the Task itself as its subject (ADR-0034).
 */
export function blockOnForeignRewrite(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  rewrite: { approvedHeadSha: string; rewriteSha: string; dropped: number; branch: string },
): void {
  changeJob(
    db,
    { jobId: op.jobId, expectedVersion: 'current', actor: op.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'claimed') {
        throw new Error(`Task ${taskId} is ${String(task?.state)}, not claimed`);
      }
      const blocker: Blocker = {
        kind: 'human',
        reason: 'foreign_push_rewrite',
        detail: `someone else rewrote ${rewrite.branch} to ${rewrite.rewriteSha}, which no longer holds the approved head ${rewrite.approvedHeadSha}: adopting it drops ${String(rewrite.dropped)} approved commit(s)`,
        requiredAction:
          'decide the Blocker Approval in the Inbox: adopt the rewrite (it is verified and reviewed, and the dropped commits are listed) or cancel the Job',
        taskId,
        attemptId: taskId,
        createdAt: new Date().toISOString(),
      };
      stepTask(tx, op, task, 'blocked', {
        reason: blocker.reason,
        payload: {
          foreignPush: true,
          approvedHeadSha: rewrite.approvedHeadSha,
          rewriteSha: rewrite.rewriteSha,
          dropped: rewrite.dropped,
        },
        blocker,
      });
      // The head a human's adopt_rewrite approves: the one this Blocker names.
      tx.update(schema.tasks)
        .set({ foreignHeadSha: rewrite.rewriteSha })
        .where(eq(schema.tasks.id, taskId))
        .run();
      releaseAttemptTokens(tx, taskId, undefined);
      settleIntegration(tx, state, step);
    },
  );
}

/**
 * `adopt_rewrite` on a `foreign_push_rewrite` Blocker (ADR-0042), in the
 * deciding transaction: the human approves the rewrite the Blocker names, and
 * the Task goes `ready` for the `foreign_push` Attempt that adopts it.
 */
export function approveForeignRewrite(
  tx: Tx,
  input: {
    task: typeof schema.tasks.$inferSelect;
    blocker: Blocker;
    approvalId: string;
    actor: string;
  },
): void {
  const { task, blocker, approvalId, actor } = input;
  if (blocker.reason !== 'foreign_push_rewrite' || task.foreignHeadSha === null) {
    throw new Error(`a ${blocker.reason} Blocker offers no adopt_rewrite`);
  }
  tx.update(schema.tasks)
    .set({ foreignRewriteApprovedSha: task.foreignHeadSha })
    .where(eq(schema.tasks.id, task.id))
    .run();
  // Approving a rewrite of a published Integration Branch is audited, as a cap raise is.
  const auditId = newId('aud');
  const policyRef = `inbox:${approvalId}/adopt_rewrite`;
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: new Date().toISOString(),
      actor,
      action: 'integration_rewrite.adopted',
      target: `task:${task.id}`,
      jobId: task.jobId,
      beforeJson: JSON.stringify({ foreignRewriteApprovedSha: null }),
      afterJson: JSON.stringify({ foreignRewriteApprovedSha: task.foreignHeadSha }),
      policyRef,
      correlationId: approvalId,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'task',
    entityId: task.id,
    jobId: task.jobId,
    type: 'audit.recorded',
    actor,
    payload: {
      auditId,
      action: 'integration_rewrite.adopted',
      rewriteSha: task.foreignHeadSha,
      policyRef,
    },
  });
  stepTask(tx, { jobId: task.jobId, actor }, task, 'ready', {
    reason: 'rewrite_adopted',
    payload: { approvalId, rewriteSha: task.foreignHeadSha },
  });
}
