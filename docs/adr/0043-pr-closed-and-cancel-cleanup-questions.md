# A PR closed without merging, and the three cancel cleanup questions

**Status:** accepted (#64, Phase C; spec issues 40 and 41 confirmed by a human 2026-11-15, GLOSSARY "Approval" amended). The human decisions are Phase C grilling Q16 (a PR closed without merging) and Q27 (cancel with an open PR) in PROGRESS.md, and spec issue 35. The choices below are routine and reversible. Extends ADR-0027 (cancel cleanup) and ADR-0037 (the poller).

## A PR closed without merging

**A human Blocker, not a `question` item.** Q16 says "an Inbox Question with `reopen_pr` and `cancel_job`". In this codebase a `question` item is an agent's Question, answered with content, and its Task waits for a fresh Attempt (GLOSSARY "Question"). Reopen-or-cancel is a decision between fixed options, so it is built the way `ci_failed` is (ADR-0040): `merge_approval` (`waiting_human`) holds the human Blocker `pr_closed`, and a Blocker Approval (kind `blocker`, subject the Integration Task's approved Attempt) offers `reopen_pr` and `cancel_job`. The behavior is the one Q16 asks for. Spec issue 40 records the wording; a human confirmed it: Q16's "Inbox Question" was loose wording, and reopen-or-cancel is a fixed-option authorization, an Approval.

- **Raised and cleared by the poller**, from the rows, in the poll's transaction (`syncPrClosedBlocker`, before `syncCiBlocker`). A PR of the Job recorded `closed` raises `pr_closed` (`stage_run.blocker_changed`) and opens its item. A `ci_failed` item open at the time is superseded: while the PR is closed, a failed check waits behind it. The read-only `prClosedBlockerStep` also makes the poll not quiet.
- **The poller keeps reading a closed PR.** `trackedPullRequests` now returns `open` and `closed` PRs of a Job whose `merge_approval` waits. Before #64 a closed PR was never read again, so a reopen on GitHub went unseen.
- **Reopened on GitHub: the item closes itself.** When the poll records the PR `open` again, the item is `superseded` ("the pull request was reopened on GitHub"), by `system:github-poller` and with no decision (no human decided anything), and `merge_approval` waits on the merge again (`awaiting_merge`). `syncCiBlocker` then runs in the same transaction, so a check that still fails raises `ci_failed` again.
- **Nothing cancels the Job on its own.** The Blocker stays until a human decides, or the PR is reopened.
- The open `merge` item is left as it is. The gate's `target` condition fails while the PR is closed.

**`reopen_pr`** (like `rerun_checks`, the GitHub call comes before the decision):

1. The item must still hold `merge_approval`'s `pr_closed` Blocker, or the decision is refused (409 `not_pr_closed`).
2. GitHub is asked to reopen each closed PR of the Job (`PATCH state: open`).
3. **A refusal is reported on the item.** Its `why` gains "Last attempt: GitHub did not reopen … (refused 422: Validation Failed). Reopen it on GitHub yourself, try again, or cancel the Job." A later report replaces the earlier one. Its version is bumped and `approval.reopen_refused` is written (the PR, the failure kind and the status). The API answers 409 `reopen_refused` (502 for a transient failure). The item stays open with both options, so `cancel_job` is still offered. The factory decides nothing alone.
4. Otherwise one versioned transaction marks the item decided, records each PR `open` (`pull_request.reopened`; the row's version is bumped, so a poll that read GitHub before the reopen is dropped) and puts back `awaiting_merge`. The Merge Gate is evaluated again by the next poll, where the stored gate (with `target` failing) differs from the new one.

If a poll saw the reopen first and superseded the item, the decision returns the item as it now is.

## Cancel with an open PR: three questions in one cleanup item

**The questions.** The one `cleanup` item (ADR-0027) now carries `questions` (the `approvals.questions_json` column a `question` item already uses; no migration). It asks only what applies (`cleanupQuestions`, `@factory/domain`), each non-blocking with the default `keep`:

| id | asked when | options |
|---|---|---|
| `worktrees` | the cancel left preserved Worktrees | `keep`, `discard` |
| `pull_request` | a PR of the Job is open on GitHub | `keep`, `close` |
| `remote_branch` | a PR of the Job is not merged (its head branch was pushed) | `keep`, `delete` |

`InboxQuestionSchema` gains `source: 'cleanup'`, and `agentProposed` becomes a boolean. A cleanup question is `agentProposed: false`, so the CLI and the dashboard show it as asked by the factory and offer no free text. The item's one option is `answer`. Without anything to ask, no item is opened. Without a PR (Phase B), only `worktrees` is asked.

**Decided per question, through `/answer`.** The cleanup item is still an Approval (Q27, spec issue 35): it authorizes destructive actions, and is never called a Question. It is decided per question, each with fixed options and a default (GLOSSARY "Approval"); `POST /v1/inbox/:id/answer` is only the mechanism. It takes a cleanup item too (`factory inbox answer <id> --answer pull_request=close …`, and the dashboard's cleanup form, where keep is preselected and sent as unanswered). `checkCleanupAnswers` accepts any subset of answers, but only offered options, and each question at most once. **An unanswered question keeps.** It refuses `remote_branch=delete` while a PR asked about is kept open: GitHub closes a PR whose head branch is deleted, so "keep it open" could not hold. This couples two of Q27's "separate" questions; a human confirmed it (spec issue 41): accepting the pair would let GitHub close a PR the human chose to keep, so the outcome would differ from the recorded decision. The 400 names the conflict and says to close the PR as well; the CLI prints it, the dashboard shows it on its refusal page, and the dashboard form disables `delete` while the PR is kept. The generic decide refuses such an item (409 `answer_required`). An item opened before #64 (options `keep | discard`, no questions) is still decided the old way, and still means the same thing (`cleanupChoices`).

**Carried out after the commit** by `CleanupWorker`, from the persisted decision (`cleanupChoices`), as before:

1. A discard: ADR-0027 unchanged (a WIP commit for leftovers, then `git worktree remove`, never forced).
2. For each PR of the Job that nobody merged:
   - closed on GitHub if the answer was `close` (`pull_request.closed`, the row recorded `closed`);
   - **then, kept open or closed, a marked comment** saying the factory stopped tracking it (`untrackedComment`, marker `<!-- factory:<job>:untracked -->`, `pull_request.untracked`). A comment already carrying the marker is reused, so a crash between posting and recording never posts two. The poller ignores marked comments anyway;
   - the remote branch deleted only on an explicit `delete` (`DELETE /git/refs/heads/<branch>`, `pull_request.branch_deleted`; a branch already gone counts as deleted, with `alreadyGone: true`).
3. `cleanup.completed`, now with each PR's outcome.

Each step is idempotent by its row or its event, so a crash resumes where it stopped. A GitHub failure writes `cleanup.step_failed` (step, failure kind, status). A transient failure or a rate limit holds that item back until its retry time (5 s, or the rate limit's reset), while other items go on; the same failure is recorded once, not on every retry. A refusal is retried only at the next runtime start, like a failed Worktree removal. A cleanup whose answers changed nothing still runs, for the comments: a kept PR still gets one. A Phase B keep (no PR) still does nothing.

**Task Branches are always kept locally.** The cleanup never touches the Factory Clone's branches. Deleting the remote branch deletes only the ref on GitHub.

**Polling stops** at the cancel, not at the cleanup: the cancel moves `merge_approval` to `cancelled`, and the poller reads PRs only of a Job whose `merge_approval` waits.

## GitHub port and fake

- `GitHubPort.deleteBranch(repo, branch)` → `{ gone }`; a 404 or a 422 "Reference does not exist" is `gone: true`.
- The fake GitHub answers `DELETE /repos/:o/:r/git/refs/heads/:branch` (204; 422 when missing). As GitHub does, it closes an open PR whose head branch was deleted. It gains `comments(fullName, number)` for assertions.

## Known limitations

- Against the fake GitHub only. The real reopen, close, comment and branch deletion are C7's `[real]` run.
- GitHub's refusal is reported with its top-level `message` ("Validation Failed"). The `errors[].message` detail (for example "state cannot be changed") is not read.
- While the PR is closed its `merge` item stays open next to the `pr_closed` item, offering what it offered before.
- A refused cleanup step waits for the next runtime start. The worker records why, but the item shows nothing of it (the events do).
- ~~Once `integration_rewrite`'s `new_pr` exists, an old closed PR of the same Job will need to stop counting as closed.~~ Done in #65 (ADR-0044): a replaced PR (`replaced_by_id`) is left out of `pr_closed`, `ci_failed`, the Merge Gate and polling.
