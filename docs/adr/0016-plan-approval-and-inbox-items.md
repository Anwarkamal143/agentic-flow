# `plan_approval`, Inbox Items and their versioned decisions

**Status:** accepted (#35, Phase B). Routine and reversible defaults inside the design settled in the Phase B grilling (ARCHITECTURE §4.3, §5, §8.1; PRODUCT_SPEC §4, §7, §10).

## `planApproval`

- **A Project setting, frozen per Job.** `ProjectConfig.planApproval: "required" | "skip"`, resolved into the Effective Configuration as `{ value, source }` (default `required`, source `recipe`). Jobs created before #35 parse with the default; their Workflow Snapshot has no `plan_approval`, so it is unused.
- **The `feature` Recipe is version 2:** `plan_approval` sits between `planning` and `execution`. A version-1 Job keeps its snapshot.
- **No Harness, no scheduler slot.** `plan_approval` is entered in the transaction that finishes `planning` (`queueNextStage`, `apps/runtime/src/plan-approval.ts`):
  - `skip`: `pending → skipped` with the reason `planApproval: skip (from <source>)` in the `stage_run.skipped` event, then the next Stage is queued.
  - `required`: `pending → queued → running → waiting_human` (one event each), and one `plan` Inbox Item opens with the newest plan Artifact as its subject.
- **New Stage Run transitions:** `waiting_human → succeeded` (approved) and `waiting_human → rejected` (rejected). `rejected` is terminal and derives Job status `rejected`, checked right after `active`.
- **Reject (B6):** the Stage Run ends `rejected`, so the Job is `rejected`. The Plan's Tasks that never ran (`pending`, `ready`) are cancelled with reason `plan_rejected`. Every Artifact is kept, and later Stage Runs stay `pending` (they never ran).
- **Approve:** the Stage Run ends `succeeded` and `execution` is queued. The Task scheduler only dispatches a Job whose `execution` is queued or running, so nothing ran before.
- **No Stage Run Blocker for the wait.** `BlockerSchema` is Task-shaped (`taskId`, `attemptId`, Task reasons), so the waiting Stage Run carries the reason in its event, and the Inbox Item is the record of what is needed. A Stage-level Blocker can be added when a Stage needs one.

## Inbox Items (`approvals`)

- **One table, ARCHITECTURE §5's columns,** plus `stage_run_id` (the Stage it holds), `why`, `evidence_json` (Artifact ids), `requested_by` and `created_at`, which PRODUCT_SPEC §10's item view needs. Kinds `question | plan | spec_change | blocker | cleanup`; states `open | decided | cancelled | superseded`; `expires_policy` is always `remain_pending`. Only `plan` items exist yet; deciding another kind is refused with `not_decidable` until its ticket adds the handler.
- **Versioned.** Every change bumps `version` under a version-guarded `UPDATE`, with its event (`approval.opened | decided | deferred | undeferred | cancelled`) in the same transaction.
- **The decision rule is pure:** `checkInboxChange` in `@factory/domain`, in this order:
  1. `actor_not_allowed` (403): the actor isn't `user:<name>`.
  2. `item_not_open` (409).
  3. `version_conflict` (409): the message names both versions.
  4. `subject_mismatch` (409).
  5. `unknown_option` (400).

  Defer and undefer go through the same rule without a subject or option. The API token stands for `user:local` only, so the agent-actor refusal is exercised by unit tests. No route lets an agent act.
- **Cancelling a Job** cancels its open items in the cancel transaction.
- **Defer** only hides an item from the default view (`GET /v1/inbox`); `?all=true` shows everything.

## API and CLI

- `GET /v1/inbox[?all=true]`, `GET /v1/inbox/:id`, `POST /v1/inbox/:id/decide {expectedVersion, subjectRef, option, comment?}`, `POST /v1/inbox/:id/defer|undefer {expectedVersion}`.
- The operations `approvePlan` and `rejectPlan`: `POST /v1/jobs/:id/plan/approve|reject {expectedVersion, planArtifactId, comment?}`. They decide the Job's open `plan` item through the same rule.
- `GET /v1/jobs/:id/plan`: the plan approval view (`PlanView`).
- `factory plan show <job>`, `factory inbox [--all]`, `inbox show <id>` (prints the version), `inbox decide <id> <option> --expect-version <n> [--subject <ref>] [--comment <text>]`, and `inbox defer|undefer <id>`.
  - `decide` sends the subject the item has when it is read, unless `--subject` pins one. A replaced Plan comes with a new item (superseding is the edit/replan tickets' job), so `--expect-version` already catches a stale view.
  - `defer` and `undefer` send the version they read.

## The plan approval view, derived by code

- **Decision points:** `humanDecisionPoints(snapshot, {planApproval})`, from the Stages in the Workflow Snapshot and the policy. It lists only what the factory has built: plan approval when it is required, and the execution Blockers (Rework, Retry or recovery caps, and plan, spec or infrastructure fault origins). Questions get a point when the question protocol lands.
- **Parallel:** `parallelWaves` groups Tasks by their longest dependency path. A wave's Tasks can start together, and none of them depends on another in its wave.
- **Estimate:** `planEstimate`. Attempts run from the Task count to Σ(maxAttempts + maxRetries + maxQuestions) and are labelled "bounds, not a forecast". `maxAttempts` and `maxRetries` come from the Task rows, `maxQuestions` from the Effective Configuration (new, default 3, Project-settable). The cost is always `unknown`, and the reason depends on the billing: subscription, API key, or a Harness with none.
- **Risks:** the triage risk, plus every Task whose risk isn't low.
