# Sensitive Paths in every Task's scope (Phase D, #101)

**Status:** accepted (Phase D, #101; implements the enforcement part of ADR-0051). The choices below are routine and reversible.

## Context

ADR-0051 decides that a Repository's Sensitive Paths are added to every Task's `forbidden` at plan validation, that forbidden beats writable, and that a `writable` entry that is literally a Sensitive Path pattern makes the Plan invalid. ADR-0060 freezes the Sensitive Paths into each Job's per-Repository section. This ADR records where the merge happens and what "literally" means.

## Decision

- **The Sensitive Paths come from the Job's frozen section** (`sensitivePathsOf` in `apps/runtime/src/plans.ts`, via `frozenRepositoryConfig`). A profile change after the Job was created changes neither validation nor the merged scope of that Job. A Job from before Phase D, which froze no section, uses the Repository's current profile, as for its commands (ADR-0060).
- **Validation refuses, the merge happens when the Task rows are written.** `validatePlan` gets `PlanContext.sensitivePaths` (by Repository id) and reports `plan.sensitive_writable` for each `writable` glob equal, as a string, to a Sensitive Path of the Task's own Repository. A planner Plan gets the usual one re-prompt; a human's Plan Edit is refused with the issue. `persistPlanTasks` normalizes every entry with `withSensitivePaths` (domain): the Task's own `forbidden` globs first, then the Sensitive Paths it doesn't already list. The Task definition (and so the Task Packet and the path-scope Gate) carries the merged list.
- **The stored Plan Artifact stays as proposed.** It is the planner's (or the human's) output and is never rewritten; `plan show` shows the proposed scope. The merged scope is what the Task runs with.
- **"Literally" is string equality.** `infra/**` in `writable` is an error when `infra/**` is a Sensitive Path; `infra/main.tf` or `src/**` is not, and any Sensitive Path such a glob covers is still forbidden at the Gate (forbidden beats writable, `checkPathScope` reports such a path as `scope.forbidden`).
- **The carry-over compares normalized entries,** so both the old and the new Plan's entries carry the same frozen Sensitive Paths and the merge never makes a Task look affected.

## Consequences

- A change to a Sensitive Path fails the path-scope Gate with a `scope.forbidden` Finding naming the Sensitive Path glob (`tests/scenarios/sensitive-paths.test.ts`), and goes through the usual Rework.
- A Task created before #101 and carried over onto a new Plan keeps its stored definition, without the Sensitive Paths; a Task created after it has them.
- Widening for one Job stays a human edit of the profile before the Job is created (PRODUCT_SPEC story 40); `scope_change` is Phase E.
- The planner's prompt does not yet list the Sensitive Paths; it learns them from the re-prompt. The prompt template is bumped with verification by command name (#102).
