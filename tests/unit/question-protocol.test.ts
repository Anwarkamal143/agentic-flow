/**
 * The question protocol (ARCHITECTURE §7 Question rules, §8; ADR-0023): which
 * Task Results ask a human, which contradict themselves, how the questions
 * are batched into one Inbox Question, which answers are accepted, and how
 * answer Attempts are capped apart from Rework. Pure; tested through
 * `@factory/domain`.
 */
import {
  attemptsCountedForRework,
  checkAnswers,
  inboxQuestionsOf,
  questionProtocolIssues,
  questionRoute,
  resultAsks,
  ReviewPacketSchema,
  ReviewProposalSchema,
  type InboxQuestion,
  type TaskResult,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const base: TaskResult = { status: 'done', summary: 's', commits: [], criteria: [] };
const blocking = { text: 'Which rounding?', options: ['up', 'down'], blocking: true };
const optional = { text: 'Also add a JSDoc?', blocking: false };

describe('a Task Result that contradicts the question protocol', () => {
  it('needs_decision with no blocking question is a violation', () => {
    const issues = questionProtocolIssues({
      ...base,
      status: 'needs_decision',
      questions: [optional],
    });
    expect(issues.map((i) => i.rule)).toEqual(['questions.blocking_required']);
    expect(questionProtocolIssues({ ...base, status: 'needs_decision' })).toHaveLength(1);
  });

  it('done with a blocking question is a violation', () => {
    const issues = questionProtocolIssues({ ...base, questions: [blocking, optional] });
    expect(issues.map((i) => i.rule)).toEqual(['questions.done_with_blocking']);
  });

  it('needs_decision with a blocking question, and done with only optional ones, are fine', () => {
    expect(
      questionProtocolIssues({ ...base, status: 'needs_decision', questions: [blocking] }),
    ).toEqual([]);
    expect(questionProtocolIssues({ ...base, questions: [optional] })).toEqual([]);
    expect(questionProtocolIssues(base)).toEqual([]);
  });

  it('a scope change request stands for a blocking question', () => {
    const scope = { paths: ['src/other.ts'], reason: 'sum() needs a helper there' };
    expect(
      questionProtocolIssues({ ...base, status: 'needs_decision', scopeChangeRequest: scope }),
    ).toEqual([]);
    expect(resultAsks({ ...base, scopeChangeRequest: scope })).toBe(true);
  });
});

describe('a Task Result that asks', () => {
  it('asks with needs_decision or a scope change request, never with done alone', () => {
    expect(resultAsks({ ...base, status: 'needs_decision', questions: [blocking] })).toBe(true);
    expect(resultAsks({ ...base, questions: [optional] })).toBe(false);
    expect(resultAsks({ ...base, status: 'failed' })).toBe(false);
  });

  it('is batched into one list: blocking and optional questions, then the scope request, all agent-proposed', () => {
    const questions = inboxQuestionsOf({
      ...base,
      status: 'needs_decision',
      questions: [optional, { ...blocking, recommended: 'up' }],
      scopeChangeRequest: { paths: ['src/other.ts'], reason: 'needs a helper' },
    });
    expect(questions).toEqual([
      {
        id: 'q1',
        source: 'question',
        text: 'Also add a JSDoc?',
        options: [],
        recommended: null,
        blocking: false,
        agentProposed: true,
        paths: [],
      },
      {
        id: 'q2',
        source: 'question',
        text: 'Which rounding?',
        options: ['up', 'down'],
        recommended: 'up',
        blocking: true,
        agentProposed: true,
        paths: [],
      },
      {
        id: 'scope',
        source: 'scope_change_request',
        text: expect.stringContaining('needs a helper') as unknown as string,
        options: [],
        recommended: null,
        blocking: true,
        agentProposed: true,
        paths: ['src/other.ts'],
      },
    ]);
  });

  it('drops a recommendation that is not one of its options', () => {
    const [q] = inboxQuestionsOf({
      ...base,
      status: 'needs_decision',
      questions: [{ ...blocking, recommended: 'sideways' }],
    });
    expect(q?.recommended).toBeNull();
  });
});

describe('answers to an Inbox Question', () => {
  const questions: InboxQuestion[] = inboxQuestionsOf({
    ...base,
    status: 'needs_decision',
    questions: [blocking, optional],
  });

  it('are accepted when every blocking question has one option or free text', () => {
    expect(checkAnswers(questions, [{ questionId: 'q1', option: 'down' }])).toBeUndefined();
    expect(
      checkAnswers(questions, [
        { questionId: 'q1', text: 'Round half to even' },
        { questionId: 'q2', text: 'yes' },
      ]),
    ).toBeUndefined();
  });

  it('are refused when a blocking question is left unanswered', () => {
    const refusal = checkAnswers(questions, [{ questionId: 'q2', text: 'yes' }]);
    expect(refusal?.code).toBe('answer_missing');
    expect(refusal?.message).toContain('q1');
  });

  it('are refused for an unknown or repeated question, or an option the question does not offer', () => {
    expect(checkAnswers(questions, [{ questionId: 'q9', text: 'x' }])).toMatchObject({
      code: 'unknown_question',
    });
    expect(
      checkAnswers(questions, [
        { questionId: 'q1', option: 'up' },
        { questionId: 'q1', option: 'down' },
      ]),
    ).toMatchObject({ code: 'invalid_answer' });
    expect(checkAnswers(questions, [{ questionId: 'q1', option: 'sideways' }])).toMatchObject({
      code: 'invalid_answer',
    });
  });

  it('are refused with both an option and text, or neither, or blank text', () => {
    expect(
      checkAnswers(questions, [{ questionId: 'q1', option: 'up', text: 'and more' }]),
    ).toMatchObject({ code: 'invalid_answer' });
    expect(checkAnswers(questions, [{ questionId: 'q1' }])).toMatchObject({
      code: 'invalid_answer',
    });
    expect(checkAnswers(questions, [{ questionId: 'q1', text: '   ' }])).toMatchObject({
      code: 'invalid_answer',
    });
  });
});

describe('answer Attempts are capped by maxQuestions, apart from Rework and Retry', () => {
  it('opens a Question while answer Attempts are left, and stops at the cap', () => {
    expect(questionRoute({ answerAttemptsUsed: 0, maxQuestions: 3 })).toEqual({ kind: 'ask' });
    expect(questionRoute({ answerAttemptsUsed: 2, maxQuestions: 3 })).toEqual({ kind: 'ask' });
    expect(questionRoute({ answerAttemptsUsed: 3, maxQuestions: 3 })).toMatchObject({
      kind: 'blocked',
      blocker: { kind: 'human', reason: 'question_cap_reached' },
    });
    expect(questionRoute({ answerAttemptsUsed: 0, maxQuestions: 0 })).toMatchObject({
      kind: 'blocked',
    });
  });

  it('an answer Attempt never counts toward the Rework cap', () => {
    expect(
      attemptsCountedForRework([
        { cause: 'initial' },
        { cause: 'answer' },
        { cause: 'retry' },
        { cause: 'rework' },
      ]),
    ).toBe(2);
  });
});

describe('only the developer may ask', () => {
  it('the reviewer has no way to ask: its packet has no protocol and its output no questions', () => {
    expect(Object.keys(ReviewPacketSchema.shape)).not.toContain('protocol');
    expect(Object.keys(ReviewProposalSchema.shape)).not.toContain('questions');
    expect(Object.keys(ReviewProposalSchema.shape)).not.toContain('status');
  });
});
