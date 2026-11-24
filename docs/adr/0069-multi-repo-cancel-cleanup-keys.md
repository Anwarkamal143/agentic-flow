# Multi-repo cancel cleanup: per-Repository question keys

**Status:** accepted (Phase D, #109; builds the "Cancel" part of ADR-0052 on ADR-0027 and ADR-0043). The choices below are routine and reversible.

## Context

ADR-0052 decided that cancelling a Job opens one cleanup Approval whose questions keep their keys (`worktrees`, `pull_request`, `remote_branch`) in a single-repo Job and become `<repo>.<question>` when there are several. Until now the item asked about the whole Job at once: one `worktrees` question over every preserved Worktree, one `pull_request` over every open PR and one `remote_branch` over every pushed branch, whatever their Repository.

## Decision

- **The questions.** The pure `jobCleanupQuestions(repositories)` takes the Job's Repositories, each with its own `CleanupScope` (its preserved Worktrees, its open PRs, its PRs' head branches). A Job with one Repository is asked `cleanupQuestions(scope)` exactly as before, keys and text unchanged. A Job with several asks each Repository its own questions, keyed `<repo>.<question>` (`cleanupKey`), the text led by `<repo>: `; a Repository with nothing to ask is left out, and the others stay prefixed. The Repositories are asked by name (ties by id), the order the Delivery Report lists them by name too. The title counts every question; the reason names each Repository's leftovers (`cleanupItemText`).
- **The prefix is the Repository's name**, which is unique in its Project, and a Job's Repositories are one Project's (ADR-0065). A name may hold dots (it is the source directory's basename), so `splitCleanupKey` splits at the last dot: a question id never holds one.
- **Answers.** `checkCleanupAnswers` checks the "delete the branch of a PR kept open" pair per Repository: `web.remote_branch=delete` needs `web.pull_request=close`, whatever api's answers. A bare key names no question of a multi-repo item (`unknown_question`).
- **Carrying out.** `cleanupChoices(decision, repository?)` reads only that Repository's `<repo>.<question>` answers. The worker discards the preserved Worktrees of each Repository whose `worktrees` was answered `discard`, and closes, comments on and deletes the branch of each PR by its own Repository's answers. Whether an item's answers are prefixed is read from its stored question keys (a bare key holds no dot), so an item opened before this change keeps meaning what it said.
- **`QuestionAnswer.questionId` takes up to 300 characters** (was 40): a Repository name may be up to 255. A wider bound, not a looser check: the runtime still refuses any id the item does not ask.
- **The dashboard** accepts `<repo>.` before a cleanup question id in its form fields, and its "deleting the branch needs close" hint and reset work per Repository. The CLI's cancel output already printed each question's key; its help gives the prefixed form, and CLAUDE.md §6 documents it.

## Consequences

- A multi-repo cancel shows per-Repository questions, each defaulting to keep; the single-repo cleanup scenarios (`cancel-cleanup`, `pr-closed`) pass unchanged.
- Tests: unit `cleanup` (+8: the prefixed keys and text, single-repo unchanged, a Repository with nothing left out, the pair per Repository and a bare key refused, per-Repository choices, a dotted name, the title and reason); scenario `multi-repo-delivery` (+1: a cancel with both PRs open, the CLI's prefixed keys, a bare key and a crossed pair refused, `web.pull_request=close web.remote_branch=delete` closing and deleting only web's while api's PR and branch are kept, both PRs given the untracked comment).
