# The Job API returns a list of Repositories

**Status:** accepted (Phase D, #94, a prefactor for multi-repo Jobs, ADR-0052). The choices below are routine and reversible.

## Context

A Job summary and detail carried one `repositoryId`. Multi-repo Jobs (D1, D5) need a Job to name several Repositories, and every reader (CLI, dashboard, tests) assumed one.

## Decision

- **`repositories[]` replaces `repositoryId`** on `JobSummary` and `Job` (`GET /v1/jobs`, `GET /v1/jobs/:id` and every response that returns a Job). Each entry is `{id, name}` (`JobRepository`), so a reader shows the name without a second request. The list has at least one entry and is ordered by name, then id. It is read from `job_repositories` joined to `repositories`.
- **Creation is unchanged.** `POST /v1/jobs` still takes one `repositoryId`; naming several Repositories comes with multi-repo Jobs.
- **Readers.** `factory job show` prints `repositories: <name> (<id>), …`. `factory job list` appends `[<name>, …]` after the title. The dashboard Job page shows a Repositories field and the Jobs list a Repositories column, each name titled with its id.
- **No behaviour change.** The `job.created` event payload keeps its `repositoryId`: events are an append-only log, and old ones are never rewritten.

## Consequences

- A client that read `repositoryId` from a Job must read `repositories[0].id`; the only clients are this repo's CLI, dashboard and tests.
