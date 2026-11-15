# The `pull_request` Stage, the PR body and the recovery of the PR write

**Status:** accepted (#57, Phase C, C1). These are routine, reversible choices inside the Phase C design (#52): Q17, Q20, Q22, Q28, Q29 and Q30 in PROGRESS.md.

## The `feature` Recipe, version 5

Version 5 adds `pull_request` after `integration_review`. Versions 2, 3 and 4 are kept (`featureRecipe(version)`), so a Job created at v4 or earlier is delivered locally as before. `FACTORY_TEST_RECIPE_VERSION` accepts `2` to `5`.

`merge_approval` and `merge` are **not** in v5. The design (Q17) puts them after `pull_request`, but they need the poller and the Merge Gate (#58). Stages that do nothing would be scaffolding that pretends to be a gate (CLAUDE.md §1.2). #58 adds them in v6, with the same "no GitHub remote" skip. Until then, a Job with a PR completes once the PR is open, and its Delivery Report says the PR awaits a human merge on GitHub and that the factory does not watch it yet.

## Entering and leaving the Stage

- **Queued** in the transaction where the Stage holding the Integration Task succeeds (`settleIntegration`: `integration_review`, or `integration` when the review was skipped), through `startPullRequest`, before closure.
- **Skipped** with the reason `no GitHub remote: …` when no Repository with an approved Integration Task has GitHub coordinates. Closure then follows at once, and the Delivery Report is the Phase B local delivery (Q20).
- **Skipped** when nothing was approved to open a PR from: a failed `execution`, `integration` or `integration_review` skips it, with the reason, in the transaction that skips or fails them.
- **Run** by the Task scheduler in a slot of its own (`pull_request:<stage run id>`), like closure. It moves `queued → running` before its first await. A run left `running` resumes at the next start.
- **Ends** `succeeded` once every PR is recorded, and queues closure in the same transaction. It ends `failed` (reason `delivery_failed`, a new `StageFailure` reason) when git refuses the push or GitHub refuses the PR. Closure still runs, so the local delivery is reported, and the Job is `failed`. An unexpected error is `factory_error`, through the scheduler's guard.

## The work, per approved Integration Task with coordinates

1. **Skip it if already recorded.** If `pull_requests` already has (Job, Repository, head branch), the PR is done. A resumed Stage carries on where it stopped.
2. **Render the body** (below), redacted.
3. **`ensurePullRequest`** (exported, and tested in the integration tier against the fake GitHub):
   - It looks up a PR by head branch first (Q28). The pure rule is `pullRequestRecovery`: none means **create**; a PR carrying this Job's marker means **adopt** (a crash came between creating it and recording it); a PR without the marker means **uncertain**, never adopted. A marker for another Job counts as no marker.
   - A failed lookup writes nothing to GitHub.
   - Only when the lookup finds none does it **push** and then create. So a foreign PR's branch is never pushed to: a fast-forward would edit someone else's PR, and a refused push would hide the `recovery_uncertain`.
4. **The push** is the factory's first push of anything: `git push <https://github.com/owner/name.git> <approved head>:refs/heads/factory/<job-id>/integration`, from the Factory Clone, never forced.
   - It pushes to the coordinates' URL, never to `origin`: a clone made from a local path has the operator's checkout as its origin.
   - The approved head is the Integration Task's passed Attempt: the head the Integration Review approved, or the merge Attempt's head when the skip rule held.
   - git's output in a failure message is folded onto one line and redacted (GitHub writes `remote:` lines into it).
   - The push uses git's own credential setup (for github.com, typically `gh auth setup-git`). The token reference is for the REST API (ADR-0033) and is not placed in a git process's environment or argv. Alternative not taken: an `http.extraheader` carrying the token through `GIT_CONFIG_*`. It works, but it puts the token in another process's environment for no gain while the operator's git can already push.
   - The Task scheduler refuses a GitHub port without the runtime's redactor.
5. **Retries.** A `transient` or `rate_limited` failure is tried again after 2, 5, 15 and 40 s (about a minute, 5 tries). A `refused` failure is not. The GitHub-wide pause and backoff are #66's.
6. **Record.** One transaction inserts the `pull_requests` row and the `pull_request.opened` (or `pull_request.adopted`) event.
7. **Uncertain.** `pull_request` goes `waiting_human` with a human Blocker `recovery_uncertain` that names the foreign PR. A `pull_request.foreign_found` event is written. No Inbox Item is opened: the `recovery_uncertain` option set (`retry_now`) is about processes, not PRs. Cancelling the Job is the way on. This is a known limitation; a PR-specific option set can come with the PR-closed work.

Test-only crash point: `FACTORY_TEST_CRASH_AT=pull_request.after_create` kills the runtime after GitHub created the PR and before it is recorded. The scenario restarts and asserts one PR, adopted.

## The PR body

`renderPullRequestBody(input, redact)` (pure, `@factory/domain`) works over `pullRequestBodyInput`, which reads only persisted rows:

- the current Specification's problem and objective;
- every Acceptance Criterion with its combined verdict and current Evidence on the integration `(head, base)`;
- the factory's verification commands on the integration head, with exit codes and verdicts;
- the risks: the overall risk (the Integration Task's), each Plan Task's risk, and the Specification's security considerations;
- the non-blocking Findings of the approving reviews (each Plan Task's current review and the Integration Review);
- the unanswered non-blocking questions of the approved Attempts;
- the rollback notes;
- the Task Branches merged.

Untrusted text is folded onto one line and code spans are fenced, so it can't open a section of its own. Every section is always present ("None." when empty). The whole text is redacted, then the marker `<!-- factory:<job-id>:pull_request -->` is appended. No LLM renders anything.

**Rollback:** the Plan gains an optional `rollback` field. The planner sees it in the output schema, described as "only if the Plan supports a rollback". Without it, the body says "None supported." and never invents one.

The body is rendered once, when the PR is opened. Re-rendering it on a head change (PATCH) belongs to the work that changes the head after the PR is open (#58 onward).

The title is the Job's title.

## `pull_requests` (migration 0017)

The columns are `id, job_id, repository_id, task_id, owner, name, number, url, state (open|closed|merged), head_branch, base_branch, head_sha, base_sha, pushed_sha, adopted, created_at, last_polled_at, version`. Two indexes are unique:
- (Job, Repository, head branch), so that a later `new_pr` on `factory/<job-id>/integration-2` can add a second row;
- (owner, name, number).

Only the runtime writes it. `last_polled_at` stays null until the poller (#58). ARCHITECTURE §5 lists it under Phase C.

## Views and the Delivery Report v5

- **API:** `GET /v1/jobs/:id/pull-requests` returns the rows (`PullRequestRecord`).
- **`factory job show`:** prints a "Pull requests (as recorded by the factory)" section with the link, state, branches, head and pushed SHA, and the last-polled time ("never (not polled yet)").
- **Dashboard:** the Job detail adds a "Pull requests" card from the same rows, with the link and state, labelled "not read live from GitHub". It renders nothing when there is no PR. Nothing is fetched from GitHub on page load.
- **Delivery Report v5** (ADR-0034 renamed the design's "v4"; spec issue 36):
  - `pullRequests[]` gives the repository, number, link, state, branches, the pushed head, `adopted`, and `mergeSha` (null: awaiting a human merge).
  - The statement names the PR. The notes say only the Integration Branch was pushed, and that more than one PR is not atomic.
  - The limitation "nothing was pushed" is replaced by "pushed only the Integration Branch …; it does not yet watch the PR's checks, reviews or merge, and never merges".
  - Without a PR, the note says why none was opened (the skip reason), and the report stays the local delivery.
  - A failed `pull_request` makes the outcome `failed`, and the statement says so.

## Multi-Repository Jobs

The Stage opens one PR per approved Integration Task whose Repository has coordinates (Q29), and records each one. The Delivery Report still describes the Job's first Repository (as since Phase A), but it lists every PR and says they are not atomic when there is more than one. Tests cover single-Repository Jobs only.
