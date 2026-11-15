# The GitHub poller, the Merge Gate and `merge_approval` under `never_auto`

**Status:** accepted (#58, Phase C). These are routine, reversible choices inside the Phase C design (#52): Q5, Q7, Q13, Q15, Q17, Q20, Q22, Q23 and Q30 in PROGRESS.md.

## The `feature` Recipe, version 6

Version 6 adds `merge_approval` and `merge` after `pull_request`. Versions 2 to 5 are kept. A v5 Job still goes from `pull_request` straight to closure, with the PR open and unwatched (ADR-0036). `FACTORY_TEST_RECIPE_VERSION` accepts `2` to `6`.

- **Opened** in the transaction where `pull_request` succeeds (`openMergeApproval`). `merge_approval` goes `pending → queued → running → waiting_human` with a human Blocker `awaiting_merge` (new reason), and one `merge` Inbox Item is opened per open PR. The Job is `waiting_human`. The Stage needs no slot of its own: the poller advances it.
- **Skipped** with the same reason as `pull_request`, both `merge_approval` and `merge`, when `pull_request` is skipped ("no GitHub remote", or integration failed). Also skipped when `pull_request` fails (`delivery_failed`). Closure follows (spec issue 38).
- **Completed by the poller.** A merge seen on GitHub decides the PR's `merge` item. Once every PR of the Job is merged, `merge_approval` succeeds, `merge` goes `pending → queued → running → succeeded` with the merge SHA on its event (`mergeSha`, plus `mergeShas` for every PR), and closure is queued, all in one transaction. Under `never_auto` the `merge` Stage only records the merge a human made. C3 (#59) gives it the factory's own merge.
- The engine's Stage Run stepper takes an optional `detail` for facts the event carries (here, the merge SHA). It doesn't update the row it is given, so `merge-approval.ts` re-reads a run between steps.

## The `merge` Inbox Item

- Kind `merge` (new `ApprovalKind`), holding `merge_approval`, naming the Integration Task. Its subject is `mergeItemSubject(prId, head, base)` = `<pr id>@<head>..<base>`: one item per PR `(head_sha, base_sha)` (Q15).
- The poller supersedes it on any head or base change (`approval.superseded`) and opens one for the new SHAs.
- Under `never_auto` it says "merge on GitHub" and offers **only `cancel_job`**. The ticket lists `request_changes` too, but that is wired by the feedback loop (#60). An option that does nothing would be a placeholder (CLAUDE.md §1.3), so #60 adds it to `NEVER_AUTO_MERGE_OPTIONS`. Items store their options (`options_json`), so #60 must also add `request_changes` to `merge` items already open when it ships, or supersede them, not only to new ones.
- `cancel_job` decides the item and runs the Job cancel. Polling stops, because only Jobs whose `merge_approval` is `waiting_human` are polled. The PR stays open on GitHub; closing it and the marked comment are #64's.
- A merge on GitHub decides it as `system:github-poller` with the option `merged_on_github`. That option is not offered to humans: only the poller's own write uses it.

## The Merge Gate (pure)

`evaluateMergeGate` in `@factory/domain` (`merge-gate.ts`) takes persisted inputs plus `now` and returns six conditions, each `pass | fail | pending` with a reason, and a verdict (`fail` if any fails, else `pending` if any is pending, else `pass`):

1. `target`: the PR is on the Repository's coordinates, its base is the default branch, its head is `factory/<job-id>/integration`, and it is open.
2. `reviewed_head`: the head the Integration Task's passed Attempt approved equals the PR head.
3. `checks` (Q13): the newest check run per name and the newest commit status per context on the PR head (`observedChecks`). `success`, `neutral` and `skipped` pass. Any other completed conclusion, and a status of `error` or `failure`, fails. Anything not completed is pending.
   - With `requiredChecks` set, only those count, and one that never reported stays pending: never passed by grace.
   - With nothing to count and none required, the condition is pending until `github.checksGraceMs` (default 2 min) after the factory first saw the head, then passes with "no checks reported". The factory doesn't know the push time to the second: the window starts when it recorded the PR (at the push) or first polled a new head, so for a head pushed by someone else it starts up to one poll interval late (conservative).
4. `reviews`: blocking Findings on the approved Integration Attempt's current review, and GitHub users whose latest deciding review is `CHANGES_REQUESTED` (`unresolvedChangeRequests`; a later `APPROVED` or `DISMISSED` resolves it, `COMMENTED` doesn't).
5. `mergeable`: GitHub's `mergeable_state`, separately. `clean`, `unstable` and `has_hooks` pass; `dirty` fails (a conflict); `blocked`, `behind`, `draft`, `unknown` or unread are pending.
6. `policy`: `never_auto` is always pending ("the factory never merges; a human merges on GitHub"). `MergePolicySchema` has `never_auto` only; `human_approval` and the stored policy are C3's (#59).

**`requiredChecks`** is an optional field of the Repository profile, set with `factory repo add --required-check <name>` (repeatable). It is not a column: it is part of the confirmed profile, and the profile keeps version 1 because the field is optional.

## The poller

`GitHubPoller` (`apps/runtime/src/poller.ts`) runs on its own `PassLoop` every `github.pollIntervalMs` (default 30 s, Q23). It is never woken by commits, so GitHub is not called more often than that. It polls each `open` PR whose Job's `merge_approval` is `waiting_human`.

- **What it reads:** the PR (state, merge, merge commit, head, base, `mergeable_state`), the check runs and commit statuses on the head, and the reviews.
- **ETags:** kept in memory only, keyed per read (per head for checks). They are sent as `If-None-Match`, and a 304 reuses the value read before. After a restart the first poll reads everything afresh, and the comparison with the rows finds nothing new.
- **Comparing:** `assessPoll` is read-only. It compares the observation with the `pull_requests` row and its `pr_checks`, then evaluates the gate over the row as it would be.
- **A quiet poll** (nothing differs, gate unchanged) writes only `last_polled_at`: no event, and no Job version bump. That column is the record of when GitHub was read. It is the one observational write without an event, so the views can show the poll time (Q30) while "no change, no event" holds.
- **A poll that saw a change** runs `recordPoll` in one versioned Job transaction:
  - the row (bumped `version`), the `pr_checks` upserts, and `pull_request.observed` listing the changes;
  - the gate (`gate_json`, `gate_evaluated_at`) and `merge_gate.evaluated` when it differs;
  - a new head or base: the `merge` item superseded and reopened, and `head_seen_at` reset (the grace window starts again);
  - a merge: completing the Stages.

  Inside the transaction it checks that `merge_approval` is still `waiting_human`, so it does nothing to a Job cancelled meanwhile.
- **`ci` Evidence:** when the checks condition settles (`pass` or `fail`, or a new reason) on a `(head, base)`, it is written as Evidence of the new kind `ci`, source `github`. It goes on the Integration Task's approved Attempt, at the PR's SHAs, so it goes stale with them. It is never criterion Evidence and never feeds approval.
- **The PR body** gains a "CI checks" section: the checks condition and each check with its link. It reads "Not read from GitHub yet" at opening. After each poll the body is rendered again from the rows. When its SHA-256 differs from `body_sha256` (the body the factory last sent; set at opening), it is PATCHed and `pull_request.body_updated` recorded. A human's edit of the body is overwritten only when the factory's own rendering changes.
- **Failures:** a failed read writes nothing and the next poll tries again. The GitHub-wide pause, `paused_until` and the exponential backoff are #66's.

**A PR closed without merging** is recorded (`state: closed`), and the gate's `target` fails. The Job stays `waiting_human` on its `merge` item. Since #64 (ADR-0043) a closed PR raises the `pr_closed` Blocker Approval (`reopen_pr`, `cancel_job`), and the poller keeps reading it so a reopen is seen.

## Schema (migration 0018)

- **`pr_checks`**: `id, pull_request_id, head_sha, source (check_run|status), name, status, conclusion, outcome, url, observed_at`, unique per `(pull_request_id, head_sha, source, name)`. Rows of an earlier head stay as history; the views show the current head's.
- **`pull_requests`** gains `merge_sha`, `mergeable_state`, `head_seen_at`, `changes_requested_json`, `gate_json`, `gate_evaluated_at` and `body_sha256`.

## Views and the Delivery Report v6

- **API:** `GET /v1/jobs/:id/pull-requests` adds `mergeSha`, `mergeableState`, `headSeenAt`, `changesRequestedBy`, `gate`, `gateEvaluatedAt` and the current head's `checks`.
- **`factory job show`:** prints the merge, `last polled <time>`, the Merge Gate with each condition, and each check with its link.
- **Dashboard:** the Job detail's Pull requests card shows the same: the merge, a Merge Gate table, the checks with links, and the last-polled time.

All of these read the persisted rows; no page load calls GitHub (the scenario counts the fake's requests once polling has stopped, so concurrent polls don't blur the count). A quiet poll writes no event, so a live dashboard page doesn't refresh its "Last polled" time until the next event or reload.

**Delivery Report v6:** `pullRequests[].mergeSha` comes from the row, and `ci` gives the checks condition with each check. The statement names the merge SHA once every PR is merged. The limitation says the factory polled and never merged (`never_auto`).
