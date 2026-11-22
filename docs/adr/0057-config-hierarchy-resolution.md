# Resolving the configuration hierarchy: permission values, sections and the tree check

**Status:** accepted (Phase D, #97; implements the resolution part of ADR-0049). The choices below are routine and reversible.

## Context

ADR-0049 orders the levels recipe < Factory < Project < Repository < Job < Task, lets only the most specific level that sets a value win, and lets a permission value only narrow below its parent, with every Repository of the Project resolved into the Job's snapshot at creation. #97 asks for sources and narrowing chains on every value, refusals naming the parent's value, a section per Repository, older snapshots still parsing, and `job show` printing each value with its source. ADR-0049 does not say which values are permission values, which levels hold which keys, or what happens when a parent is narrowed below a child.

## Decision

- **Keys per level.** The Factory Level and a Project hold the same Job-wide keys (`LEVEL_CONFIG_SHAPE`: `maxAttempts`, `maxRetries`, `maxQuestions`, `planApproval`, `maxReplans`, `review.rerunOnBaseChange`, `mergePolicy`, `concurrency.perRepository`, `concurrency.perJob`); the Factory Level keeps `concurrency.global`, which only the scheduler reads. The Repository level is what a Repository already holds (Merge Policy, merge method, profile commands, required checks, setup), still set at `repo add`; no `repo config set` yet. The Job level is the creation overrides (`concurrency`, `mergePolicy`). The Task level is a Plan Task's narrower `maxAttempts` (`taskMaxAttempts`, source `task`).
- **Permission values** are `mergePolicy` (`never_auto` narrower than `human_approval`) and `planApproval` (`required` narrower than `skip`). The caps and the concurrency limits are not (Phase B Q7). The tool policies stay recipe-only, under the invariants.
- **Recipe defaults are not a parent.** Narrowing is checked only between levels that set the value, so a Project may still `skip` plan approval when nothing above it sets `required`. A chain lists only the levels that set the value, least specific first; a recipe default has an empty chain. The `invariant` source is reserved: no schema admits a value past the invariants, so nothing resolves to it today.
- **The Factory and Project `mergePolicy` is a ceiling.** Every Repository has its own Merge Policy (default `never_auto`), so a Repository section's source is `repository` or `job`, and the chain shows the ceilings above it ("factory: human_approval → repository: human_approval → job: never_auto").
- **One check over the whole stored tree.** `factory config set`, `project config set`, the whole-config Project route and `repo add` apply the proposed change to the Factory Level, every Project and every Repository, and run the pure `configTreeViolation` in the change's own transaction (and, for `repo add`, before the clone). Any level left wider than its parent is refused with `409 config_widens_parent`, naming the level, the parent and the parent's value, so a set that narrows a parent below an existing child is refused too, naming the child. `resolveEffectiveConfig` applies the same rule and returns the same error, so a Job can never freeze a widened value. The Job's own looser `--merge-policy` keeps its `merge_policy_looser` refusal (ADR-0038).
- **Snapshot shape.** `repositories: [{repositoryId, name, mergePolicy, mergeMethod, setup, commands, requiredChecks}]`, ordered by name, for every Repository of the Project at creation. The top-level `mergePolicy` and `setup` are now written only by Jobs from before Phase D; `repositoryConfigOf` gives such a Job its one section from them, and from the live Repository for what it never froze (merge method, commands, required checks). Readers of the Merge Policy, merge method, required checks and setup go through the frozen section (`frozenRepositoryConfig`), so a later change to a Repository never reaches a running Job. A Job-wide Merge Policy (`mergePolicyOf`) is the strictest over the Job's Repositories.
- **`job show`** prints a "Configuration (frozen at creation)" block, one line per value with its source and, for a chain of two or more levels, the chain; then one block per Repository section.

## Consequences

- The narrowing rule is in one pure function, which `config import` (a later ticket) can reuse.
- Adding a permission value means adding it to `PERMISSION_ORDER` and the tree check.
- The effective-config page (dashboard) is a later slice; it reads the same snapshot.
