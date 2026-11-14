/**
 * The `cleanup` Inbox Item a cancel opens (PRODUCT_SPEC §12, ADR-0027): once
 * everything is stopped, discard the Job's preserved Worktrees, or keep them
 * (the default). Task Branches are always kept. Phase C adds the PR and
 * remote-branch questions to the same item.
 */
import type { ApprovalOption } from './approvals.js';

export const CLEANUP_KEEP = 'keep';
export const CLEANUP_DISCARD = 'discard';

/** The fixed options of a `cleanup` item; `keep` is the recommended default. */
export const CLEANUP_OPTIONS: readonly ApprovalOption[] = [
  {
    id: CLEANUP_KEEP,
    label: 'Keep',
    description:
      'Keep every preserved Worktree on disk as it is. Nothing is removed; the Task Branches stay in the Factory Clone.',
    agentProposed: false,
  },
  {
    id: CLEANUP_DISCARD,
    label: 'Discard',
    description:
      'Remove the preserved Worktree directories. Any uncommitted leftovers are first kept as a flagged WIP commit on the Task Branch; the Task Branches, and every commit on them, stay in the Factory Clone.',
    agentProposed: false,
  },
];

/** The question and the reason a `cleanup` item shows, for `preserved` Worktrees. */
export function cleanupItemText(preserved: number): { question: string; why: string } {
  const n = `${String(preserved)} preserved Worktree${preserved === 1 ? '' : 's'}`;
  return {
    question: `Discard the ${n}?`,
    why:
      `The Job was cancelled: every Attempt is stopped and its leases released, and ${n} ` +
      `${preserved === 1 ? 'is' : 'are'} left on disk. Nothing is removed unless you choose discard; ` +
      'the Task Branches are always kept. A quarantined Worktree (unknown state) is never part of this.',
  };
}
