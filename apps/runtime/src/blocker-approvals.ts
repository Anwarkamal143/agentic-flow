/**
 * Blocker Approvals (ARCHITECTURE §8.1, ADR-0026): the Inbox Approval a human
 * Blocker opens, in the transaction that sets the Blocker, and the pieces its
 * decisions are made of: an audited cap raise, the guidance a grant carries
 * into later Attempts, and the Task's Blocker replaced when a question grant
 * reopens its Question. Everything here runs inside the caller's transaction
 * and moves no Task state (the engine and the Inbox do), so the engine can
 * call it without an import cycle.
 */
import { appendEvent, schema, type Tx } from '@factory/db';
import {
  blockerItemTitle,
  blockerOptions,
  blockerRecommended,
  InboxDecisionSchema,
  TaskPacketSchema,
  type ApprovalKind,
  type Blocker,
  type ExpiresPolicy,
  type GrantGuidance,
} from '@factory/domain';
import { and, eq, sql } from 'drizzle-orm';
import { newId } from './ids.js';
import { latestStageRunOfTask } from './task-stage.js';

/**
 * Opens the Blocker Approval of `blocker` when its reason has one (§8.1), or
 * does nothing. Its subject is the Attempt whose end raised the Blocker, it
 * holds the Stage Run of the Stage the Task runs in, and it names the Task. Called by
 * `stepTask` whenever a Task goes `blocked`, so no Blocker path can miss it.
 */
export function openBlockerItem(
  tx: Tx,
  op: { jobId: string; actor: string },
  task: { id: string; key: string; kind?: string },
  blocker: Blocker,
  /** The Stage Run it holds when that is not the Task's own Stage (the `merge` Stage, ADR-0038). */
  opts: { stageRunId?: string } = {},
): string | undefined {
  const options = blockerOptions(blocker.reason);
  if (options === undefined) return undefined;
  // The Stage the Task runs in: `execution`, or `integration` for the Integration Task.
  const execution =
    opts.stageRunId === undefined
      ? latestStageRunOfTask(tx, op.jobId, task.id)
      : { id: opts.stageRunId };
  const id = newId('apr');
  const kind: ApprovalKind = 'blocker';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: op.jobId,
      taskId: task.id,
      stageRunId: execution?.id ?? null,
      kind,
      subjectRef: blocker.attemptId,
      question: blockerItemTitle(
        task.key,
        blocker.reason,
        task.kind === 'integration' ? 'integration' : 'plan',
      ),
      questionsJson: null,
      why: `${blocker.detail}. ${blocker.requiredAction}.`,
      optionsJson: JSON.stringify(options),
      recommended: blockerRecommended(blocker.reason),
      evidenceJson: '[]',
      state: 'open',
      deferred: false,
      requestedBy: op.actor,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId: op.jobId,
    type: 'approval.opened',
    actor: op.actor,
    payload: {
      kind,
      subjectRef: blocker.attemptId,
      taskId: task.id,
      stageRunId: execution?.id ?? null,
      blocker: blocker.reason,
    },
  });
  return id;
}

/** The Task caps a Blocker Approval can raise. */
export type CapColumn = 'maxAttempts' | 'maxQuestions' | 'maxRetries';

/**
 * Raises one cap of a Task and writes it to `audit_log` (`actor`, the cap
 * before and after, the decision that allowed it) with an `audit.recorded`
 * event, in the caller's transaction.
 */
export function raiseCap(
  tx: Tx,
  input: {
    jobId: string;
    taskId: string;
    cap: CapColumn;
    from: number;
    to: number;
    actor: string;
    approvalId: string;
    option: string;
  },
): void {
  tx.update(schema.tasks)
    .set({ [input.cap]: input.to })
    .where(eq(schema.tasks.id, input.taskId))
    .run();
  const id = newId('aud');
  const target = `task:${input.taskId}`;
  const policyRef = `inbox:${input.approvalId}/${input.option}`;
  tx.insert(schema.auditLog)
    .values({
      id,
      ts: new Date().toISOString(),
      actor: input.actor,
      action: 'cap.raised',
      target,
      jobId: input.jobId,
      beforeJson: JSON.stringify({ [input.cap]: input.from }),
      afterJson: JSON.stringify({ [input.cap]: input.to }),
      policyRef,
      correlationId: input.approvalId,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'task',
    entityId: input.taskId,
    jobId: input.jobId,
    type: 'audit.recorded',
    actor: input.actor,
    payload: {
      auditId: id,
      action: 'cap.raised',
      cap: input.cap,
      from: input.from,
      to: input.to,
      policyRef,
    },
  });
}

/**
 * Replaces a `blocked` Task's Blocker without leaving `blocked` (a question
 * grant turns `question_cap_reached` into `awaiting_human`), and the Blocker
 * its `execution` Stage Run shows, each with its event.
 */
export function replaceBlocker(
  tx: Tx,
  op: { jobId: string; actor: string },
  task: typeof schema.tasks.$inferSelect,
  blocker: Blocker,
): void {
  const json = JSON.stringify(blocker);
  const updated = tx
    .update(schema.tasks)
    .set({ blockerJson: json, version: sql`${schema.tasks.version} + 1` })
    .where(
      and(
        eq(schema.tasks.id, task.id),
        eq(schema.tasks.state, 'blocked'),
        eq(schema.tasks.version, task.version),
      ),
    )
    .run();
  if (updated.changes !== 1)
    throw new Error(`Task ${task.id} changed under a versioned Job operation`);
  appendEvent(tx, {
    entityKind: 'task',
    entityId: task.id,
    jobId: op.jobId,
    type: 'task.blocker_changed',
    actor: op.actor,
    payload: { key: task.key, state: 'blocked', blocker },
  });
  const execution = latestStageRunOfTask(tx, op.jobId, task.id);
  if (
    execution?.blockerJson != null &&
    (JSON.parse(execution.blockerJson) as { taskId?: string }).taskId === task.id
  ) {
    tx.update(schema.stageRuns)
      .set({ blockerJson: json, version: sql`${schema.stageRuns.version} + 1` })
      .where(eq(schema.stageRuns.id, execution.id))
      .run();
    appendEvent(tx, {
      entityKind: 'stage_run',
      entityId: execution.id,
      jobId: op.jobId,
      type: 'stage_run.blocker_changed',
      actor: op.actor,
      payload: { stageId: execution.stageId, state: execution.state, blocker },
    });
  }
}

/**
 * The grant guidance the next Attempt after `previous` carries: what the
 * Attempts before it carried, plus the guidance of a grant (or a Rework with
 * guidance) that cleared `previous`'s own Blocker.
 */
export function guidanceAfter(
  tx: Tx,
  previous: { id: string; n: number; packetJson: string },
): GrantGuidance[] {
  const carried = TaskPacketSchema.parse(JSON.parse(previous.packetJson)).context.guidance;
  const items = tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.kind, 'blocker'),
        eq(schema.approvals.subjectRef, previous.id),
        eq(schema.approvals.state, 'decided'),
      ),
    )
    .all();
  const given = items.flatMap((item): GrantGuidance[] => {
    if (item.decisionJson === null) return [];
    const decision = InboxDecisionSchema.parse(JSON.parse(item.decisionJson));
    // A grant's comment, or "Rework with guidance"'s (ADR-0031), guides the next Attempts.
    const guides = decision.option === 'grant' || decision.option === 'rework';
    if (!guides || decision.comment === null || decision.comment === '') {
      return [];
    }
    return [
      {
        attemptN: previous.n,
        about: item.question,
        text: decision.comment,
        decidedBy: item.decidedBy ?? 'unknown',
        approvalId: item.id,
      },
    ];
  });
  return [...carried, ...given];
}
