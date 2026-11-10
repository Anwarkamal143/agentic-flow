# Cancel cleanup: one `cleanup` Inbox Item, then a discard from the decision

**Status:** accepted (#48, Phase B, ROADMAP exit test B7). Routine and reversible choices inside PRODUCT_SPEC §12, ARCHITECTURE §10 and the Phase B grilling (Q8). Builds on ADR-0012 (cancel in two steps, group SIGTERM then SIGKILL), ADR-0016 (Inbox Items) and ADR-0020 (capacity tokens).

## Order

`JobService.cancel` keeps ADR-0012's two steps and adds a last transaction:

1. One versioned transaction: unfinished Stage Runs, Tasks not in flight and open Inbox Items `cancelled`, `job.cancelled`.
2. The schedulers stop every slot of the Job (graceful, then forced, per process group) and record each Attempt `cancelled`, its Task `cancelled`, its Worktree `preserved`, and its Task lease, capacity tokens and port block released, in the Attempt-ending transaction.
3. **Last transaction:** a Task the stopped work moved on, and an item it opened just before it stopped (for example a Question), are cancelled too. Only then is the Job's one `cleanup` item opened.

So `approval.opened` for the cleanup item comes after every `attempt.cancelled`, `task.cancelled`, `worktree.preserved` and `approval.cancelled` of the cancel (the B7 scenario asserts it on event seqs).

## The item

- Kind `cleanup`, subject the Job id, no Stage Run, no Task. Question "Discard the N preserved Worktrees?". Options `keep` (recommended, the default) and `discard`, from `CLEANUP_OPTIONS` (`@factory/domain` `cleanup.ts`). `expires_policy` is `remain_pending`, as for every item: nothing is ever decided for the human.
- **At most one per Job**, and **none when the cancel left no preserved Worktree** (say, a cancel during triage). An item asking to discard zero Worktrees asks nothing. Phase C adds the PR and remote-branch questions to the same item, so it will then be opened when any of them applies.
- Quarantined Worktrees (unknown state after a crash) are never counted or discarded.
- `approval.opened` records the Worktrees it covers (id, Task, path).
- **No schema change:** the existing `approvals` table holds it.

## The decision

- It goes through the generic `POST /v1/inbox/:id/decide` and `checkInboxChange` (version, subject, human actor), so `factory inbox decide <id> keep|discard` and the dashboard's generic decide form work with no new route or UI. `inbox.ts` gains one dispatch line to `applyCleanupDecision` (`apps/runtime/src/cleanup.ts`).
- The decide transaction only records the decision. `keep` changes nothing more.
- **`discard` is carried out after the commit, from the persisted decision**, by `CleanupWorker` (a `PassLoop`, woken on every commit and every 5 s). For each of the Job's `preserved` Worktrees:
  1. **Leftovers are committed first.** CLAUDE.md §3 ("never discard uncommitted changes") outranks the spec's "discard", so whatever a cancelled Attempt left uncommitted becomes one flagged WIP commit on its Task Branch (`Factory-WIP: true`, one `Factory-WIP-Path` per path). This is the same mechanism as the WIP commit after a developer Run, factored out of `execution.ts` into `commitLeftovers` (`worktree.ts`). The commit is recorded as `worktree.wip_committed` (its sha and paths).
  2. **Removed, never forced:** `git worktree remove` in the Factory Clone. git refuses a Worktree that still holds anything uncommitted, so nothing can be lost.
  3. One transaction moves the row `preserved → removed` (`worktree.removed`, with the approval id and `wipCommit`, or `null` when there was nothing to commit). The row says `removed` only once the directory is gone.

  When every Worktree is removed, `cleanup.completed` (on the approval) marks the item finished.
- **The discard removes directories, never work.** The option's description says leftovers are kept as a WIP commit on the branch. `@factory/git` `removeWorktree` is unchanged and still never forces.
- **Task Branches are kept.** `git worktree remove` leaves the branch and its commits in the Factory Clone. The discard scenario checks each branch's old tip is the WIP commit's parent, and that the WIP commit holds the leftovers.
- A WIP commit or removal that fails records `worktree.remove_failed` (`step`: `wip_commit` or `remove`, the `wipCommit` if one was made, git's message) and leaves the row `preserved`. No `cleanup.completed` is written, and the worker tries that item again only at the next runtime start.
- **No Delivery Report entry.** A cancelled Job never runs closure, so it has no Delivery Report. The WIP commit is on the events and on the branch (`git log` shows the `Factory-WIP` trailers).

## Crash safety

- A discard cut short by a crash resumes at the next start: the worker picks every decided `discard` item without `cleanup.completed`, and each Worktree's removal is idempotent by its row state.
- A cancel cut short between its steps leaves no cleanup item. At startup, after recovery and before the API listens (so no cancel is in progress), `openMissingCleanupItems` opens one for every cancelled Job with a preserved Worktree and none yet. A home with Jobs cancelled before #48 gets an item for each of them at its first start, which is the question those cancels never asked.

## CLI

`factory job cancel` prints, after the Job, `Cleanup Approval <id>: Discard the N preserved Worktrees? (default: keep; Task Branches are always kept)` and the `factory inbox decide` command line, or `No cleanup Approval: the cancel left no preserved Worktree.` It finds the item with `GET /v1/inbox?all=true` (the cancel response is still the Job).

## Known limitations

- Neither crash path (a cancel cut short before its last transaction; a discard cut short by a crash) is exercised by a scenario: there is no fault-injection point for them.
- The removals are not under the per-clone git setup lock (ADR-0020), like closure's; a discard and another Job's Worktree setup on the same clone could race on git's lock files.
- The dashboard has no "cancel the Job" action yet, so a cancel starts from the CLI or the API; its cleanup item is decided anywhere.
