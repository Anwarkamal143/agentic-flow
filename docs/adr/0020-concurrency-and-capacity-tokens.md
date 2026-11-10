# Task concurrency and capacity tokens

**Status:** accepted (#39, Phase B). Routine and reversible choices inside ARCHITECTURE §12 steps 1–5 and the Phase B grilling. Supersedes ADR-0007's "a separate Task scheduler, one slot" for Task execution; the proposal `StageScheduler` keeps its one slot.

## The limits

- **Global:** `config.json` `concurrency.global` (1–64, default 3, `DEFAULT_GLOBAL_CONCURRENCY`). It is operator configuration, read at startup, not part of any Job.
- **Per Repository and per Job:** the Effective Configuration's `concurrency.perRepository` / `concurrency.perJob` (1–16, default 2 each, Project-settable, from b89e58f). A Job may override either **at creation**, up or down (`POST /v1/jobs` `concurrency`, `factory job create --per-repository N --per-job N`). An override is recorded with source `job` (new `ConfigSource`), and frozen with the rest of the snapshot. The concurrency limits are not permission-related, so §15's "lower levels only narrow" does not apply to them.
- The per-Repository limit is the **claiming Job's** value, counted over every Job's Tasks on that Repository. A Job allowed 4 on a Repository can push the count past a neighbouring Job's limit of 2; the neighbour then claims nothing on that Repository until the count is below its own limit.

## Capacity tokens are leases

- A token is a row of the existing `leases` table (no migration): `capacity.global` `<i>`, `capacity.repository` `<repository-id>:<i>`, `capacity.job` `<job-id>:<i>`, where `i` is a slot number below the limit. The primary key `(resource_kind, resource_id)` makes a slot impossible to hold twice, so even a racing second writer can't double-hold a token.
- The pure `claimCapacity` (`@factory/domain`) decides: a limit is full when that many tokens of its scope are held; otherwise the claim takes the lowest free slot of each kind.
- **One transaction** (`claimNextTask`, `apps/runtime/src/claim.ts`, `BEGIN IMMEDIATE` through `changeJob`): read the held tokens, decide, insert the Task lease `('task', id)` and the three tokens with `ON CONFLICT DO NOTHING`, then `ready → claimed` (and `execution` `queued → running`). Any refusal (not ready, already leased, a token taken, a limit full) throws inside the transaction, so nothing is written and the Job version is not bumped. `task.claimed` carries the lease id and the tokens.
- The tokens share the Task lease's `lease_id`. `releaseAttemptTokens` releases them with the Task lease, in the transaction that ends the Attempt (every end: approved, Rework, Blocker, failed, cancelled, recovery). Recovery's lease take-over moves them with the Task lease (`takeOverClaim`). They are renewed by the existing heartbeat (same holder).
- `claimNextTask` walks the ready Tasks in dispatch order (ADR-0017) and claims the first that fits; a full global limit ends the walk. It is exported (also from `execution.ts`) for the B2 integration tier (#40). In production only the runtime's Task scheduler calls it: one writer.

## Dispatch order: the MVP form of §12's formula

Unchanged from ADR-0017: priority weight, then time ready, then plan order. A Task that doesn't fit (its Job or Repository is full) is skipped, and a later one that fits is claimed: no head-of-line blocking across Jobs or Repositories. Aging and the project share penalty are v1.

## The multi-slot scheduler

- Each pass starts, without waiting: the Attempts recovery left to carry on with, every queued closure, then claims until `claimNextTask` returns nothing. Each runs in its own **slot** (an Attempt by Task id, a closure by Stage Run id) that records the process it waits on (Harness Run or verification command). A slot's end wakes the loop.
- `cancelJob` stops every slot of the Job (graceful, then forced) and waits for each to record its end. `close` (shutdown) stops every slot and leaves the Attempts for recovery, as before.
- **Git setup is serialized per Factory Clone.** Fetch, the Dependency Base (ADR-0021), `info/exclude` and `git worktree add` run under a per-clone lock in the runtime, because concurrent `git fetch` and `worktree add` in one repository race on its lock files. Everything else (Harness Runs, verification, reviews, WIP commits in each Worktree) runs concurrently.
- **Each Attempt keeps its own port block** (ADR-0007): the block is leased in the Attempt's start transaction, so two concurrent Attempts never share one.

## Not built

Per-project capacity (v1), per-harness capacity and usage-window pausing (Phase E). Repository-profile `services` locks (spec issue 24): two concurrent Tasks on one Repository may share a test database unless its commands use `FACTORY_TASK_ID`. The lease sweeper that acts on expiry is #41.
