# The effective-config page: snapshot on the Job, live preview on the Project and Repository (Phase D, #98)

**Status:** accepted (Phase D, #98; completes D3 with ADR-0057). The choices below are routine and reversible.

## Context

#98 asks the dashboard to show the Effective Configuration: a Job page its frozen snapshot with source badges and narrowing chains, and the Project and Repository pages a live preview of what a new Job would get now. The dashboard has no Project or Repository page yet, and the runtime API has no route that resolves the hierarchy without creating a Job.

## Decision

- **The Job page reads the snapshot only.** It renders `job.effectiveConfig` as the runtime returns it: one row per Job-wide value (key, value, source badge and, for a chain of two or more levels, the chain), then a section per Repository. It never resolves anything itself, so it can't drift from what the Job uses.
- **The preview is resolved by the runtime at each read and never stored.** `GET /v1/projects/:ref/effective-config` and `GET /v1/repositories/:id/effective-config` return `EffectiveConfigPreview` (`projectId`, `projectName`, `repositoryId`, `config`). They call `resolveProjectConfig` (`apps/runtime/src/effective-config.ts`), the same reader `job create` freezes from, with no Job-level overrides (a Job's `--merge-policy` and concurrency overrides exist only at creation). A Repository's preview keeps only that Repository's section. A stored level wider than its parent (which the tree check prevents) is `409 config_widens_parent`, as `job create` would be.
- **New pages.** `/projects` lists the Projects with their Repositories; `/projects/[id]` shows the Project, its Repositories, its active Jobs and the preview; `/repositories/[id]` shows the Repository and its preview. They are read-only: config is still changed with `factory config set` and `factory project config set` (the Inbox stays the dashboard's only write path, ADR-0022). The main navigation gains "Projects".
- **Value display** follows `job show`: lists joined (an empty `requiredChecks` is "every check"), objects by their keys, `null` as "none".

## Consequences

- D3 is tested end to end over HTTP (`tests/scenarios/dashboard-config.test.ts`): after a Factory and a Project edit the previews change and the running Job's page does not.
- Editing config from the dashboard would be a new write path and needs its own decision.
