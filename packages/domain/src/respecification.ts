/**
 * Re-specification, the `spec` Fault Origin route (ARCHITECTURE §4.6, Phase B
 * decisions Q11 and Q18, ADR-0031): a blocking Finding blames the
 * Specification, so `specification` re-runs with it, and the new spec waits
 * on a `spec_change` Approval. No I/O.
 */
import { z } from 'zod';
import type { ApprovalOption } from './approvals.js';

/**
 * A re-specification asked for (a `respec_request` Artifact): the Specification
 * to revise, the feedback, and the Task and Attempt whose Finding started it.
 * The specifier reads it on every Harness Run, so it is never regenerated.
 */
export const RespecRequestContentSchema = z.object({
  /** The spec Artifact to revise: the current one, or the candidate a human sent back. */
  specArtifactId: z.string(),
  /** The blocking `spec` Findings (reviewer output), or the human's "request changes" comment. */
  feedback: z.string(),
  requestedBy: z.string(),
  /** The Task whose review raised the Finding; it stays `blocked` until the change is decided. */
  taskId: z.string(),
  /** The Attempt that raised it (the Task's Blocker names it). */
  attemptId: z.string(),
});
export type RespecRequestContent = z.infer<typeof RespecRequestContentSchema>;

/** The fixed options of a `spec_change` item (ARCHITECTURE §4.6, Q18). */
export const SPEC_CHANGE_OPTIONS: readonly ApprovalOption[] = [
  {
    id: 'approve',
    label: 'Approve the change',
    description:
      'Adopt the new Specification: the Task that raised the Finding is cancelled (its Worktree preserved, its branch kept), and the Job replans under the new Specification once no Attempt is in flight; the new Plan waits at plan_approval.',
    agentProposed: false,
  },
  {
    id: 'request_changes',
    label: 'Request changes',
    description:
      'Send the new Specification back to the specifier with your comment as feedback (counts against maxReplans).',
    agentProposed: false,
  },
  {
    id: 'reject',
    label: 'Reject the change',
    description:
      'Discard the new Specification (its Artifact is kept) and keep the current one; the Finding then waits on a Blocker: Rework with guidance, replan under the current Specification, or cancel the Job.',
    agentProposed: false,
  },
];
