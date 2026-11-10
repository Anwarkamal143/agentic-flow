# Blocker Approvals and grant sizes

**Status:** accepted (#43, Phase B, ROADMAP exit test B5). Routine and reversible choices inside ARCHITECTURE §4.6 and §8.1. Builds on ADR-0009 (Blockers and Rework routing), ADR-0012 (recovery, `decideRecovery`, pid plus start time), ADR-0016 (Inbox Items), ADR-0023 (Questions, `max_questions`) and ADR-0024 (the sweeper and `recovery_uncertain`). Pure rules in `packages/domain/src/blocker-approvals.ts`; the runtime side in `apps/runtime/src/blocker-approvals.ts` and `inbox.ts` (`decideBlocker`).

## Which Blockers open an Approval

- **`stepTask` opens it.** Whenever a Task goes `blocked`, the engine calls `openBlockerItem` in the same transaction, right after the `task.blocked` event. A reason with an option set opens one `blocker` Inbox Item; any other reason opens nothing. So every path that sets a Blocker (the Rework cap in `endAttempt`, the question cap in `askHuman`, crash recovery, the sweeper) gets its item without its own call, and a later reason (`base_merge_conflict` #44, `replan_cap_reached` #45) only needs an option set.
- **Option sets (`blockerOptions`):**

  | Blocker | Options |
  |---|---|
  | `rework_cap_reached`, `question_cap_reached` | `grant`, `cancel_job` |
  | `recovery_uncertain`, `retry_cap_reached` | `retry_now`, `cancel_job` |

  The "replan" options of §8.1 arrive with the Requested Replan ticket (#45). `awaiting_human` has its own `question` item; the Fault Origin Blockers (`plan`, `spec`, `infrastructure`) are routed by #46/#47 and open nothing here. `recovery_uncertain` and `retry_cap_reached` have Blocker kind `recovery`, not `human`: §8.1 lists them, so they open an item anyway, and `execution` is `blocked` (not `waiting_human`) as before.
- **The item:** subject = the Attempt whose end raised the Blocker (`blocker.attemptId`), it holds the latest `execution` Stage Run, names the Task, `requested_by` is the actor that set the Blocker (`system:scheduler`, `system:recovery`, `system:sweeper`), `why` is the Blocker's detail and required action. Options are the factory's, never agent-proposed. It stays pending (`remain_pending`) and can be deferred like any item.

## Deciding one

`POST /v1/inbox/:id/decide {expectedVersion, subjectRef, option, comment?, grant?}`. The ADR-0016 rule applies first (human actor, open, version, subject, option), then `checkBlockerDecision`. Every decision is one versioned Job transaction that checks the rule again inside it. `decide` is now async (the process check and the cancel are), so `approvePlan`/`rejectPlan`/`requestPlanChanges` are too.

- **Grant +N.** `grant` is a whole number from 1 to 5, default 1 (`GRANT_DEFAULT`, `GRANT_MAX`). Any other option with a `grant` is `400 invalid_grant`; so is a `grant` on a non-blocker item. The cap becomes `max(used, cap) + N` (`grantedCap`): exactly N more Attempts, even if a cap was narrower than the use.
  - `rework_cap_reached`: `tasks.max_attempts` raised (used = `attemptsCountedForRework`), Task `blocked → ready` (reason `granted`), `execution` re-queued. The next claim makes a `rework` Attempt in the preserved Worktree, carrying the last Attempt's Findings as usual.
  - `question_cap_reached`: `tasks.max_questions` raised (used = answer Attempts), then the capped Attempt's Question is opened (`openQuestionItem` with its stored `questions_json`; no Evidence attached), and the Task's Blocker is replaced by `awaiting_human` without leaving `blocked` (`replaceBlocker`, events `task.blocker_changed` and `stage_run.blocker_changed`). Answering it continues as in ADR-0023. We chose this over readying the Task directly: the developer's questions would otherwise go unanswered.
- **Guidance.** The decision's comment, on a grant, is guidance. Packet field `context.guidance` (`GrantGuidance[]`: the Attempt n, the item title, text, `decidedBy`, item id), built by `guidanceAfter` like `answersAfter`: every later Attempt of the Task carries every grant's guidance so far, not only the next one (as answers do). Prompt template `task-packet@5` adds one rule: follow it; it never widens the scope.
- **Audit.** Every cap raise is one `audit_log` row (new table, migration 0012: ARCHITECTURE §5's columns plus `job_id`): `actor` `user:local`, `action` `cap.raised`, `target` `task:<id>`, before/after `{cap: n}`, `policy_ref` `inbox:<item>/<option>`, `correlation_id` the item, with an `audit.recorded` event. Read with `GET /v1/jobs/:id/audit`.
- **Retry now.** The recorded process (`attempts.process_json`, kept by the sweeper when unconfirmed) is checked by pid plus start time (`inspectSpool`) before anything changes (`retryNowCheck`):
  - gone (`dead`, `finished`, or nothing recorded): retry;
  - `alive`: refused `409 process_alive`, and in its own transaction the item's options become `kill_and_retry`, `cancel_job` (version bumped, `approval.options_changed`). The human re-reads it and chooses `kill_and_retry`: the group is stopped (`stopIfAlive`: SIGTERM, then SIGKILL; it settles once the group is gone) and the Retry follows. Still alive after that: `409 process_alive`, nothing changes.
  - a spool with no readable pid (`none`): refused `409 process_unconfirmed`. Nothing proves the process gone, and a human's word alone never starts a second one. It becomes retryable when the process ends (its exit status is written), or the Job can be cancelled.

  A quarantined Worktree is re-read first; still unknown is `409 worktree_unknown`, readable again is `quarantined → preserved`. Then, in one transaction: `process_json` cleared, `max_retries` raised by one (audited) when no Retry is left (`retriesAfterRetryNow`), Task `blocked → ready` (reason `retry_now`), `execution` re-queued. The spool is removed afterwards. A dirty Worktree is retried as it is: the human looked and chose to; its leftovers are committed as the Retry's WIP commit and flagged, as always.
- **Cancel the Job.** The item is decided `cancel_job` first, then the existing cancel operation runs (`JobService.cancel`, injected into the `InboxService`), at the Job's current version, re-read up to five times on `version_conflict`. Its reason is `cancelled from Inbox item <id>`. The cancel is not reimplemented.

## Dashboard and CLI

- The item page renders the options generically (ADR-0022). A decide form whose item offers `grant` gets a number field `grant` (1–5, default 1); the dashboard route sends it only with the `grant` option. A decided grant shows `+N`.
- `factory inbox decide <id> grant --grant <n> --expect-version <v> [--comment <guidance>]`; `inbox show` prints `grant +N` once decided.

## Also changed

- `TaskScheduler.launch` deletes a slot's map entry only if it is still that slot's: a swept slot that ends after a "retry now" re-claimed its Task no longer drops the Retry's entry (ADR-0024's first known limitation).
- The `requiredAction` of `rework_cap_reached` and `question_cap_reached` names the Inbox options.

## Known limitations

- A Question reopened by a grant has no Evidence attached (the original Question's Task Result Artifact isn't looked up again).
- "Retry now" on a process whose pid can't be read waits for the process to end on its own; there is no "kill" for it, because nothing proves it ours.
- The replan options are not offered yet (#45).
