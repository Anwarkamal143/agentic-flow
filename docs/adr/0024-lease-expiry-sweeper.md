# The lease-expiry sweeper and its test knobs

**Status:** accepted (#41, Phase B, ROADMAP exit test B8). Routine and reversible choices inside ARCHITECTURE §12 step 6 and the Phase B grilling (Q6). Builds on ADR-0012 (spools, pid plus start time, `decideRecovery`) and ADR-0020 (capacity tokens). Closes ADR-0012's limitation "lease expiry is recorded and renewed but not yet read by anything".

## The tick

- **The heartbeat tick is the sweeper's clock.** `heartbeatTick` (`apps/runtime/src/sweeper.ts`) runs on every Task-scheduler heartbeat (`renewLeases` in `execution.ts` now only calls it): it renews every lease this runtime holds (holder `runtime:<pid>` or `runtime:<pid>/<attempt>`), then sweeps. The renewal moved into `sweeper.ts` unchanged.
- **A renewal is not a state change, so it writes no event.** It moves only a lease's `heartbeat_at` and `expires_at`, which are liveness bookkeeping: no Task, Attempt, Worktree or Stage Run changes, and nothing a reader of the state tables decides on except the sweeper's own expiry check. CLAUDE.md §2's outbox rule (an event in the same transaction as each state change) therefore doesn't apply. An event per lease every 15 s would also bury the log (ARCHITECTURE §12 step 4 asks for the heartbeat, not a record of it). The renewal is one `UPDATE` statement, which SQLite runs atomically on its own, so every lease of this runtime moves together and no explicit transaction is needed. What a lease's expiry leads to (the sweep) is a state change, and it is recorded with its events in one transaction (below).
- **What expires:** a `task` lease whose `expires_at` is in the past. Capacity tokens and port blocks share the Task lease's fate (ADR-0020); they are never swept on their own.
- **One sweep per Task at a time.** A Task being swept is skipped by later ticks until its sweep ends.

## What a sweep does

1. **Stop the process.** The Attempt's recorded process (`process_json`) is stopped only if it is alive and provably ours: pid plus start time from its spool (ADR-0012's `stopIfAlive`: group SIGTERM, then SIGKILL after the grace period). Nothing else is ever signalled.
2. **Stop the slot, if it is in this runtime.** An expired Attempt can still be in flight here (its heartbeat stopped, its slot did not). The Attempt is marked swept in memory (`sweptAttempt`), and the slot's existing stop check (`stopped()` in `execution.ts`, already called after every process ends and before every new one starts) returns `true` for it, so the slot records nothing more and leaves. The sweep waits for the slot to end, **but only once the process is confirmed dead**: a slot waiting on a process that can't be stopped may never end. Waiting first means nothing the slot does lands after the Attempt's end, and the Retry's claim never meets the old slot (slots are keyed by Task id).
3. **Decide** (pure `decideExpiry`, the same rules as crash recovery):
   - The process is **confirmed dead** when its spool says `dead` (gone without an exit status) or `finished` (exit status written), when the slot in this runtime saw it end and recorded that (its spool is then removed), or when no process was recorded (the Attempt was between processes). Anything else (`alive` after the kill, or a spool with no readable pid) is **unconfirmed**.
   - Unconfirmed → `blocked`, `recovery_uncertain`. The process record stays on the Attempt and its spool is kept, for whoever checks again ("retry now", #43, re-checks pid and start time).
   - Confirmed dead, Worktree unknown → `blocked`, `recovery_uncertain`, Worktree `quarantined`. Dirty → `recovery_uncertain` (a Retry could build on half-done work). No Retry left (`maxRetries`) → `retry_cap_reached`. Otherwise → a **Retry**: the Task goes `ready`, and the next claim makes a `cause: retry` Attempt in the same Worktree.
4. **Record, in one transaction:** the Attempt `interrupted` (`exit_reason: interrupted`; the event carries `cause: lease_expired`, `expiresAt`, `process: dead | unconfirmed`, `observed` (the spool state), `worktree` and `decision`), the Task `ready` or `blocked` with its Blocker, the Worktree `preserved` (or `quarantined`), the Task lease with its capacity tokens and the port block released (`releaseAttemptTokens`), and `execution` settled. The Attempt's spool directory is removed afterwards when the process is confirmed dead.

- **ARCHITECTURE §12 step 6 says "requeue only if confirmed dead".** We read that as a necessary condition and keep ADR-0012's other two (a clean Worktree, a Retry left), so a lease expiry and a crash end the same way.
- **A claim that expires before its Attempt starts** (nothing ran) is given back: lease and tokens released, Task `claimed → ready` (`reason: lease_expired`). If it is still being set up in this runtime, it is left alone; its Attempt is swept once it starts.
- **Shutting down mid-sweep** records nothing: the Attempt is left for recovery at the next start.
- The sweeper's actor is `system:sweeper`. It never starts a process, so no Attempt runs twice.

## Test-only knobs (ADR-0012 style)

- `FACTORY_TEST_FREEZE_HEARTBEAT=1`: the tick never renews a lease; it still sweeps. Any other value stops the runtime at startup (`unknown FACTORY_TEST_FREEZE_HEARTBEAT: <value>`).
- `FACTORY_TEST_LEASE_TTL_MS=<positive integer>`: every lease (Task, tokens, port block) lasts that long instead of 90 s, and the heartbeat ticks every third of it (at most every 15 s), so expiry is noticed promptly. Anything but a positive integer stops the runtime at startup.
- Unset, neither has any effect. Both are read before anything else in `main.ts`, so a bad value fails before any lease is taken.

## Tests

`tests/scenarios/lease-expiry.test.ts` (B8): with the heartbeat frozen and a 1.5 s TTL, a hung developer Run's Attempt is interrupted, its process group is dead, the Task gets one Retry (which also hangs and expires), then `retry_cap_reached`; exactly one `harness_run.started` per Attempt id; the Worktree reused and `preserved`; a second Job on the same Repository with `perRepository: 1` still starts (no token leaked). A second scenario removes the spooled pid: the Attempt is interrupted, the Task `recovery_uncertain`, no Retry, and the process is left running. A third refuses unknown knob values.

## Known limitations

- The in-memory "swept" mark lives only in this runtime. A slot left waiting on an unconfirmed process stops at its next check whenever that process ends; if an operator's "retry now" (#43) re-claims the Task before then, the old slot's map entry is replaced. #43's pid re-check stops a live process first, which ends that slot.
- With one runtime per home, an expired lease means this runtime's heartbeat stopped; the freeze knob is the only way to cause that in tests. Several runtimes on one database (#40's tier) are not exercised against the sweeper.
- A process that leaves its group (`setsid`) is not stopped (ADR-0012), so "confirmed dead" speaks for the group leader only.
