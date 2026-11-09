# Phase A — Walking skeleton: phase report

Status: **exit tests pass. Waiting for human review** (ROADMAP phase protocol step 5). Phase B has not been started.

## What was built

One internal Job on one fixture Repository goes through intake → triage → discovery → specification → planning → execution (implement, the factory's own verification, an independent review) → closure, which writes a local Delivery Report. Crash recovery and cancellation are included. Issues #2–#15, in order:

| Issue | Capability | ADR |
|---|---|---|
| #2 | Runtime behind a bearer token on 127.0.0.1; `factory init/start/status/stop`; scenario harness | 0002 |
| #3 | `factory doctor` (tools, presence-only credentials) | 0003 |
| #4 | `factory repo add` into a Factory Clone (the user's checkout is never written) | 0001, 0004 |
| #5 | Jobs, versioned transitions, outbox events, SSE with `Last-Event-ID` | 0005 |
| #6 | Harness contract, Fake Harness, proposal Stages with schema-validated Artifacts | 0006 |
| #7 | Task execution in a Worktree under the Tier 0 guardrail, factory verification, local delivery | 0007 |
| #8 | Independent review in a fresh Session, the full approval rule | 0008 |
| #9 | Path-scope Gate, Rework with a cap, Findings routed by Fault Origin | 0009 |
| #10 | Task Result re-prompt; false claims are ignored | 0010 |
| #11 | Redaction at every choke point; `factory logs` | 0011 |
| #12, #13 | Cancel (process-group kill); crash recovery without double execution | 0012 |
| #14 | Claude Code Harness adapter (headless stream-json) | 0013 |
| #15 | Read-only dashboard: live job list and job detail; Attempts record their security tier | 0014 |

## Exit tests

| Test | Where | Result |
|---|---|---|
| A1 Happy path | `tests/scenarios/task-execution.test.ts` ("A1 happy path …"), plus `review.test.ts` | pass |
| A2 Path gate | `tests/scenarios/rework.test.ts` ("A2: a forbidden path …") | pass |
| A3 False claim | `tests/scenarios/task-result.test.ts` ("A3 false claim …") | pass |
| A4 Invalid output | `tests/scenarios/task-result.test.ts` ("A4 invalid output …") | pass |
| A5 Crash recovery | `tests/scenarios/recovery.test.ts` | pass |
| A6 SSE replay | `tests/scenarios/event-stream.test.ts`; through the dashboard: `tests/scenarios/dashboard.test.ts` | pass |
| A7 `[real]` Claude Code | `tests/real/a7-claude-code.test.ts` (`pnpm test:real`, on demand) | passes: it completes, or fails with a specific recorded reason (see #14's work log entry for 4 real runs) |

Last full run (2026-11-09, after #15):

```
pnpm typecheck   exit 0
pnpm lint        exit 0 (ESLint, Prettier, migration drift check)
pnpm test        Test Files 29 passed (29), Tests 187 passed (187)
```

`pnpm test:real` was last run during #14. It wasn't run again for #15, which doesn't touch the Harness.

## Known limitations

See `PROGRESS.md` "Known limitations" for the full list. The ones that matter most for review:

- **A7 depends on the developer installing dependencies itself.** The factory installs nothing in a Worktree (Tier 0 refuses repo setup scripts).
- **Nothing clears a Blocker.** A `waiting_human` or `blocked` Job can only be cancelled. The Inbox, replanning and re-specification are Phase B.
- **Tier 0 is a guardrail, not isolation.** The network is not enforced, and the Harness runs as the operator's user.
- **API-key billing is not built.** It is decided as option (b), after this gate.
- **The dashboard has two pages only.** Its client-side live code (EventSource, refresh) is exercised over HTTP by the tests, not in a real browser.
- `apps/runtime/src/execution.ts` is ~2,100 lines. A split is a candidate follow-up.

## Decisions

ADR-0001 through ADR-0014 (`docs/adr/`), plus the human decisions recorded in `PROGRESS.md`: answers to the §7 questions, Findings from Gates, routing of blocking Findings only, the exhausted-script guard, and API-key billing (b).

## Spec issues for the human

Open items in `PROGRESS.md` "Spec issues". Most are proposed additions to ARCHITECTURE §5 for columns that Phase A added (issues 12–14, 17, 21, 22). Issues 15, 13, 7 and 8 were decided on 2026-11-09 (PROGRESS.md "Human decisions"); the spec was amended to match.
