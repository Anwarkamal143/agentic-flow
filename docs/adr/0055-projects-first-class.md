# Projects are first-class

**Status:** accepted (Phase D, #95; PROGRESS "Human decisions" Q2, Q34). Supersedes the "Project defaults" part of ADR-0004 (a Project made on the side by `repo add`, named after the Repository). The choices below are routine and reversible.

## Context

A Project existed only as a side effect of `repo add --project`, which created any name it was given, so a typo made a second Project. Q2 decided `factory project create | list | show | config set`, a `repo add --project` that refuses an unknown Project, and a `job create` that infers the Project only when exactly one exists (PRODUCT_SPEC §5).

## Decision

- **Only `project create` makes a Project.** `POST /v1/projects {name}` (letters, digits, `.`, `_`, `-`; unique) records it and a `project.created` event in one transaction; a taken name is `409 project_exists`.
- **One rule picks a Project**, the pure `chooseProject` in `@factory/domain`: a ref (id or name) must match an existing Project, else `project_not_found` listing the Projects and the `project create` command; no ref means the only Project, else `no_projects` or `project_required` listing them. The runtime uses it for registration and Job creation, the CLI for `repo add`.
- **`repo add` without `--project`** takes the only Project, by the same rule, rather than creating one named after the Repository. The CLI checks before inspecting, and the runtime checks again before the clone and inside the transaction, so a refused registration makes nothing.
- **Job creation.** `POST /v1/jobs` takes optional `project` (id or name) and `repositoryId`. A named Repository gives its Project (a different `project` is `409 repository_not_in_project`). Without one, the Project is chosen by the rule, and its Repository is its only one; with none or several the request is refused (`no_repositories`, `repository_required`) until triage can propose a Repository set (multi-repo Jobs, ADR-0052). `job create` gains `--project`; `--repo` becomes optional.
- **Listing.** `GET /v1/projects` returns each Project by name with its Repositories (`{id, name}`) and active Jobs (not in a terminal status). `GET /v1/projects/:ref` returns one with its Repositories in full.
- **`project config set <project> <key> <value>`** sets one key (`POST /v1/projects/:ref/config/set {key, value}`). The key is a leaf of the Project config schema, dotted when nested (`concurrency.perJob`); the result is validated by that schema; the CLI reads the value as JSON when it parses (`5`, `true`), else as text (`skip`). The `project.config_updated` event carries the key, before and after. The whole-config `POST /v1/projects/:id/config` stays. Narrowing against the parent level comes with the configuration hierarchy (#97).
- **No delete, rename or moving a Repository** (Q34, a known limitation).

## Consequences

- An operator now runs `factory project create <name>` before the first `repo add`. The scenario helper `createProject` does it for the tests.
- A Project with several Repositories needs `--repo` on `job create` until triage proposes the set.
