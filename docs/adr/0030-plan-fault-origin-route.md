# The plan Fault Origin route

**Status:** accepted (#46, Phase B). Routine and reversible choices inside ARCHITECTURE §4.6 and Phase B decision Q28 (PROGRESS.md "Human decisions"). Builds on ADR-0009 (Rework routing), ADR-0028 (keep-going, `dependentsToCancel`) and ADR-0029 (the requested Replan, carry-over, the `replan_cap_reached` Approval). Pure rule in `packages/domain/src/rework.ts` (`routeFailedAttempt`); runtime side in `apps/runtime/src/plan-route.ts`, `execution.ts` (`endAttempt`) and `keep-going.ts` (`settleExecution`).

## The route

- **When.** A failed Attempt whose exit is a verdict on the work (`gates_failed`, `changes_requested`) with a blocking Finding of Fault Origin `plan`, and none of `spec` (spec still wins, ADR-0009; #47 routes it). `routeFailedAttempt` returns `{ kind: 'replan' }`, before the `max_attempts` check: a Plan problem is not a Rework, so it costs a Replan (`max_replans`), never an Attempt. In practice only a review can raise it, since a Gate Finding is always `implementation`.
- **What happens, in the transaction that ends the Attempt** (`routeToPlanning`):
  1. the raising Task goes `verifying|in_review → cancelled` (`tasks.cancel_reason` `replan`, event reason `fault_origin_plan`, with the Attempt and its head);
  2. its transitive dependents (`dependentsToCancel`; they are `pending`, never started) are cancelled the same way, one `task.cancelled` each, naming the raising Task;
  3. every open Inbox Item of those Tasks is `cancelled` (`task_cancelled`);
  4. a Replan is asked for through `requestReplanIn` (ADR-0029), with actor `system:scheduler` and as feedback the blocking `plan` Findings, labelled as reviewer output, not instructions. It is counted against `maxReplans` there and then. Every other Task follows the requested-Replan rule: no claim while `replan_requested`, planning once nothing is in flight, then carry-over and `plan_approval`.
- **The raising Task's Worktree** becomes `preserved` as after any ended Attempt, and its Task Branch is kept. The cancelled Task is never carried over, so an identical entry in the new Plan becomes a new Task with a fresh Worktree and branch (ADR-0029).
- **A Replan already pending** (requested and waiting, or held at the cap) covers this one: `requestReplanIn` refuses before writing anything (`replan_already_requested`, `replan_cap_pending`) and the route only cancels. The Findings are not added to the pending request's feedback (they stay on the Attempt's review); see Known limitations.

## At the cap: the Job waits

At `maxReplans`, `requestReplanIn` holds the request in its Job-level `replan_cap_reached` Blocker Approval (`grant_replan`, `cancel_job`). `settleExecution` now treats such an open item as a human Blocker: once no Task is in progress, `execution` goes `waiting_human` with a Blocker `{kind: human, reason: replan_cap_reached}` instead of any other outcome, so the Job is `waiting_human` (B4) and never ends `succeeded` or `failed` while a Replan waits for its decision. The Blocker holds no Task: its `taskId` is the Job's id and its `attemptId` the held request Artifact, the subject of the Approval (as `base_merge_conflict` stores the Task's id there, Spec issue 27). `grant_replan` starts the held request from `waiting_human` (an `ACTIVE_EXECUTION` state); `cancel_job` cancels.

This also applies to an operator's request held at the cap (#45): before, if every Task then finished, the Job completed with the item still open, and the item could no longer be decided (`409 job_terminal`). It now waits instead.

## Not done here

- The `spec` route (#47).
- The Tasks API still doesn't expose `cancelReason`; the `task.cancelled` event and the Delivery Report carry it.
