# A moved base: merge it into the Integration Branch, re-anchor or re-run the Review

**Status:** accepted (#62, Phase C, C2). The human decisions are Phase C grilling Q6 (merge the base in, never rebase), Q12 (the re-anchored Review) and Q19 (when the base is checked) in PROGRESS.md. The choices below are routine and reversible.

## Merge, never rebase

When the default branch moves under the Integration Branch, the factory merges it in: one two-parent commit with parents (the approved integration head, the new base), made with `merge-tree --write-tree` and `commit-tree` in the Factory Clone, as the integration merge is (ADR-0034). It never rebases. A rebase would rewrite commits the PR has already published, so the update would need a force-push. Every head the factory pushes descends from the one before, so the PR is updated with a fast-forward (ADR-0039) and nobody's checkout breaks. The cost is a merge commit in the history per move. That is GitHub's own "Update branch" behaviour, and a squash merge of the PR removes it. Rewriting a published Integration Branch stays behind the `integration_rewrite` Blocker Approval (ARCHITECTURE §8.1), which is not built here.

When the new base is already in the head, nothing is merged (`mergedIn: false` on `attempt.started`) and the head stays as it is. Verification still re-runs, because the `(head, base)` pair changed.

## When the base is checked (Q19)

- **Before the first push** (`pull_request` Stage): `git ls-remote` of the default branch on GitHub, with git's own credentials, as the push uses. Nothing is fetched into the Factory Clone outside its setup lock. A read failure fails the Stage `delivery_failed`.
- **On every poll while the PR is open** (poller): the default branch's tip (`ls-remote`, read first) or GitHub's PR `base.sha`, whichever shows the move first, while the PR head is still the head the factory pushed. ARCHITECTURE §14 compares with the remote default branch, and GitHub need not update `base.sha` when the branch moves; but a move landing between the two reads shows in `base.sha` first. Either way the base merge Attempt fetches the default branch itself. A foreign push is not handled here; the gate's `reviewed_head` fails it, as before. New feedback goes first. A move it leaves is caught by a poll after the PR is updated, because that update records the base GitHub reported. A poll whose PR row changed while it read GitHub (an update in place) records nothing; the next poll reads afresh.
- **Right before merging** (merger): the PR is re-read and the default branch's tip read. If only the base moved since the approval, the merge-in starts, `merge` is superseded, and nothing is merged until a new `merge` item is approved on the new head (under `human_approval`). A moved head still fails `merge` (ADR-0038).

All three compare against the base of the approved Integration Task's newest passed Attempt.

## What a move does

One versioned Job transaction, `startBaseMergeIn`:

- Every Gate result for the old `(head, base)` is stale. They were already tied to their SHAs; `task.base_moved` records the move, where it was seen, and how many verification runs, Evidence rows and Reviews went stale.
- The open `merge` items and `merge_approval`'s Blocker items are superseded. Each of `integration_review`, `pull_request`, `merge_approval` and `merge` that had started is superseded if it is still in progress, and gets an `attempt + 1` Stage Run (reason `base_moved`). The new `integration_review` runs. A Stage that never started stays as it is.
- The Integration Task goes `approved → changes_requested → ready` with `tasks.base_merge_requested` set (migration 0022). That flag is what makes its next Attempt a base merge. It is cleared in the transaction that records the Attempt, or when the merge-in conflicts.

## The base merge Attempt (cause `base_merge`)

No Harness runs. Under the clone lock the default branch is fetched and merged into the approved head, and the Worktree's branch is moved to the result with `reset --keep`. The Worktree is clean after a passed Attempt; git refuses otherwise, and the factory checks first. Then:

- The Worktree's `base_sha` becomes the new base, so a later Rework diffs against it.
- The Attempt starts at `verifying` on the new `(head, base)`, and the factory runs the path-scope Gate and every command, as for a merge Attempt.
- It does not count toward `maxAttempts`, because the base moving is not a verdict on the work. If its verification fails, it is routed like any Attempt, for example to a developer Rework on the Integration Branch.
- If it is interrupted, it is verified again in place as a new `base_merge` Attempt, never handed to a Harness. The same applies if the runtime crashed between the merge and the Attempt's row: the flag is still set, so the merge is redone from the approved head.

A conflict is the human Blocker `base_merge_conflict` on the Task (subject the Task, no Attempt, ADR-0034), with `replan` and `cancel_job`. A Replan rebuilds the Integration Branch, and that new branch is not a descendant of the published one, so pushing it to the open PR is refused. That route needs `integration_rewrite`, which is later.

## Re-anchor or re-run the Review (Q12)

In the Attempt's review step, the pure `reanchorDecision` compares the patch-ids, which `diffPatchId` computes as `git patch-id --stable` of the diff from the merge-base to the head. Before means the approved head on its base; after means the new head on the new base. An empty diff is `null`.

- **Re-anchored:** the patch-ids are equal, `review.rerunOnBaseChange` is `if_diff_changed` (the default; a Project's config sets it, frozen into the Effective Configuration), and the approved head has an approving Integration Review. A new `reviews` row is written for the new SHAs with `reanchored_from_review_id` pointing to the original. It copies the original's reviewer, template, packet, outcome, Artifact and Findings, and its criterion verdicts become Evidence on the new SHAs. `sessionRef` is null, no reviewer runs, and `review.reanchored` records the reason. The approval rule then runs as for any review.
- **Re-run:** in every other case, including when the old Integration Review was skipped by its rule and there is nothing to re-anchor, the Integration Review runs on the new head through the `attempt + 1` `integration_review` Stage Run.

`patch-id --stable` ignores line numbers and whitespace but not context lines. So a base change next to the reviewed lines changes the patch-id and the Review re-runs, while a change elsewhere keeps it. The decision is computed from git and the rows each time, so a resumed review decides the same. The Review rows themselves are never regenerated.

## Views

- The Review API has `reanchoredFrom`. `job show` prints "re-anchored from review … no reviewer ran" and labels the `base_merge` Attempt. The dashboard's review panel shows a re-anchored badge.
- The factory's comment on the updated PR says the default branch was merged in, and whether the Review was re-anchored.
- The in-place update records the PR's base as GitHub reported it, so the new `merge` item names the new `(head, base)`.

## Not covered

Everything was tested against the fake GitHub only. A foreign push to the PR branch, a base move on a Job whose `integration_review` was skipped and nothing re-anchors (it re-runs, untested), and multi-PR Jobs (Q29) are not covered by a scenario.
