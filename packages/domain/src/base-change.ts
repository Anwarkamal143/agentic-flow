/**
 * A moved base (ARCHITECTURE §14, ADR-0041; Phase C grilling Q6, Q12, Q19).
 * When the default branch moves, the factory merges it into the Integration
 * Branch (never a rebase, never a force-push), and every Gate result for the
 * old `(head_sha, base_sha)` is stale. This decides what happens to the
 * approving Integration Review. No I/O: git computes the patch-ids.
 */
import { z } from 'zod';

/**
 * `review.rerunOnBaseChange`: `if_diff_changed` (the default) re-anchors the
 * Review when merging the base in left the reviewed diff unchanged; `always`
 * runs the Integration Review again after every base merge-in.
 */
export const ReviewRerunOnBaseChangeSchema = z.enum(['if_diff_changed', 'always']);
export type ReviewRerunOnBaseChange = z.infer<typeof ReviewRerunOnBaseChangeSchema>;

export type ReanchorDecision =
  | {
      kind: 'reanchor';
      /** The approving Review the new one points to. */
      reviewId: string;
      reason: string;
    }
  | { kind: 'rerun'; reason: string };

/**
 * Whether the Integration Review is re-anchored or runs again (Q12). The
 * patch-ids are `git patch-id --stable` of the diff from the merge-base to the
 * head, before and after the merge-in (`null`: an empty diff). Re-anchored only
 * when there is an approving Integration Review to point to, the policy is
 * `if_diff_changed`, and both patch-ids are equal. Pure.
 */
export function reanchorDecision(input: {
  patchIdBefore: string | null;
  patchIdAfter: string | null;
  policy: ReviewRerunOnBaseChange;
  original: { id: string } | null;
}): ReanchorDecision {
  const { patchIdBefore, patchIdAfter, policy, original } = input;
  if (original === null) {
    return {
      kind: 'rerun',
      reason:
        'there is no approving Integration Review on the old head to re-anchor (it was skipped), so the Integration Review runs',
    };
  }
  if (policy === 'always') {
    return {
      kind: 'rerun',
      reason:
        'review.rerunOnBaseChange is always: the Integration Review runs after every base merge-in',
    };
  }
  if (patchIdBefore !== patchIdAfter) {
    return {
      kind: 'rerun',
      reason: `the diff changed when the base was merged in (patch-id ${patchIdBefore ?? 'empty'} before, ${patchIdAfter ?? 'empty'} after), so the Integration Review runs on the new head`,
    };
  }
  return {
    kind: 'reanchor',
    reviewId: original.id,
    reason: `the diff from the merge-base to the head is unchanged by the base merge-in (patch-id ${patchIdAfter ?? 'empty'}), so Review ${original.id} is re-anchored to the new SHAs and no reviewer runs`,
  };
}
