/**
 * The `cleanup` Inbox Item a cancel opens (PRODUCT_SPEC §12, ADR-0027,
 * extended by ADR-0043): once everything is stopped, it asks the human about
 * each side effect separately, each defaulting to keep: discard the preserved
 * Worktrees? close the PR? delete the remote branch? Only an explicit answer
 * does anything. Task Branches are always kept locally. No I/O.
 */
import type { ApprovalOption, InboxDecision } from './approvals.js';
import { factoryMarker } from './pr-feedback.js';
import type { InboxQuestion, QuestionAnswer } from './questions.js';

export const CLEANUP_KEEP = 'keep';
export const CLEANUP_DISCARD = 'discard';
export const CLEANUP_CLOSE = 'close';
export const CLEANUP_DELETE = 'delete';

/** The questions' ids. */
export const CLEANUP_WORKTREES = 'worktrees';
export const CLEANUP_PULL_REQUEST = 'pull_request';
export const CLEANUP_REMOTE_BRANCH = 'remote_branch';

/**
 * The one option of a `cleanup` Approval: deciding it per question
 * (`POST /v1/inbox/:id/answer`). A question left unanswered keeps.
 */
export const CLEANUP_OPTIONS: readonly ApprovalOption[] = [
  {
    id: 'answer',
    label: 'Decide each',
    description:
      'Decide each question with one of its options; one you leave unanswered keeps (the default). Only an explicit discard, close or delete does anything. Task Branches are always kept in the Factory Clone.',
    agentProposed: false,
  },
];

/**
 * The options of a `cleanup` item decided before its questions existed
 * (ADR-0027: `keep` | `discard`, about the Worktrees only). Still decidable
 * through the generic decide, and still meaning what they said.
 */
export const LEGACY_CLEANUP_OPTIONS: readonly string[] = [CLEANUP_KEEP, CLEANUP_DISCARD];

/** What a cancel left that a human may clean up. */
export interface CleanupScope {
  /** The Job's `preserved` Worktrees (a quarantined one is never counted). */
  preservedWorktrees: number;
  /** The Job's PRs still open on GitHub, as `owner/name#n`. */
  openPullRequests: readonly string[];
  /** The remote branches the factory pushed for the Job (its Integration Branches). */
  remoteBranches: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;
const list = (items: readonly string[]) => items.join(', ');

function question(id: string, text: string, change: string): InboxQuestion {
  return {
    id,
    source: 'cleanup',
    text,
    options: [CLEANUP_KEEP, change],
    recommended: CLEANUP_KEEP,
    blocking: false,
    agentProposed: false,
    paths: [],
  };
}

/** The questions a `cleanup` item asks: only those that apply, each defaulting to keep. Pure. */
export function cleanupQuestions(scope: CleanupScope): InboxQuestion[] {
  const questions: InboxQuestion[] = [];
  if (scope.preservedWorktrees > 0) {
    questions.push(
      question(
        CLEANUP_WORKTREES,
        `Discard the ${plural(scope.preservedWorktrees, 'preserved Worktree')}?`,
        CLEANUP_DISCARD,
      ),
    );
  }
  if (scope.openPullRequests.length > 0) {
    questions.push(
      question(
        CLEANUP_PULL_REQUEST,
        `Close ${list(scope.openPullRequests)} on GitHub?`,
        CLEANUP_CLOSE,
      ),
    );
  }
  if (scope.remoteBranches.length > 0) {
    questions.push(
      question(
        CLEANUP_REMOTE_BRANCH,
        `Delete the remote branch ${list(scope.remoteBranches)}?`,
        CLEANUP_DELETE,
      ),
    );
  }
  return questions;
}

/** The title and the reason a `cleanup` item shows. Pure. */
export function cleanupItemText(scope: CleanupScope): { question: string; why: string } {
  const asked = cleanupQuestions(scope).length;
  const parts: string[] = [];
  if (scope.preservedWorktrees > 0) {
    parts.push(
      `${plural(scope.preservedWorktrees, 'preserved Worktree')} ${scope.preservedWorktrees === 1 ? 'is' : 'are'} left on disk`,
    );
  }
  if (scope.openPullRequests.length > 0) {
    parts.push(`${list(scope.openPullRequests)} is still open on GitHub`);
  }
  if (scope.remoteBranches.length > 0) {
    parts.push(`${list(scope.remoteBranches)} is still on the remote`);
  }
  return {
    question: `Clean up after the cancel (${plural(asked, 'question')}, each defaulting to keep)`,
    why:
      `The Job was cancelled: every Attempt is stopped and its leases released. ${parts.join('; ')}. ` +
      'Nothing is removed, closed or deleted unless you answer so; the Task Branches are always kept, ' +
      'and the factory no longer polls the PR. A quarantined Worktree (unknown state) is never part of this.',
  };
}

export interface CleanupAnswerRefusal {
  code: 'unknown_question' | 'invalid_answer';
  message: string;
}

/**
 * Why a cleanup item's answers are refused, or `undefined`: each answer one
 * offered option (never free text), each question at most once, and the
 * remote branch not deleted under a PR kept open (GitHub closes a PR whose
 * head branch is deleted, so "keep it open" could not hold). Unanswered
 * questions keep. Pure.
 */
export function checkCleanupAnswers(
  questions: readonly InboxQuestion[],
  answers: readonly QuestionAnswer[],
): CleanupAnswerRefusal | undefined {
  const seen = new Map<string, string>();
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (q === undefined) {
      return {
        code: 'unknown_question',
        message: `no question '${a.questionId}'; the item asks ${questions.map((x) => x.id).join(', ') || 'nothing'}`,
      };
    }
    if (seen.has(q.id)) {
      return { code: 'invalid_answer', message: `question ${q.id} is answered twice` };
    }
    if (a.text !== undefined || a.option === undefined || !q.options.includes(a.option)) {
      return {
        code: 'invalid_answer',
        message: `answer question ${q.id} with one of its options (${q.options.join(', ')}); it takes no free text`,
      };
    }
    seen.set(q.id, a.option);
  }
  const prAsked = questions.some((q) => q.id === CLEANUP_PULL_REQUEST);
  if (
    prAsked &&
    seen.get(CLEANUP_REMOTE_BRANCH) === CLEANUP_DELETE &&
    seen.get(CLEANUP_PULL_REQUEST) !== CLEANUP_CLOSE
  ) {
    return {
      code: 'invalid_answer',
      message: `${CLEANUP_REMOTE_BRANCH}=${CLEANUP_DELETE} conflicts with keeping the PR open: GitHub closes a PR whose head branch is deleted, so the PR could not stay open as you chose. Close the PR as well (${CLEANUP_PULL_REQUEST}=${CLEANUP_CLOSE}), or keep the branch`,
    };
  }
  return undefined;
}

/** What a decided `cleanup` item asks the runtime to do. */
export interface CleanupChoices {
  discardWorktrees: boolean;
  closePullRequests: boolean;
  deleteRemoteBranches: boolean;
}

/**
 * The effect of a `cleanup` decision: exactly the explicit answers; an
 * unanswered question keeps. A decision made before the questions existed
 * (`keep` | `discard`, ADR-0027) is about the Worktrees only. Pure.
 */
export function cleanupChoices(decision: InboxDecision): CleanupChoices {
  if (decision.answers === undefined) {
    return {
      discardWorktrees: decision.option === CLEANUP_DISCARD,
      closePullRequests: false,
      deleteRemoteBranches: false,
    };
  }
  const answer = (id: string) => decision.answers?.find((a) => a.questionId === id)?.option;
  return {
    discardWorktrees: answer(CLEANUP_WORKTREES) === CLEANUP_DISCARD,
    closePullRequests: answer(CLEANUP_PULL_REQUEST) === CLEANUP_CLOSE,
    deleteRemoteBranches: answer(CLEANUP_REMOTE_BRANCH) === CLEANUP_DELETE,
  };
}

/** The marker of the comment on a PR the factory stopped tracking. */
export function untrackedMarker(jobId: string): string {
  return factoryMarker(jobId, 'untracked');
}

/**
 * The marked comment the factory leaves on each PR of a cancelled Job once its
 * cleanup is decided, kept open or closed: the factory stopped tracking it. Pure.
 */
export function untrackedComment(jobId: string, opts: { closed: boolean }): string {
  return [
    `The software factory stopped tracking this pull request: Job ${jobId} was cancelled.`,
    opts.closed
      ? 'It is closed; the factory will not reopen, update or merge it.'
      : 'It is left open as it is; the factory will not update, review or merge it.',
    '',
    untrackedMarker(jobId),
    '',
  ].join('\n');
}
