# Cancellation and crash recovery (Phase A, issues #12 and #13)

Choices made while making a Job cancellable mid-Attempt and making a runtime crash lose nothing and run nothing twice (ROADMAP exit test A5). All are routine and reversible except where marked; spec issue 6 is settled here.

## Process spools: a guarded process outlives the runtime

- **Every guarded process has a spool** (`<home>/run/<attempt-id>/<label>/`, or `<home>/run/<stage-run-id>-<n>/` for a proposal Run). The process group's leader is a small `sh` wrapper (`packages/harness/src/guardrail.ts`) that writes the start time (`ps -o lstart=`, C locale, UTC), its pid, the command's combined output, and, when the command exits, its exit status, each written atomically (temp file plus `mv`). There are no pipes to the runtime, so a crashed runtime takes nothing with it: the process keeps running, its output keeps landing in the file, and nobody gets SIGPIPE.
- **A process is "ours" only by pid plus start time.** `inspectSpool` reports `alive` (the pid exists and `ps` gives the recorded start time), `finished` (the exit status was written), `dead` (gone without one) or `none` (no spool or no pid). A reused pid has a different start time, so it is never mistaken for ours.
- **The raw output in a spool is transient.** It is read through the runtime's redaction into a `log` Artifact (ADR-0011), and the spool is removed once the Run's end is recorded, or when the Attempt ends. At startup, recovery removes every spool no Attempt in progress refers to. Between a crash and the next start, a spool can hold an unredacted secret in the factory home (mode 0700); see the known limitations.
- **The Attempt records its process before it starts.** `attempts.process_json` (kind `harness` or `verification`, role, run number, spool, start time, wall-clock limit, then pid, execution id and the Harness's re-attach token) is written before `harness.start` and cleared in the transaction that records `harness_run.finished`. So a Harness process always has a record, and a missing record means no process (or one already recorded as finished).
- **The Harness contract** gains `HarnessStartInput.spool`, `HarnessRun.process` (`{pid, token}`) and an optional `AgentHarness.reattach({spool, token, startedAt, limits})`, which watches a process to its end and never starts one. The Fake's token names the response it gave (developer or reviewer, Task key, run number), so a re-attached reviewer gets the same scripted output. The Claude Code adapter will spool its stream-json the same way.
- **The Fake keeps its Run counts in a file** next to its script (`<script>.runs.json`), so a restarted runtime gives the next start the next response, as a real Harness would do new work. Before this, a restart replayed the first response.

## Cancellation (#12)

- **Cancel is one operation in two steps.** First, one versioned transaction cancels every unfinished Stage Run, now running ones included, and the Tasks that are not in flight (`pending`, `ready`, `blocked`, `changes_requested`), and writes `job.cancelled`. The Job is `cancelled` from that commit on. Then the runtime stops the work in flight and the API waits for it: the scheduler whose slot holds the Job cancels its Harness Run or verification command, then records the Attempt `cancelled` (exit reason `cancelled`, its head read from git), the Task `cancelled`, the Worktree `preserved` (never removed) and the leases released, in one transaction. A last sweep cancels any Task the work moved on just before it stopped. `POST /v1/jobs/:id/cancel` returns the Job after all of that.
- **Graceful, then forced, for the whole group.** `cancel()` sends SIGTERM to the process group, waits until no process of the group is left or the 5 s grace period ends, then sends SIGKILL to what is left, and settles only when the group is gone. Before this, SIGKILL followed the leader's exit at once, so a process that handled SIGTERM got no grace.
- **A proposal Stage is cancelled the same way**: its Harness Run is cancelled and nothing more is recorded for the Stage Run, which the cancellation already ended. A running Stage is no longer a reason to refuse a cancel (`stage_running` is gone).
- **The CLI waits** up to 30 s for the cancel (the grace period plus slack) and re-reads the Job up to three times on `version_conflict`, because a Job in flight changes version as its work moves on.
- Cleanup prompts (PRs, remote branches) are Phase B (PRODUCT_SPEC §12) and not built.

## Crash recovery (#13)

- **Recovery runs at startup, before the schedulers and before the API listens** (`apps/runtime/src/recovery.ts`), and only with a Harness configured. It never starts a process. For each Task in `claimed`, `running`, `verifying` or `in_review` it reads the facts and the pure `decideRecovery` (`@factory/domain`) decides:

  | Attempt state | Recorded process | Worktree | Action |
  |---|---|---|---|
  | any | any | unknown (missing, or git can't read it) | `interrupted`, Worktree `quarantined`, recovery Blocker `recovery_uncertain` |
  | `running` | alive or finished | clean or dirty | **re-attach**: watch the developer Run to its end (or read what it left), then go on as usual |
  | `running` | dead or none | dirty | `interrupted`, Worktree `preserved`, recovery Blocker `recovery_uncertain` |
  | `running` | dead or none | clean | `interrupted`, Task `ready` for a **Retry**, unless the Retries are used up (Blocker `retry_cap_reached`) |
  | `verifying` | any | clean or dirty | **resume**: run the factory's own verification again (a live verification command is stopped first; leftovers become the WIP commit as always) |
  | `in_review` | alive or finished | clean or dirty | **re-attach** to the reviewer Run |
  | `in_review` | dead or none | clean or dirty | **resume**: run the review again at the same head (the review was never stored, so nothing is regenerated) |

  A `claimed` Task with no Attempt started (nothing ran) goes back to `ready`. A cancelled Job's Attempt in progress is stopped and recorded `cancelled`.
- **No second process beside one that could be alive.** Only `reattach` leaves a process running. Every other outcome first stops a live process that is provably ours (SIGTERM, then SIGKILL). A Retry's new Harness process starts only after that. A Harness process that is alive but whose re-attach token was never recorded (the crash came between its start and that transaction) can't be watched, so it is stopped and counts as dead. A spool no Attempt in progress refers to (a proposal Run's, whose Stage starts again) has its live process stopped before the spool is removed. The group of a **dead** leader is left alone: without the leader's start time nothing proves the group is still ours, and after a reboot or a pid reuse it may not be. The decision is logged, and the Attempt's events record it (`attempt.interrupted` with the process and Worktree state; `harness_run.reattached`).
- **Leases have a heartbeat.** A lease now expires 90 s after its last heartbeat (`LEASE_TTL_MS`), and the Task scheduler renews every lease it holds every 15 s (`LEASE_HEARTBEAT_MS`); `attemptLeaseMs` (the whole-Attempt budget) is gone. Recovery hands the leases of what it carries on with to the new runtime, and releases the rest with the Attempt's end. In a single-runtime home, the runtime record already guarantees the previous runtime is dead, so recovery decides by the process, not by lease expiry; expiry matters once there is more than one runtime.
- **Resuming reads the database, not memory.** The Attempt's steps (develop, verify, review) were split so each starts from the stored rows: `developer_exit_json` and the usage (added up per developer Run as it is recorded) for verification; the head, the commits and the recorded verification runs (with their output from the `log` Artifacts) for the review. So a resumed step and a normal one are the same code.
- **Stored proposals are never regenerated.** Recovery only touches Tasks; finished Stage Runs and their Artifacts stay as they are. A proposal Stage Run left `running` starts again as before (ADR-0006): its Fake Run is in-process and nothing was stored for it.
- **A closure left `running` resumes** from its stored Delivery Report (never a second one), removes the Worktrees, and completes. To prove it, the runtime has one **test-only fault injection point**: `FACTORY_TEST_CRASH_AT=closure.after_report` makes it SIGKILL itself right after recording the report. Unset, it does nothing; an unknown value stops the runtime at startup.

## Spec issue 6: Attempt cause and `max_retries` (settled)

- **`attempts.cause` is `initial | rework | retry`** (no derivation from the previous exit reason: the cause is what the Attempt was started as, and it is shown in the API). An Attempt after an `interrupted` one is a `retry`; after a failed Gate or review, `rework`.
- **`maxRetries` is separate from `maxAttempts`.** It is a new Effective Configuration value (recipe default 2, Project-settable 0–10, frozen on the Job, stored on the Task as `tasks.max_retries`). Jobs created before this get the default. `maxAttempts` now caps Rework only: `attemptsCountedForRework` counts every Attempt but a Retry, and that count is what `routeFailedAttempt` compares with the cap.
- **What a Retry carries.** It redoes the interrupted Attempt, so it gets that Attempt's packet's prior Findings and adds none of its own (GLOSSARY: Retry "carries no Findings").
- **What is a Retry, in Phase A:** only an Attempt interrupted by a runtime crash. A Harness Run that times out or crashes while the runtime is alive is still `harness_failed` (it fails the Task, ADR-0007); retrying those, and backoff, are left for later. The in-Attempt repeats are as spec issue 6 says: the one `invalid_output` re-prompt, and the review run again at an unchanged head after a crash.

## Known limitations

- Between a crash and the next start, a spool holds the process's raw, unredacted output in the factory home.
- A Harness process that leaves its process group (`setsid`) is not found or stopped. Neither is a child that outlived a dead group leader (see above). Tier 0 is a guardrail, not isolation.
- ~~Lease expiry is recorded and renewed but not yet read by anything.~~ Resolved by #41 (ADR-0024): the heartbeat tick sweeps expired leases. No scenario exercises a crash in the window between a Harness start and its token being recorded.
- A crash between `addWorktree` and the transaction that records the Worktree leaves a directory with no row; the next claim of that Task then fails with `factory_error` (the directory is never deleted).
- A crash after a developer Run's end is recorded but before the Attempt moves to `verifying` gives a Retry (the Run's outcome is known only from events), not a resume.
- Proposal Harness Runs are not re-attached (the Fake's are in-process); the Stage starts again.
- Recovery waits for the grace period while it stops a live verification command or a cancelled Job's process, so a start can take up to 5 s per such Attempt.
