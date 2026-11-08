# Progress

> Durable implementation status. Read at the start of every session; update at the end of every work unit.

## Current phase

**Phase A — Walking skeleton** (not started)

## Human answers (from CLAUDE.md §7)

| # | Question | Answer | Date |
|---|---|---|---|
| 1 | Single-user vs multi-user | **Single local user for MVP.** One operator + API token. Actors are `user:local`, `agent:<harness>/<attempt>`, `system:<component>`. Keep an identity extension point. RBAC and separation of duties are not chosen (they would come in Phase E only if multi-user is chosen later). Don't build RBAC. | 2026-11-08 |
| 2 | Claude subscription vs API key | **Both. Subscription is primary, API key also supported.** Subscription: cost is `unknown/subscription`, and usage-window pauses (`paused_until` per harness account) count as capacity, not failure. API key: a price-table estimate marked `estimated`. MVP records usage only. Budgets are v1. | 2026-11-08 |
| 3 | Docker available | **Not currently available** (daemon not running, no docker.sock). MVP uses Tier 0 (local guardrail, never called a sandbox). Revisit Tier 1 (container) at Phase E. | 2026-11-08 |
| 4 | GitHub test account / repo | **Account `Anwarkamal143`. A new dedicated throwaway repo, to be created by the user before Phase C** (suggested name `Anwarkamal143/factory-sandbox`). Used only for the `[real]` tests (C7). Never use existing repos. | 2026-11-08 |
| 5 | License | **MIT** (copyright Anwarkamal143, 2026). Adding the `LICENSE` file during Phase A is fine. | 2026-11-08 |

Source: relayed from another Claude session (s-factory-dc) on the user's behalf, 2026-11-08. None of these block Phase A.

## Phase status

| Phase | Status | Exit tests | Report |
|---|---|---|---|
| A — Walking skeleton | Not started | 0 / 7 | — |
| B — Human-in-the-loop + DAG | Not started | — | — |
| C — GitHub delivery | Not started | — | — |
| D — Multi-project, multi-repo, onboarding | Not started | — | — |
| E — Policy hardening, budgets, evals | Not started | — | — |
| F — Later | Not started | — | — |

## Work log

<!-- newest first: date — what changed — tests run (pass/fail counts) -->

## File ownership (active parallel workstreams)

<!-- owner → globs; clear when the workstream is merged -->

## Decisions (ADR index)

- ADR-0001 — The factory works in its own clone, never in the user's checkout — `docs/adr/0001-factory-owned-clones.md`

## Known limitations

## Blockers

## Spec issues

<!-- conflicts or gaps found in docs/spec/*; propose a fix -->

Logged 2026-11-08 during the glossary grilling, Round 1 (see `GLOSSARY.md`):

1. **"Agent" in identifiers.** The glossary avoids "Agent", but ARCHITECTURE §6 has `interface AgentHarness` and §16 has the actor prefix `agent:<harness>/<attempt>`. Decision: keep both identifiers as specified, and avoid "Agent" only in domain prose and UI.
2. **No record of Harness Runs outside Attempts.** ARCHITECTURE §5 has no table for Harness Runs during triage, discovery, specification or planning. They hang off `stage_runs` with no record. Proposed fix: `harness_runs(id, stage_run_id, attempt_id?, role, harness_id, session_ref, started_at, finished_at, exit_reason, usage_json)`. Add it in Phase A only if exit tests A1–A7 need it; otherwise define the interface only.
3. **The `approvals` table holds both Questions and Approvals** (via `kind`), which overloads the glossary term "Approval". Decision: keep the table name as specified, with the umbrella concept "Inbox Item".
4. **RESOLVED 2026-11-08 (human decision): Worktrees come from a Factory Clone, starting in Phase A.** The user's checkout is never written to. Registering by path clones from that repo's `origin` URL (using `--reference`), or from the path itself when there is no remote (fixtures). Applied in ARCHITECTURE §5/§10, PRODUCT_SPEC §13, ROADMAP Phase A + A1. See `docs/adr/0001-factory-owned-clones.md`.
5. **RESOLVED 2026-11-08 (human decision): Integration Review added** as stage `integration_review` (Phase C), after integration and before `pull_request`. Skipped for single-task Jobs where integration changed nothing. Applied in ARCHITECTURE §9/§14, PRODUCT_SPEC §4, ROADMAP exit test C8.

Logged 2026-11-08, Round 2:

6. **Attempt cause and retry limit.** `attempts` has no field saying why the Attempt exists. Proposed: `attempts.cause: initial | rework | retry`, or derive it from the previous Attempt's `exit_reason`. There is also no separate `max_retries`: give it a config default, separate from `max_attempts`, which caps Rework only. Inside one Attempt only two repeats are allowed: the single `invalid_output` re-prompt, and re-running a crashed review Harness Run (head_sha unchanged). A usage-window pause is capacity, never a Retry or Rework. Write an ADR if the limits turn out non-obvious.
7. **The `never_auto` and `human_approval` merge policies aren't distinguished** (PRODUCT_SPEC §9). Proposed reading: under `never_auto` the factory never merges; it waits for a human to merge on GitHub, which polling detects. Under `human_approval` the factory merges after an Inbox Approval. While it waits on the external merge, the Job is `waiting_human` with a human-kind Blocker. A PR closed without merging opens an Inbox Question and never auto-cancels the Job. Phase C scope.
8. **No human-initiated replan during execution.** Today replanning happens only through the `fault_origin: plan` route or the pre-approval "replan" action. Proposed: a `requestReplan` API operation in Phase B. Each replan writes a new plan Artifact; Tasks in `approved`/`integrated` and unaffected pending Tasks carry over; the count is capped by `max_replans`. Not in Phase A.
9. **Job status precedence (clarifies ARCHITECTURE §4.2).** `active` if any Stage Run or Task is running or queued; otherwise `blocked` if any non-human Blocker exists; otherwise `waiting_human` if any human Blocker exists. Hitting a rework or replan cap creates a human-kind Blocker, so the Job shows `waiting_human` and never loops. Blocker kinds: human, infrastructure, recovery, policy. An unmet dependency is the Task state `pending`, not a Blocker.
10. **RESOLVED 2026-11-08: fault origin and Blocker kind `environment` renamed to `infrastructure`** (human decision), so "environment" stays free for deploy targets (Phase F). Applied in ARCHITECTURE §4.6 and `GLOSSARY.md`.
