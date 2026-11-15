# Rewriting a published Integration Branch: the `integration_rewrite` Blocker

**Status:** accepted (#65, Phase C). The human decision is Phase C grilling Q25 in PROGRESS.md (spec issue 34, ARCHITECTURE §8.1 and §14). The choices below are routine and reversible. Extends ADR-0034 (the rebuild after a Replan), ADR-0036 (the `pull_request` Stage) and ADR-0039 (updating a PR in place).

## When it applies

A Replan or a re-specification cancels the Integration Task (`replan`) and a new one rebuilds the Integration Branch from the current base (ADR-0034). The rebuilt branch does not descend from the published one. The `pull_request` Stage now chooses its route with the pure `pullRequestDelivery` (`@factory/domain`), using the PR recorded for (Job, Repository), the approved Task and head, whether that head descends from the recorded `pushed_sha` (`git merge-base --is-ancestor` in the Factory Clone), and a human's decision:

- **No PR recorded:** `open`, the first push. Nothing was published, so no approval is needed. A Replan before any PR behaves this way.
- **The PR is no longer open, or already has the head:** `none`.
- **The same Integration Task, or a head that descends from `pushed_sha`:** `update`, the fast-forward update in place of ADR-0039.
- **A rebuilt Integration Task whose head does not descend from `pushed_sha`:** `needs_approval`, until a human decides; then `force_push` or `new_pr`.

The factory never force-pushes on its own judgment.

## The Blocker

`pull_request` goes `waiting_human` and holds the human Blocker `integration_rewrite` (subject: the rebuilt Integration Task's approved Attempt). A Blocker Approval opens (kind `blocker`, `stage_run_id` = the `pull_request` run), as `merge_method_refused` does on `merge` (ADR-0038). It offers `force_push_with_lease`, `new_pr` and `cancel_job`. `approvals.recommended` is `force_push_with_lease`; the new `blockerRecommended(reason)` fills it, and it is null for every other reason. Nothing is pushed while it waits. `pull_request.rewrite_needed` is written.

A decision (`approveIntegrationRewrite`, in the deciding transaction) is refused with 409 `not_integration_rewrite` unless `pull_request` still waits on that Blocker. The decision writes `audit_log` (`integration_rewrite.force_push_with_lease` or `integration_rewrite.new_pr`, target `pull_request:<id>`). `before` holds the PR number, branch and `pushed_sha`; `after` holds the branch, the rebuilt head, and the lease for a force-push. An `audit.recorded` event goes with it, and `pull_request` is queued again. The audit row records the human's authorization, made before anything is pushed. The outcome is recorded separately: `pull_request.updated` with `forced: true`, `pull_request.replaced`, or the Stage's `delivery_failed` with the reason. The Stage finds the decision from the newest decided Blocker Approval of the Task whose option is one of the two routes, so no new column is needed.

## `force_push_with_lease`

The PR is re-read first: a PR merged or closed meanwhile fails the Stage. Then `git push --force-with-lease=refs/heads/<branch>:<pushed_sha>`, from the Factory Clone with git's own credentials. **The lease decides, not the re-read.** If anyone pushed to the branch since the factory's last push, git refuses the push. The Stage fails (`delivery_failed`) with a message that names the lease and the head GitHub showed, and closure reports it. Nothing is overwritten. A redo after the push went through (the PR head is already the rebuilt head) pushes nothing. The same PR is then updated in place, as in ADR-0039: the body is rendered again and PATCHed, and a marked comment says it was force-pushed, with the lease, and who approved it. The row takes the new Task (`task_id`), the new `pushed_sha` and no gate. `pull_request.updated` carries `forced: true` and the approval id.

## `new_pr`

The old PR is left on its branch. The new one goes on the next branch, `factory/<job-id>/integration-<n>` (`integrationBranch(jobId, n)`, `n` = 1 + the replaced PRs of the Job and Repository). The default branch is checked first, as before any first push (ADR-0041). Then the old PR is re-read: a PR merged meanwhile fails the Stage. It gets a comment carrying the marker `pull_request.replaced:<approval id>`, which says why and names the new branch, and it is closed (`PATCH state: closed`) if it is still open. Each step can be redone: the comment is looked up by its marker, and a closed PR is not closed again. Then comes the first push to the new branch and its PR (`ensurePullRequest`, adopted by its marker after a crash). One transaction records the new row and marks the old one `closed` with `replaced_by_id` (migration 0025), with `pull_request.opened` (carrying `replaces`) and `pull_request.replaced`.

**A replaced PR is not the Job's PR any more.** The poller does not track it (`trackedPullRequests`). It is left out of the Merge Gate, `openMergeApproval`, `pr_closed` and `ci_failed` (`pullRequestsOfJob`), so closing it raises no `pr_closed`, which ADR-0043 listed as a limitation. The Merge Gate expects the head branch `publishedBranchOf(pr)`. The PR record shows `replacedByNumber`, and `factory job show` and the dashboard Job detail print "replaced by #N". Cancel cleanup still lists both branches for deletion: the old one was published.

## Known limitations

- Tested against the fake GitHub only.
- The re-specification route reaches the same code (a new Integration Task), but no scenario test covers it. The scenarios replan through `base_merge_conflict`, and a Replan before any PR comes from an Integration Review `plan` Finding.
- A refused lease fails `pull_request`; it does not raise the Blocker again. A human who still wants the rebuilt branch published has no route left except cancelling.
- A force-push skips the default-branch check before the push. The poller catches a moved base on the next poll, as it does after any update in place.
- PR feedback recorded on a replaced PR is not carried to the new PR.
- Multi-PR Jobs are untested (Q29).
