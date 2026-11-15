/**
 * The cancel cleanup questions (PRODUCT_SPEC §12, ADR-0027 extended by
 * ADR-0043): one item asks, separately and each defaulting to keep, whether to
 * discard the preserved Worktrees, close the PR and delete the remote branch.
 * Only an explicit answer does anything. Pure; tested through `@factory/domain`.
 */
import {
  checkCleanupAnswers,
  cleanupChoices,
  cleanupQuestions,
  untrackedComment,
  carriesFactoryMarker,
  type CleanupScope,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const WITH_PR: CleanupScope = {
  preservedWorktrees: 2,
  openPullRequests: ['acme/tiny-ts#1'],
  remoteBranches: ['factory/job_1/integration'],
};

describe('the questions a cancel cleanup asks', () => {
  it('a Job with preserved Worktrees and an open PR is asked three questions, each defaulting to keep', () => {
    const questions = cleanupQuestions(WITH_PR);
    expect(questions.map((q) => [q.id, q.options, q.recommended, q.blocking])).toEqual([
      ['worktrees', ['keep', 'discard'], 'keep', false],
      ['pull_request', ['keep', 'close'], 'keep', false],
      ['remote_branch', ['keep', 'delete'], 'keep', false],
    ]);
    // The factory asks them, not an agent.
    expect(questions.every((q) => !q.agentProposed && q.source === 'cleanup')).toBe(true);
    expect(questions[0]?.text).toBe('Discard the 2 preserved Worktrees?');
    expect(questions[1]?.text).toContain('acme/tiny-ts#1');
    expect(questions[2]?.text).toContain('factory/job_1/integration');
  });

  it('asks only what applies: no PR (Phase B) asks only about the Worktrees; nothing to ask, no question', () => {
    expect(
      cleanupQuestions({ preservedWorktrees: 1, openPullRequests: [], remoteBranches: [] }).map(
        (q) => q.id,
      ),
    ).toEqual(['worktrees']);
    expect(
      cleanupQuestions({
        preservedWorktrees: 0,
        openPullRequests: [],
        remoteBranches: ['factory/job_1/integration'],
      }).map((q) => q.id),
    ).toEqual(['remote_branch']);
    expect(
      cleanupQuestions({ preservedWorktrees: 0, openPullRequests: [], remoteBranches: [] }),
    ).toEqual([]);
  });
});

describe('answering the cleanup questions', () => {
  const questions = cleanupQuestions(WITH_PR);

  it('takes any subset of offered options; an unanswered question keeps', () => {
    expect(checkCleanupAnswers(questions, [])).toBeUndefined();
    expect(
      checkCleanupAnswers(questions, [
        { questionId: 'pull_request', option: 'close' },
        { questionId: 'remote_branch', option: 'delete' },
      ]),
    ).toBeUndefined();
  });

  it('refuses free text, an option not offered, an unknown or repeated question', () => {
    expect(
      checkCleanupAnswers(questions, [{ questionId: 'worktrees', text: 'yes please' }]),
    ).toMatchObject({ code: 'invalid_answer' });
    expect(
      checkCleanupAnswers(questions, [{ questionId: 'worktrees', option: 'delete' }]),
    ).toMatchObject({ code: 'invalid_answer' });
    expect(checkCleanupAnswers(questions, [{ questionId: 'tasks', option: 'keep' }])).toMatchObject(
      { code: 'unknown_question' },
    );
    expect(
      checkCleanupAnswers(questions, [
        { questionId: 'worktrees', option: 'keep' },
        { questionId: 'worktrees', option: 'discard' },
      ]),
    ).toMatchObject({ code: 'invalid_answer' });
  });

  it('refuses deleting the remote branch of a PR kept open (GitHub would close it)', () => {
    expect(
      checkCleanupAnswers(questions, [{ questionId: 'remote_branch', option: 'delete' }]),
    ).toMatchObject({ code: 'invalid_answer', message: expect.stringMatching(/close/) as string });
    // With no open PR to keep, deleting the branch alone is fine.
    const noPr = cleanupQuestions({ ...WITH_PR, openPullRequests: [] });
    expect(
      checkCleanupAnswers(noPr, [{ questionId: 'remote_branch', option: 'delete' }]),
    ).toBeUndefined();
  });
});

describe('what a cleanup decision does', () => {
  it('each answer has exactly its effect; anything unanswered is kept', () => {
    expect(
      cleanupChoices({
        option: 'answer',
        comment: null,
        answers: [{ questionId: 'pull_request', option: 'close' }],
      }),
    ).toEqual({ discardWorktrees: false, closePullRequests: true, deleteRemoteBranches: false });
    expect(cleanupChoices({ option: 'answer', comment: null, answers: [] })).toEqual({
      discardWorktrees: false,
      closePullRequests: false,
      deleteRemoteBranches: false,
    });
    expect(
      cleanupChoices({
        option: 'answer',
        comment: null,
        answers: [
          { questionId: 'worktrees', option: 'discard' },
          { questionId: 'pull_request', option: 'close' },
          { questionId: 'remote_branch', option: 'delete' },
        ],
      }),
    ).toEqual({ discardWorktrees: true, closePullRequests: true, deleteRemoteBranches: true });
  });

  it('an item decided before the questions (keep | discard, ADR-0027) still means what it said', () => {
    expect(cleanupChoices({ option: 'discard', comment: null })).toEqual({
      discardWorktrees: true,
      closePullRequests: false,
      deleteRemoteBranches: false,
    });
    expect(cleanupChoices({ option: 'keep', comment: null })).toEqual({
      discardWorktrees: false,
      closePullRequests: false,
      deleteRemoteBranches: false,
    });
  });
});

describe('the comment on a PR the factory stops tracking', () => {
  it('is marked, says tracking stopped, and whether the PR was closed or kept', () => {
    const closed = untrackedComment('job_1', { closed: true });
    const kept = untrackedComment('job_1', { closed: false });
    expect(carriesFactoryMarker(closed)).toBe(true);
    expect(closed).toContain('<!-- factory:job_1:untracked -->');
    expect(closed).toMatch(/stopped tracking/);
    expect(closed).toMatch(/closed/);
    expect(kept).toMatch(/left open/);
  });
});
