# Delivery Report v3, keep-going and the base merge conflict

**Status:** accepted (#44, Phase B). Routine and reversible choices inside ARCHITECTURE §4.4 ("Independent branches keep going"), §8.1, §10 and the Phase B decisions Q1, Q23 and Q24 (PROGRESS.md "Human decisions").

## Keep going

- **One rule, pure.** `executionOutcome` (`@factory/domain`) decides how `execution` stands from the Tasks of the newest Plan, in this order: any Task `ready`, `claimed`, `running`, `verifying`, `in_review` or `changes_requested` → still running; else a `blocked` Task → `waiting_human` (a human Blocker, shown first) or `blocked`; else a `failed` Task → `failed`; else every Task approved → `succeeded`; else unchanged. A Blocker outranks a failure because its Task, and its `pending` dependents, can still make progress once a human clears it. The Job status then follows from the Stage Runs as before (spec issue 9's precedence). `settleExecution` moved to `apps/runtime/src/keep-going.ts`; `execution.ts` re-exports it.
- **Before this ticket**, a failed Task failed `execution` at once, even while independent Tasks were running. Now they finish first.
- **`dependency_failed`.** `stepTask(…, 'failed')` (the engine) cancels, in the same transaction, every unfinished Task that depends on the failed one, directly or transitively (`dependentsToCancel`, pure): one `task.cancelled` event each, with `reason: dependency_failed`, `cancelReason` and the failed Task's key, and `tasks.cancel_reason` set. Every path that fails a Task goes through `stepTask`, so none can miss it. Only `pending` Tasks are found: a dependent is `ready` only once all it depends on is approved.
- **A failed execution still runs `closure`.** Its Delivery Report lists the approved branches as partial results. During closure the Job is `active`; once closure has succeeded it is `failed` (a failed Stage Run, no Stage running). Closure now removes only the Worktrees of approved Tasks: a failed Task's Worktree holds unreviewed work and stays `preserved` (CLAUDE.md §3). Discarding it is the cleanup Approval's job (#48), which this ticket doesn't open for a failed Job (Known limitations).

## The base merge conflict

- When merging a dependent Task's dependencies' approved heads conflicts, the Task goes `claimed → blocked` with the human Blocker `base_merge_conflict` (detail: the dependencies and the conflicting paths), its lease and capacity tokens are released, and `execution` is settled, all in one transaction (`blockOnBaseConflict`, `apps/runtime/src/dependency-base.ts`). No Attempt and no Worktree are made. It is never an automatic replan (Q1).
- **Its Blocker Approval** offers `cancel_job` only. The `replan` option of ARCHITECTURE §8.1 comes with the Requested Replan (#45), which owns the option sets' replan entries.
- **Its subject is the Task.** A Blocker's `attemptId` is the subject of its Blocker Approval. A base conflict arises before its Task has any Attempt, so the Blocker holds the Task's id there. Renaming the field to a subject reference would touch the Inbox (#45's) for no behaviour change; it is noted as a spec issue.
- **A real conflict despite the overlap check.** The Plan validator rejects overlapping writable paths of unordered Tasks, but git still finds conflicts it can't see, such as directory-rename detection: one Task moves every file of `test/` to `spec/`, another adds `test/extra.md`. The scenario uses exactly that.

## Delivery Report v3

`reportVersion: 3`. New and changed fields:

- **`outcome`** (`completed | failed`, from the `execution` Stage Run) and **`statement`**: one plain sentence. A failed Job's says "The Job failed", names the failed Tasks with their exit reasons, and calls the approved branches partial results (or says nothing was approved).
- **`branches`**: every Task of the newest Plan, plus any earlier Task that got a Task Branch, in Plan order: key, title, state, `cancelReason`, branch (`null` when the Task never got a Worktree), head (the approved head, else the latest Attempt's), `leaf` (no Task depends on it) and `fetchCommand`.
- **Which branches are offered** (`deliveryBranches`, pure): one `git fetch` for each approved Task that no approved Task depends on. Its branch holds every approved Task beneath it through the Dependency Base, so this is the smallest set of fetches that brings in all approved work. In a completed Job those are exactly the leaves. A failed or cancelled leaf is listed and never offered; the approved Tasks beneath it are offered instead, as the partial results. A merge Task that failed offers each of its approved dependencies.
- **`notes`**: the Factory Clone's location (ADR-0001, nothing pushed, run the fetches from your checkout), and that independent leaves are not combined before Phase C, so combining them may conflict and the factory has not checked.
- **`tasks`** keeps the detail of each approved Task, without `fetchCommand` (it moved to `branches`).
- **The CLI** (`factory job show`) prints the statement, the clone, each branch with its state (and cancel reason) and leaf mark, the fetch command under each offered one, and the notes. A report written before v3 is not re-read: the CLI says where it is.

## Known limitations

- The `replan` option of `base_merge_conflict` waits for #45; until then the only way on is to cancel the Job.
- A failed Job opens no cleanup Approval for its preserved Worktrees (the cleanup Approval is opened on cancel, #48).
- The Tasks API doesn't expose `cancelReason` yet (the Task is serialized in `jobs.ts`, #45/#48's); the `task.cancelled` event and the Delivery Report carry it.
