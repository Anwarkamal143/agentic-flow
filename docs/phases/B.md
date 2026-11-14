# Phase B — Human in the loop + parallel DAG: phase report

Status: **complete, awaiting human review** (2026-11-14). Phase C has not been started.

## What was built

A Job's Plan now waits for a human at `plan_approval`, the Inbox (API, CLI and dashboard) carries every decision the factory asks for, and a multi-Task DAG runs Tasks in parallel under configurable limits. Questions pause a Task durably, failed reviews route by Fault Origin back to planning or specification, caps end in a human Blocker with options, and a cancel ends in a cleanup prompt. Issues #34–#49, then the code-review fixes:

| Issue | Capability | ADR |
|---|---|---|
| #34 | Prefactor: the review flow and closure split out of Task execution (no behaviour change) | — |
| #35 | `plan_approval` (approve, reject → Job `rejected`), the `approvals` table and the Inbox API/CLI, the derived plan view | 0016 |
| #36 | Plan validation: overlapping writable paths of unordered Tasks, `maxAttempts` may only narrow, Task `priority` and dispatch order | 0017 |
| #37 | Dashboard Inbox (decide, defer, undefer through HTML forms, `Host` + `Origin` checks) and the read-only plan view | 0022 |
| #38 | Plan Edit and "request changes" (a Replan before execution, counted against `maxReplans`) | 0019 |
| #39 | Parallel DAG: global / per-Repository / per-Job concurrency, capacity tokens as leases, the Dependency Base | 0020, 0021 |
| #40 | The integration test tier and the B2 claim race | 0025 |
| #41 | The lease-expiry sweeper | 0024 |
| #42 | Questions during execution (`needs_decision` → durable pause → answer → fresh Attempt) | 0023 |
| #43 | Blocker Approvals for the caps and recovery Blockers (grant +N, retry now / kill and retry, cancel), `audit_log` | 0026 |
| #44 | Keep-going DAG, `dependency_failed`, `base_merge_conflict`, Delivery Report v3 | 0028 |
| #45 | Requested Replan during execution and carry-over (`decideCarryOver`), the `replan_cap_reached` Approval | 0029 |
| #46 | The `plan` Fault Origin route | 0030 |
| #47 | The `spec` Fault Origin route (re-specification and the `spec_change` Approval) | 0031 |
| #48 | Cancel cleanup (one `cleanup` Approval; discard keeps leftovers as a WIP commit, never forces) | 0027 |
| #49 | Live activity (`/v1/activity`, redacted tail, `factory activity`, dashboard `/activity`) | 0018 |

Code-review fixes (merged in `c417bbb`): tests for the review's gaps (B2 with a single contended ready Task, B4 asserting the return to `planning`, the dashboard "Request changes" form with and without feedback); `cancelReason` shown in the Tasks API, `job show` and the dashboard; the Inbox decide dispatched through a kind-to-handler map; the `plan` and `spec` routes dispatched from one module (`fault-route.ts`); a proposal Run's re-prompt, Replan and re-specification context bundled; ADR-0024 records why a heartbeat renewal writes no event.

## Exit tests

| Test | Where | Result |
|---|---|---|
| B1 4-Task DAG, B and C concurrent, D after both approved | `tests/scenarios/parallel-dag.test.ts` ("B1: an A → {B, C} → D DAG") | pass |
| B2 Claim race, 100 iterations | `tests/integration/claim-race.test.ts` (two forked processes, real SQLite in WAL mode; 3 tests × 100 rounds) | pass |
| B3 `needs_decision` → answer → completed, across a restart | `tests/scenarios/questions.test.ts` ("B3: needs_decision opens one Question …") | pass |
| B4 `plan` Finding → planning → re-approval → continues; past `maxReplans` → `waiting_human` | `tests/scenarios/plan-route.test.ts` (both "B4: …" tests) | pass |
| B5 Rework capped at 3 → `waiting_human`, every Attempt kept | `tests/scenarios/blocker-approvals.test.ts` ("B5: Rework capped at 3 …") | pass |
| B6 Plan rejected → Job `rejected`, Artifacts kept | `tests/scenarios/plan-approval.test.ts` ("B6: reject ends the Job rejected …") | pass |
| B7 Cancel during execution → processes stopped, Worktrees `preserved`, cleanup Approval | `tests/scenarios/cancel-cleanup.test.ts` ("B7: cancelling a Job with several running Attempts") | pass |
| B8 Lease expires (heartbeat frozen) → Attempt `interrupted`, never run twice | `tests/scenarios/lease-expiry.test.ts` ("lease expiry (B8)") | pass |

Gate run (2026-11-14, tip `c417bbb`):

```
pnpm install     Already up to date
pnpm typecheck   exit 0 (tsc -b, the tests/ project, the dashboard)
pnpm lint        exit 0 (ESLint, Prettier, "Migrations are up to date with the schema.")

pnpm test        run 1 (default workers, load average ~18 on 16 cores)
                 Test Files 7 failed | 52 passed (59)
                 Tests      9 failed | 403 passed (412)
pnpm test        run 2 (--maxWorkers=4)
                 Test Files 59 passed (59)
                 Tests      412 passed (412)    Duration 306 s
```

The test files are 23 unit, 1 integration (B2) and 35 scenario files. **Run 1 is reported as it happened.** All 9 failures were start-up or test timeouts while the suite itself was loading the machine: 6 were "runtime did not become ready within 10s" (three `api-key-billing` tests, the `replan` cap, `proposal-stages` "plan.valid_globs", and the `claude-code` missing-flag refusal, whose expected startup error was preempted by that message) and 3 were 30 s test timeouts (`dashboard` "no write action outside the Inbox", the `plan-route` B4 cap test, `review` "re-prompts an invalid review once"). None was an assertion on factory behaviour. The 7 failed files, rerun alone, passed (7 files / 47 tests). The second full run passed with nothing changed. The same load-only timeouts are recorded in earlier Phase B work-log entries (#35, #49).

## Known limitations

See `PROGRESS.md` "Known limitations" for the full list. The ones that matter most for review:

- **No 24 h Approval reminder.** Every Inbox Item is `remain_pending` (never auto-approved, never expires); notifications and the reminder are v1.
- **Mixed bases after a Replan.** A carried-over Task keeps its Worktree and `base_sha`; a new root Task starts from the default branch as fetched when its Worktree is made, so the two can sit on different bases. Base staleness is Phase C.
- **Leaves are not combined.** The Delivery Report offers one `git fetch` per approved leaf branch from the Factory Clone and says that combining them may conflict and was not checked. The Integration Branch is Phase C.
- **No `services` locks** (spec issue 24, proposed Phase D). Two Tasks on one Repository (`perRepository` default 2) may share a test database or service unless the Repository's commands use `FACTORY_TASK_ID`.
- **Unredacted spool.** A guarded process's spool (`<home>/run/`) holds its raw output while it runs; its output is redacted when recorded and when the live tail is served. After a runtime crash the spool stays on disk, unredacted, until the next start (stale spools are removed then; a re-attached Run's once its output is recorded).
- Tier 0 is still a guardrail, not isolation.
- The dashboard has no Job-level "request a Replan" or "cancel the Job" action (the Inbox options cover the Replan and cancel choices an item offers), and its client-side live code is exercised over HTTP, not in a real browser.
- The `fault_origin_infrastructure` Blocker opens no Approval; such a Job can only be cancelled or replanned.
- `apps/runtime/src/execution.ts` is still large; verification is the next candidate split.

## Decisions

ADR-0016 through ADR-0031 (`docs/adr/`; ADR-0015, API-key billing, was built between the Phase A gate and Phase B). The Phase B design came from the grilling Rounds 1–4 (Q1–Q29) recorded in `PROGRESS.md` "Human decisions"; the ADRs record the routine choices made while building it. One deviation from the spec, recorded in ADR-0027: a cleanup "discard" keeps Task Branches and commits a Worktree's leftovers as a WIP commit before removing it, because CLAUDE.md §3 outranks the spec's "discard".

## Spec issues for the human

Open items in `PROGRESS.md` "Spec issues". New in Phase B:

- **26** ARCHITECTURE §5/§7 additions from the question protocol (#42): `attempts.questions_json`, `approvals.questions_json`, the `needs_decision` state, cause `answer`, `context.answers`.
- **27** A Blocker's `attemptId` holds the Task's id for `base_merge_conflict` (no Attempt exists yet); proposed rename to `subjectRef`.
- **28** §4.7 doesn't say whether a blocked Task whose item triggered the Replan carries over (#45 cancels it), when a requested Replan is counted, or where its feedback is stored.

Issues 23 (`scope_change` Approval → Phase E) and 25 (clarification engine → Phase D) were decided during the grilling. Issue 24 (`services` locks, proposed Phase D) is still open. The older proposed §5 additions (12–14, 17, 21, 22) are unchanged.
