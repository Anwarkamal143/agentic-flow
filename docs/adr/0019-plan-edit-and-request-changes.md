# Plan Edit and "request changes" at `plan_approval`

**Status:** accepted (#38, Phase B). Routine and reversible defaults inside the design settled in the Phase B grilling (ARCHITECTURE §4.7; PRODUCT_SPEC §4, §7; GLOSSARY: Plan Edit, Replan). Builds on ADR-0016 (Inbox Items) and ADR-0017 (the Plan validator).

## Plan Edit (`editPlan`, not a Replan)

- **A whole replacement Plan:** `POST /v1/jobs/:id/plan/edit {expectedVersion, planArtifactId, plan}`, and `factory plan edit <job> --file <plan.json>` (JSON). `factory plan show <job> --raw` prints the current Plan in that same form, so the operator edits a copy.
- **Refusals come first:** the open plan item's version and subject, through `checkInboxChange`, so a stale view or a replaced Plan is refused before validation.
- **The planner's validator:** `PlanProposalSchema`, then `validatePlan` with the same `PlanContext` as planning (`maxAttempts`, the tracked files at the planning base). The context code lives in `apps/runtime/src/plans.ts`, which the Stage scheduler now uses too. Any issue → 422 `invalid_plan`, every issue in the message as `[rule] message`. No re-prompt, no Harness Run, and nothing is written.
- **A valid edit, in one transaction (the Job version is bumped):**
  - a new plan Artifact, recorded with actor `user:local`. The `artifact.created` event's actor is the authorship record, so no column was added. The plan view shows it as `planAuthoredBy`.
  - the replaced Plan's Tasks are cancelled with reason `plan_edited`. Only `pending` and `ready` Tasks exist before approval, and none has an Attempt, a branch or a Worktree.
  - the new Plan's Task rows are written by the same `persistPlanTasks` as the planner's.
  - the open item becomes `superseded` (never deleted), with an `approval.superseded` event naming the new item. A new `plan` item opens on the same `plan_approval` Stage Run, which stays `waiting_human`.
- It doesn't touch `jobs.replans_used`, and it is allowed at the Replan cap.

## "Request changes" (a Replan before execution)

- It is a third option on every `plan` item, `request_changes`. The option needs a comment as feedback. There is also `POST /v1/jobs/:id/plan/request-changes {expectedVersion, planArtifactId, feedback}` and `factory plan request-changes <job> --feedback <text>`.
- **The pure rule:** `checkPlanChangeRequest` in `@factory/domain`. It runs after `checkInboxChange` and checks in this order:
  1. `feedback_required` (400): there is no feedback.
  2. `replan_limit_reached` (409): `replans_used >= maxReplans`. The message says edit, approve, reject or cancel remain.
- **Effect, in the decide transaction:**
  - the item is `decided` (option `request_changes`, the feedback as its comment).
  - the waiting `plan_approval` Stage Run goes `waiting_human → superseded`. That is a new terminal Stage Run state that counts as passed, so the Job's status comes from the later runs.
  - the replaced Plan's Tasks are cancelled with reason `plan_replanned`.
  - `jobs.replans_used` gets +1, with a `job.replanned` event (`replansUsed`, `maxReplans`, `planArtifactId`, `approvalId`).
  - two new Stage Runs are added at their Stage's position with `attempt + 1`, each with a `stage_run.created` event: `planning` (queued at once) and `plan_approval` (pending). The unique index `(job_id, stage_id, attempt)` already allowed this.
- **What the planner gets:** `replanRequestOf` reads the Job's newest plan item. When it was decided `request_changes`, the planning prompt gets a Replan section with the current Plan's JSON and the feedback. The feedback is marked as a request that grants no permissions. Nothing about the request is held in memory, so a restarted runtime re-plans from the same stored request. The prompt template is now `proposal-stage@2`, and `harness_run.started` carries `replan: {planArtifactId, feedback}`.
- The new Plan goes through `plan_approval` under the same policy (`queueNextStage` finds the pending `plan_approval` run).

## Schema (migration 0010)

- `jobs.replans_used integer NOT NULL DEFAULT 0` (ARCHITECTURE §5).
- **A Task key is unique within its Plan, not its Job:** `tasks_job_key (job_id, key)` is replaced by `tasks_plan_key (plan_artifact_id, key)` plus a plain `tasks_job` index. A replaced Plan's cancelled Task and the new Plan's Task usually share a key.
- `replan_requested_json` (§4.7's requested Replan during execution) is not added. A Replan at `plan_approval` starts at once, so nothing waits. #45 adds it.

## The Job's outcome counts only the newest Plan's Tasks

- `settleExecution` looks only at the Tasks of the Job's newest plan Artifact. A replaced Plan's cancelled Tasks would otherwise stop `every Task approved`.
- **Carry-over (§4.7) is not built here:** before approval no Task has state worth keeping. #45 owns carry-over. A Task it carries over has to be moved to the new Plan (`plan_artifact_id`) to keep counting.

## Not built here

- **The dashboard action** (replan-with-feedback on the plan Approval). The dashboard has no write path yet: #37 adds it (Inbox page, Origin/Host checks), and #49 owns `apps/dashboard/**` this round. The API and the item's `request_changes` option are ready for it. The dashboard must send the comment as feedback.
