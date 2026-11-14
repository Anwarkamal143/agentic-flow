/**
 * The question protocol (ARCHITECTURE §7 Question rules, §8; ADR-0023): a
 * developer may end an Attempt with `needs_decision` and its questions; the
 * factory batches them into one Inbox Question, a human answers each, and a
 * fresh Attempt (`cause: answer`) carries the answers. Everything a question
 * says is agent output: it is shown as agent-proposed and never grants a
 * permission. No I/O.
 */
import { z } from 'zod';
import type { TaskResult } from './execution.js';
import type { RuleIssue } from './proposals.js';
import type { Blocker } from './rework.js';

/** One question of an Inbox Question, as the agent asked it (redacted when stored). */
export const InboxQuestionSchema = z.object({
  /** `q1`, `q2`, … in the Task Result's order; `scope` for a scope change request. */
  id: z.string(),
  source: z.enum(['question', 'scope_change_request']),
  text: z.string(),
  /** The agent's proposed answers; a human may also answer in free text. */
  options: z.array(z.string()),
  /** One of `options`, or `null`. */
  recommended: z.string().nullable(),
  /** A blocking question must be answered; a non-blocking one is optional. */
  blocking: z.boolean(),
  /** Always `true`: the question and its options come from an agent. */
  agentProposed: z.literal(true),
  /** For a scope change request: the paths the agent asked for (never granted). */
  paths: z.array(z.string()),
});
export type InboxQuestion = z.infer<typeof InboxQuestionSchema>;

/** One answer: an offered option, or free text. */
export const QuestionAnswerSchema = z.object({
  questionId: z.string().min(1).max(40),
  option: z.string().max(5000).optional(),
  text: z.string().max(5000).optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/** `POST /v1/inbox/:id/answer` (`answerQuestion`). */
export const AnswerQuestionInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  /** The asking Attempt (the item's subject). */
  subjectRef: z.string().min(1),
  answers: z.array(QuestionAnswerSchema).max(50),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>;

/** A question and its answer, as a later Attempt's Task Packet carries it. */
export const AnsweredQuestionSchema = z.object({
  /** The Attempt that asked it. */
  attemptN: z.number().int().positive(),
  questionId: z.string(),
  source: InboxQuestionSchema.shape.source,
  question: z.string(),
  blocking: z.boolean(),
  /** `null`: an optional question the human left unanswered. */
  answer: z.string().nullable(),
  answeredWith: z.enum(['option', 'text']).nullable(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

/** Whether the Task Result asks a human: `needs_decision`, or any scope change request. */
export function resultAsks(result: TaskResult): boolean {
  return result.status === 'needs_decision' || result.scopeChangeRequest !== undefined;
}

/**
 * Where a Task Result contradicts the question protocol (ADR-0010's one
 * re-prompt follows): `needs_decision` with nothing blocking to decide, or
 * `done` with a blocking question. A scope change request counts as blocking.
 */
export function questionProtocolIssues(result: TaskResult): RuleIssue[] {
  const blocking =
    (result.questions ?? []).some((q) => q.blocking) || result.scopeChangeRequest !== undefined;
  if (result.status === 'needs_decision' && !blocking) {
    return [
      {
        rule: 'questions.blocking_required',
        message:
          'status needs_decision needs at least one question with blocking: true (or a scopeChangeRequest); finish the work with status done otherwise',
      },
    ];
  }
  if (result.status === 'done' && (result.questions ?? []).some((q) => q.blocking)) {
    return [
      {
        rule: 'questions.done_with_blocking',
        message:
          'status done can carry only non-blocking questions; use status needs_decision to wait for an answer, or mark the question blocking: false',
      },
    ];
  }
  return [];
}

/**
 * The Task Result's questions as the factory keeps them: every question in
 * order (`q1`…), then the scope change request (`scope`), each agent-proposed.
 */
export function inboxQuestionsOf(result: TaskResult): InboxQuestion[] {
  const questions: InboxQuestion[] = (result.questions ?? []).map((q, i) => {
    const options = q.options ?? [];
    return {
      id: `q${String(i + 1)}`,
      source: 'question',
      text: q.text,
      options,
      recommended:
        q.recommended !== undefined && options.includes(q.recommended) ? q.recommended : null,
      blocking: q.blocking,
      agentProposed: true,
      paths: [],
    };
  });
  const scope = result.scopeChangeRequest;
  if (scope !== undefined) {
    questions.push({
      id: 'scope',
      source: 'scope_change_request',
      text: `The developer asks to change paths outside its scope (${scope.paths.join(', ') || 'none named'}): ${scope.reason}. The scope never changes mid-Plan: answer with guidance that works within it.`,
      options: [],
      recommended: null,
      blocking: true,
      agentProposed: true,
      paths: scope.paths,
    });
  }
  return questions;
}

export interface AnswerRefusal {
  code: 'answer_missing' | 'unknown_question' | 'invalid_answer';
  message: string;
}

/**
 * Why a set of answers is refused, or `undefined` when it is accepted: each
 * blocking question answered, each answer one offered option or non-blank
 * free text (not both), each question at most once. Pure.
 */
export function checkAnswers(
  questions: readonly InboxQuestion[],
  answers: readonly QuestionAnswer[],
): AnswerRefusal | undefined {
  const seen = new Set<string>();
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (q === undefined) {
      return {
        code: 'unknown_question',
        message: `no question '${a.questionId}'; the item asks ${questions.map((x) => x.id).join(', ')}`,
      };
    }
    if (seen.has(a.questionId)) {
      return { code: 'invalid_answer', message: `question ${a.questionId} is answered twice` };
    }
    seen.add(a.questionId);
    const hasOption = a.option !== undefined;
    const hasText = a.text !== undefined;
    if (hasOption === hasText) {
      return {
        code: 'invalid_answer',
        message: `answer question ${a.questionId} with one option or free text, not ${hasOption ? 'both' : 'neither'}`,
      };
    }
    if (hasOption && !q.options.includes(a.option ?? '')) {
      return {
        code: 'invalid_answer',
        message: `question ${q.id} offers no option '${a.option ?? ''}'${q.options.length === 0 ? ' (answer it in free text)' : `; it offers ${q.options.join(', ')}`}`,
      };
    }
    if (hasText && (a.text ?? '').trim() === '') {
      return { code: 'invalid_answer', message: `the answer to question ${q.id} is blank` };
    }
  }
  const missing = questions.filter((q) => q.blocking && !seen.has(q.id)).map((q) => q.id);
  if (missing.length > 0) {
    return {
      code: 'answer_missing',
      message: `every blocking question needs an answer; unanswered: ${missing.join(', ')}`,
    };
  }
  return undefined;
}

/** The questions with their answers, for the next Attempt's packet. Pure. */
export function answeredQuestions(
  attemptN: number,
  questions: readonly InboxQuestion[],
  answers: readonly QuestionAnswer[],
): AnsweredQuestion[] {
  return questions.map((q) => {
    const a = answers.find((x) => x.questionId === q.id);
    return {
      attemptN,
      questionId: q.id,
      source: q.source,
      question: q.text,
      blocking: q.blocking,
      answer: a === undefined ? null : (a.option ?? a.text ?? null),
      answeredWith: a === undefined ? null : a.option !== undefined ? 'option' : 'text',
    };
  });
}

export type QuestionRoute =
  | { kind: 'ask' }
  | { kind: 'blocked'; blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'> };

/**
 * Whether an Attempt that asks opens an Inbox Question, or stops at the
 * `max_questions` cap (answer Attempts only; Rework and Retries don't count).
 */
export function questionRoute(input: {
  answerAttemptsUsed: number;
  maxQuestions: number;
}): QuestionRoute {
  if (input.answerAttemptsUsed < input.maxQuestions) return { kind: 'ask' };
  return {
    kind: 'blocked',
    blocker: {
      kind: 'human',
      reason: 'question_cap_reached',
      detail: `the developer asked again after ${String(input.answerAttemptsUsed)} of at most ${String(input.maxQuestions)} answer Attempts (maxQuestions), so no Question is opened`,
      requiredAction:
        'look at the Attempts and their questions, then decide the Blocker Approval in the Inbox: grant more answer Attempts (the Question reopens) or cancel the Job',
    },
  };
}
