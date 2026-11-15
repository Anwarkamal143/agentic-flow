# Foreign pushes to the Integration Branch: fetch, never overwrite, verify like our own

**Status:** accepted (#63, Phase C). The human decision is Phase C grilling Q26 in PROGRESS.md. The choices below are routine and reversible.

## Detection

The poller compares the PR head GitHub reports with `pull_requests.pushed_sha`, the last head the factory pushed. A head that is neither that one nor the approved Integration Task's head, while the PR is open and the Task is approved (`foreignPushed`), is a foreign push. The check reads only rows (no LLM, no git), so a resumed poll decides the same.

A foreign push goes first in a poll. A moved base was already not merged in while the head was foreign (ADR-0041), and PR feedback seen in the same poll is left unrecorded, so the poll after the update reads it as new and it starts its Rework then, on top of the adopted head.

## What a foreign push does

One versioned Job transaction, `startForeignPushAdoption`, shaped like the base merge-in's:

- Every Gate result for the approved head is stale. `rerunDeliveryStages` (factored out of `startBaseMergeIn`) supersedes the open `merge` items and `merge_approval`'s Blocker items, and gives each started `integration_review`, `pull_request`, `merge_approval` and `merge` an `attempt + 1` Stage Run (reason `foreign_push`). The new `integration_review` runs.
- The Integration Task goes `approved → changes_requested → ready` with `tasks.foreign_head_sha` set to the head seen (migration 0023). That column is what makes its next Attempt a foreign push Attempt. It is cleared in the transaction that records the Attempt.
- `task.foreign_push` records the factory's head, the foreign head and the counts of stale Gate results.

## The foreign push Attempt (cause `foreign_push`)

No Harness runs. Under the clone lock the factory fetches the Integration Branch from GitHub (`fetchBranchHead`: `git fetch <url> refs/heads/<branch>`, git's own credentials, only `FETCH_HEAD` written). It takes whatever the branch holds then, so a second push after the one the poller saw is adopted too. It records the commits that head holds and the approved head does not (`authoredCommitsBetween`, `approved..foreign`) as `attempts.foreign_commits_json`, with their subject and author name. It moves the Worktree's branch to that head with `reset --keep`, never the other way round. A foreign push that rewrote the branch is not adopted on the factory's own judgement: see the next section.

The Attempt starts at `verifying` on (foreign head, approved base), and the factory runs `verifyMerge`, as for a merge or base merge Attempt. That covers the path-scope Gate over the union of the Plan Tasks' writable globs, every de-duplicated command, and the criteria. Because the Task now runs in `integration_review`, the Integration Review always runs on the foreign head. Nothing is re-anchored: the foreign commits are new, unreviewed work. Like a base merge, it does not count toward `maxAttempts` (someone else's commits are not a verdict on the factory's work), and an interrupted one is verified again in place, as a new `foreign_push` Attempt that carries the foreign commits over.

The shared second half of `runBaseMerge` became `verifyFactoryHead`, which both Attempts use.

## A rewrite: the `foreign_push_rewrite` Blocker

A fetched head that no longer holds the approved head (`git merge-base --is-ancestor` fails) is a rewrite of a published Integration Branch: adopting it drops approved commits from the PR. The pure `foreignPushAdoption` decides: a fast-forward is adopted; a rewrite waits for a human, unless the fetched head holds a rewrite a human already approved. The grounds (a human decision, 2026-11-15, Spec issue 39):

1. GLOSSARY "Integration Branch": once it is a PR head, it is rewritten only with a human's Approval. A foreign rewrite is a rewrite.
2. Q26 and ARCHITECTURE §14 record foreign commits in the PR body and the Delivery Report. Dropping approved commits while only an event records them breaks that.
3. ARCHITECTURE §10 lists force-push as dangerous, and repository content never changes policy (CLAUDE.md).
4. "Never overwritten" (Q26): the factory does not force-push back either.

So the `foreign_push` Attempt's setup, under the clone lock, checks out nothing and makes no Attempt. `blockOnForeignRewrite` raises the human Blocker `foreign_push_rewrite` on the Task (subject the Task, as for `base_merge_conflict`), naming the rewrite, the approved head and how many approved commits it drops. It records the rewrite as `tasks.foreign_head_sha`, the head an approval adopts. Its Blocker Approval offers:

- **Adopt the rewrite** (`adopt_rewrite`). `approveForeignRewrite` sets `tasks.foreign_rewrite_approved_sha` to the named rewrite, writes an `integration_rewrite.adopted` audit row with its `audit.recorded` event, and readies the Task. The next `foreign_push` Attempt adopts a fetched head that holds that rewrite (a push on top of it is adopted too; another rewrite is blocked again). It records the dropped approved commits (`authoredCommitsBetween`, `rewrite..approved`) in `attempts.dropped_commits_json`, then verifies and reviews like any foreign push. The approval is cleared when the Attempt is recorded (migration 0024).
- **Cancel the Job.**

There is no "restore our head" option: it would overwrite the foreign push. The `integration_rewrite` Blocker of ARCHITECTURE §8.1, the factory's own rewrite of a published branch, is not this one (ADR-0044).

## Out of scope: the `foreign_push_out_of_scope` Blocker

A failed `foreign_push` Attempt whose Findings include a `scope.*` rule is routed by `routeFailedAttempt` (given the Attempt's `cause`) to the human Blocker `foreign_push_out_of_scope`, never to a Rework of its own accord. A developer Rework would have to undo someone else's commit, and that is the human's call. Its Blocker Approval offers:

- **Rework on top of the foreign commits.** A developer Rework on the Integration Branch from the foreign head, with the path-scope Findings and the human's comment as guidance (for example, revert the out-of-scope paths in a new commit). It counts against `maxAttempts` (`applyRework`, as for `spec_finding_unresolved`). Then the Integration Review runs, and the PR is updated with a fast-forward.
- **Cancel the Job.**

There is no option to accept the out-of-scope change: that would widen a permission on the strength of repository content, which CLAUDE.md forbids. A foreign push that is in scope but fails a command is routed like any failed Gate, to a developer Rework.

## Later pushes fast-forward from the foreign head

The Worktree's branch is the foreign head, so every later factory commit descends from it. `updateInPlace` accepts the PR head GitHub reports when it is the head the factory last pushed, the head it is about to push, or a foreign head a `foreign_push` Attempt fetched, so a push after an out-of-scope Blocker's Rework is not refused. The push is never forced. A `pull_request` update that only adopts (the approved head is the foreign head) pushes nothing new, and `pushed_sha` becomes the foreign head.

## Reporting

- The PR body has a **Foreign commits** section ("None." when there are none, as for the other sections). After an adopted rewrite it also lists, apart, the approved commits the rewrite dropped. Each commit's SHA, author and subject are in inline code, so untrusted text can't format the body or mention anyone. The body is redacted as a whole.
- The Delivery Report's `integration.foreignCommits` and `integration.droppedCommits` list each one with the `foreign_push` Attempt that recorded it and how that Attempt ended. The fields have defaults, so reports written before them still parse. `reportVersion` stays 6.
- The Attempt API has `foreignCommits` and `droppedCommits`. `job show` labels the Attempt and prints each foreign and dropped commit on one line, with control characters removed.
- The factory's comment on the updated PR says someone else pushed and the factory never overwrote it.

## Not covered

Everything was tested against the fake GitHub only. A foreign push while a factory Rework or base merge-in is in flight is not adopted: `updateInPlace` still refuses to push over it (`delivery_failed`), as before. The path-scope Gate diffs from the approved base. A foreign push that merges a newer default branch in therefore shows that branch's changes as its own, and fails the Gate when they are out of scope. A rewrite a human adopted that is rewritten again before the Attempt fetches it is blocked again, untested. A foreign push after a `base_merge_conflict` Replan, and multi-PR Jobs (Q29), are untested.
