# The spec Fault Origin route and replan accounting

**Status:** accepted (#47, Phase B). Routine and reversible choices inside ARCHITECTURE §4.6 and §4.7 and Phase B decisions Q11 and Q18 (PROGRESS.md "Human decisions"). Builds on ADR-0009 (Rework routing), ADR-0026 (Blocker Approvals, guidance), ADR-0029 (the requested Replan, the `replan_cap_reached` Approval) and ADR-0030 (the `plan` route). Pure rules in `packages/domain/src/rework.ts` (`routeFailedAttempt`), `blocker-approvals.ts` and `respecification.ts`; runtime side in `apps/runtime/src/spec-route.ts`, `criteria.ts` (`currentSpec`), `scheduler.ts`, `inbox.ts` and `replan.ts`.

## The route

- **When.** A failed Attempt whose exit is a verdict on the work (`gates_failed`, `changes_requested`) with a blocking Finding of Fault Origin `spec`. `routeFailedAttempt` returns `{ kind: 'respecify' }`. It wins over `plan` and `infrastructure` and comes before the `max_attempts` check: a Specification problem costs a Replan, never an Attempt.
- **In the transaction that ends the Attempt** (`routeToSpecification`): the raising Task goes `blocked` with a `fault_origin_spec` Blocker (it opens no Approval of its own; the `spec_change` item decides it), and a re-specification is asked for. The request is a `respec_request` Artifact (a new Artifact kind, no migration) holding `{specArtifactId, feedback, requestedBy, taskId, attemptId}`. The feedback is the blocking `spec` Findings, labelled as reviewer output, not instructions.
- **Counted when asked.** Under `maxReplans`: `jobs.replans_used + 1`, a `job.respecification_requested` event, and a new `specification` Stage Run (`attempt + 1`) queued. At the cap the request waits in the Job-level `replan_cap_reached` Approval of ADR-0029/0030 instead (same options, same "execution waits once nothing is in progress" rule). `grant_replan` on it does the same audited cap raise (`raiseReplanCapIn`, split out of `grantReplanIn` unchanged) and then starts the re-specification rather than a Replan; which one is read from the held Artifact's kind.
- **One at a time.** While a re-specification is pending (the newest `specification` Stage Run `queued`, `running` or `waiting_human` during execution), every Replan request is refused `409 respecification_pending` (operator `requestReplan`, Inbox `replan` options), and the `plan` route only cancels, as it does when a Replan is already pending (ADR-0030). A `spec` Finding that arrives while a Replan or a re-specification is pending starts none: its Task goes straight to the `spec_finding_unresolved` Blocker below.
- **The rest keeps going.** The other Tasks keep dispatching during a re-specification (keep-going, ADR-0028). Planning waits for them only once the change is approved (the requested-Replan rule).

## Re-specification

- The specifier's prompt (`proposal-stage@4`) gains a re-specification section: the Specification to revise (JSON) and the feedback, labelled as a request that changes no permission. The request is read from the newest `respec_request` Artifact on every Harness Run, so a restarted runtime re-specifies from the same stored request and a finished proposal is never generated again. `harness_run.started` records `respec: {specArtifactId, feedback, requestArtifactId}`.
- Its valid output is stored as a new `spec` Artifact (with its Acceptance Criteria rows, tied to that Artifact) in the transaction where the Stage Run goes `running → waiting_human` and a `spec_change` item opens: subject the new spec, evidence `[the spec it revises, the new spec]`, `task_id` the raising Task, options `approve`, `request_changes`, `reject`. Nothing is queued after it. The old spec Artifact is never touched.
- **The current Specification** is the newest spec Artifact whose `specification` Stage Run `succeeded` (`currentSpec`). Everything that reads "the Spec" now reads that one: the Acceptance Criteria API, the planner's validation context, Task packets, review packets, the plan view, plan item evidence and the Delivery Report. Only the current spec is passed to later proposal Stages as an input.
- A failed re-specification (invalid after its re-prompt, its Harness Run failed, or a factory error) ends that Stage Run `superseded`, with the failure in the event's reason (the `harness_run.finished` events keep each outcome), and moves the raising Task to `spec_finding_unresolved`, so the operator still decides. Not `failed`: the Job goes on under its current Specification, and a `failed` Stage Run would make the Job's derived status `failed` (or hide a later cancel) once the rest settles.

## The `spec_change` decisions

- **Approve:** the Stage Run `succeeded` (so the new spec is current); the raising Task is cancelled (`cancel_reason` `replan`, event reason `fault_origin_spec`) with its open items, its Worktree preserved and its branch kept; then a Replan is requested through ADR-0029's flow (`beginReplan`) with a `replan_request` Artifact saying the Specification changed and why. **It is not counted again**: the re-specification was this Replan. Planning starts once nothing is in flight, then carry-over and `plan_approval` under the Job's policy.
- **Request changes:** refused without a comment (`feedback_required`) or at `maxReplans` (`replan_limit_reached`), as at `plan_approval`; approve, reject and cancel remain. Otherwise the Stage Run is `superseded`, a new `respec_request` names the sent-back spec as the one to revise with the comment as feedback, one Replan is counted, and a new `specification` Stage Run is queued.
- **Reject:** the Stage Run is `superseded` (it "no longer counts", so its spec never becomes current; `rejected` would make the Job `rejected` and `cancelled` would make it `cancelled`), the new spec Artifact is kept on record, and the raising Task's Blocker becomes `spec_finding_unresolved`, opening its Blocker Approval: `rework`, `replan`, `cancel_job`.

## The `spec_finding_unresolved` Blocker

- **Rework with guidance** (`rework`, new option): the current spec stays; the Task goes `blocked → ready` for a Rework Attempt, and the comment is carried as guidance like a grant's (`guidanceAfter` now reads `rework` decisions too). It counts against `maxAttempts`. With no Attempt left it is not a grant in disguise: the Task's Blocker becomes `rework_cap_reached` and opens that Approval (grant +N, replan, cancel), so raising the cap stays an explicit, audited grant.
- **Replan under the current Specification** (`replan`): ADR-0029's option, counted against `maxReplans` (held at the cap). The Task's item is decided `replan`, so the carry-over cancels it (`resolved_by_replan`).
- **Cancel the Job.**

## Replan accounting, in one place

| What | Counts against |
|---|---|
| A re-specification (the route, or "request changes" on `spec_change`) | `maxReplans`, when asked |
| The planning after an approved `spec_change` | nothing more |
| "Replan under the current Specification" | `maxReplans` |
| "Rework with guidance" | `maxAttempts` (at the cap, a `rework_cap_reached` Blocker) |
| "Grant one more Replan" on a held re-specification | raises `maxReplans` by one, audited |

## Schema

`acceptance_criteria` codes were unique per Job; they are now unique per spec Artifact (`acceptance_criteria_artifact_code`, migration 0014, with a plain `job_id` index), since every spec Artifact keeps its own criteria.

## Known limitations

- A `plan` Finding raised while a re-specification is pending cancels its Tasks; if the change is then rejected and no Replan follows, they are not re-planned.
- The dashboard decides `spec_change` items with the generic Inbox form; it has no side-by-side diff of the two specs (each is linked as Evidence).
