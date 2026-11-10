/**
 * Questions during execution (ARCHITECTURE §8, ADR-0023): the Inbox Question
 * an Attempt opens when its developer returns `needs_decision`, and the
 * answered questions a later Attempt's Task Packet carries. Everything here
 * runs inside the caller's transaction.
 */
import { appendEvent, schema, type Tx } from '@factory/db';
import {
  answeredQuestions,
  InboxDecisionSchema,
  InboxQuestionSchema,
  questionItemTitle,
  QUESTION_OPTIONS,
  TaskPacketSchema,
  type AnsweredQuestion,
  type ApprovalKind,
  type ExpiresPolicy,
  type InboxQuestion,
} from '@factory/domain';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from './ids.js';

/**
 * Opens the one `question` Inbox Item of an Attempt that asked: its subject is
 * the asking Attempt, it holds the `execution` Stage Run, and its questions
 * are the agent's (redacted on write, shown as agent-proposed). Returns its id.
 */
export function openQuestionItem(
  tx: Tx,
  input: {
    jobId: string;
    taskId: string;
    taskKey: string;
    attemptId: string;
    questions: readonly InboxQuestion[];
    /** Artifact ids backing it (the Task Result). */
    evidence: readonly string[];
    requestedBy: string;
    actor: string;
  },
): string {
  const execution = tx
    .select({ id: schema.stageRuns.id })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.jobId, input.jobId), eq(schema.stageRuns.stageId, 'execution')))
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
  const id = newId('apr');
  const kind: ApprovalKind = 'question';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  const scope = input.questions.some((q) => q.source === 'scope_change_request');
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: input.jobId,
      taskId: input.taskId,
      stageRunId: execution?.id ?? null,
      kind,
      subjectRef: input.attemptId,
      question: questionItemTitle(input.taskKey, input.questions),
      questionsJson: JSON.stringify(input.questions),
      why:
        `The developer of Task ${input.taskKey} ended its Attempt with needs_decision${scope ? ' and a scope change request' : ''}. ` +
        'The Task waits with no process alive; your answers start a fresh Attempt on the same Task Branch. ' +
        'The questions and their options are proposed by an agent, and an answer never widens the scope or grants a permission.',
      optionsJson: JSON.stringify(QUESTION_OPTIONS),
      recommended: null,
      evidenceJson: JSON.stringify(input.evidence),
      state: 'open',
      deferred: false,
      requestedBy: input.requestedBy,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId: input.jobId,
    type: 'approval.opened',
    actor: input.actor,
    payload: {
      kind,
      subjectRef: input.attemptId,
      taskId: input.taskId,
      stageRunId: execution?.id ?? null,
      questions: input.questions.length,
      blocking: input.questions.filter((q) => q.blocking).length,
    },
  });
  return id;
}

/**
 * The answered questions the next Attempt after `previous` carries: those the
 * Attempts before it carried, plus `previous`'s own when its Question was
 * answered.
 */
export function answersAfter(
  tx: Tx,
  previous: { id: string; n: number; packetJson: string },
): AnsweredQuestion[] {
  const carried = TaskPacketSchema.parse(JSON.parse(previous.packetJson)).context.answers;
  const item = tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.kind, 'question'),
        eq(schema.approvals.subjectRef, previous.id),
        eq(schema.approvals.state, 'decided'),
      ),
    )
    .get();
  if (item?.decisionJson == null || item.questionsJson === null) return carried;
  const decision = InboxDecisionSchema.parse(JSON.parse(item.decisionJson));
  const questions = z.array(InboxQuestionSchema).parse(JSON.parse(item.questionsJson));
  return [...carried, ...answeredQuestions(previous.n, questions, decision.answers ?? [])];
}
