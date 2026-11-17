# Multi-repository delivery: Delivery Order and the contract step

**Status:** accepted (Phase D design grilling, Q5–Q9, Q19, Q28–Q31; confirmed by the human 2026-11-17).

A Job may touch several Repositories of its Project, each with its own Integration Task, Integration Review and PR (§14). The PRs are never atomic, so we enforce order where the factory can and say so everywhere else.

## Decision

- **Repository set.** `job create --repo` names zero or more. Named: triage can't change the set. None: triage proposes from the Project's Repositories, shown at `plan_approval`; a proposed set of more than one waits for a human even under `planApproval: skip`.
- **Delivery Order** comes from cross-repo dependency edges in the Plan; a cycle makes the Plan invalid. A dependent Task is ready once the Task it depends on is approved, and gets that Task's result summary and diff as read-only context items, never code in its Worktree. The planner must write the contract (the expand-step interface) into the upstream Task's acceptance criteria.
- **PRs open early, merges are ordered.** Each PR opens when its integration is ready. A later Repository's Merge Gate waits ("waits for api#12 to merge") until the earlier PR merged. Under `never_auto` a human can still merge out of order on GitHub; the Delivery Report flags it. Every PR body lists its sibling PRs, the Delivery Order and the not-atomic sentence.
- **One Integration Review per Repository** against the whole Specification, the other Repositories' diffs as context, tied to that Repository's `(head, base)`.
- **The contract step is a follow-up Job,** not a second PR in this Job (one PR per Repository per Job, §14). The planner marks contract Tasks deferred; they don't run. Once every PR merged in Delivery Order, an Approval offers "Start the contract Job for api?" with the deferred Tasks as its description, and the Delivery Report lists the step as pending.
- **Not writable (D5).** Before each Task's first Attempt is dispatched, a preflight checks the Factory Clone is writable and, with GitHub Coordinates, that the token has push permission. A failure blocks the Task with the `repository_not_writable` Blocker and the exact reason; the same Blocker replaces `delivery_failed` for a permission lost at push. Dependent Tasks wait; other Repositories continue.
- **Partial Completion** is not a terminal status: the Job stays `blocked` until a human clears the Blocker or cancels. The Delivery Report shows each Repository's status while blocked and after a cancel.
- **Cancel** opens one cleanup Approval; its questions keep their keys (`worktrees`, `pull_request`, `remote_branch`) in a single-repo Job and become `<repo>.<question>` when there are several.
- **Issue-sourced Jobs:** only the issue's own Repository's PR says `Closes #N`; the others say `Refs #N`.
