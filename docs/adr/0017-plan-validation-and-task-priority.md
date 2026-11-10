# Plan validation: overlapping writes, narrowing caps, Task priority (Phase B, issue #36)

**Status:** accepted. Routine and reversible choices made while building ARCHITECTURE §7's Phase B Plan Task fields and §12's Phase B dispatch order (human decision Q13).

## Plan Task fields

- `priority: low | normal | high`, default `normal`. `maxAttempts` is optional and may only narrow the Effective Configuration: a value above it is `plan.max_attempts_narrow`. A Task without one gets the Effective Configuration's value, as before.
- **Storage without a schema change.** `tasks.priority` is already an integer column, so a priority is stored as its weight (`TASK_PRIORITY_WEIGHT` in `@factory/domain`): `low = -1`, `normal = 0`, `high = 1`, and higher runs first. `normal` is 0, so every Task planned before #36 (stored as 0) reads as `normal`. ARCHITECTURE §5's `/*low|normal|high*/` names the values, not the column type.
- Priority is not part of `definition_json`: it is a scheduling attribute. Whether a priority change counts for Replan carry-over (§4.7) is for the Replan ticket to decide.

## Overlapping writable paths (`plan.no_overlapping_writes`)

- **Which pairs.** Only Tasks of the same Repository (resolved by name or id) that no dependency path orders, in either direction, transitively. Siblings of one shared dependency are *not* ordered against each other.
- **What decides: static-prefix overlap.** Each glob's static prefix is its leading path segments without glob syntax (`picomatch.scan`'s `base`: `src/a/**` → `src/a`, `src/*.ts` → `src`, `**/*.md` → nothing). Two globs overlap when one prefix is, segment by segment, a prefix of the other, so an empty prefix overlaps everything and `src/a/**` does not overlap `src/ab/**`. This is conservative: `src/*.ts` and `src/*.css` overlap. A false positive costs one re-prompt; a false negative would let two parallel Tasks edit one file.
- **What names the paths.** The tracked files at the planning base, `git ls-tree -r` of the commit a Task's Worktree would start from (the default branch as fetched, else the local one, in the **Factory Clone**, never the user's checkout), matched by both Tasks' writable globs (`dot: true`, as the path-scope Gate). At most 10 are listed, then "and N more". They never decide: an overlap that no tracked file shows yet (new files) is still rejected, and the message says so.
- **One issue per pair**, listing every overlapping glob pair, so the planner sees all conflicts in the one re-prompt.
- **The re-prompt is the existing one** (ADR-0006): the issues travel back in the re-prompt and on `harness_run.started` `reprompt.issues`. The planning ask now tells the planner the overlap, priority and `maxAttempts` rules up front. The template text is unchanged (`proposal-stage@1`; the ask is per Stage, outside the hash).
- **Plan Edits** (#35 and later) must call `validatePlan` with the same `PlanContext` (`maxAttempts`, `trackedFiles`), and return its errors to the human with no re-prompt.

## Dispatch order

- Ready Tasks are taken by `tasks.priority` descending, then the time they became ready, then plan order (`READY_TASK_ORDER`, `apps/runtime/src/dispatch.ts`). This is the **MVP form of §12 step 1's** `effective_priority = priority_weight + aging(wait_time) − project_share_penalty`: the weight only, with ties broken by wait. Aging and the project share are v1.
- It is global, not per Job: the earlier "oldest Job first" order is gone, so a high-priority Task of a newer Job runs before a normal one of an older Job.
- **Time ready** is the `seq` of the Task's latest `task.ready` event (or `task.created` for a Task created ready), read by a subquery on the job's events. Events are written in the same transaction as the state change, so `seq` is the commit order of the transition. There is no `ready_at` column; adding one would be a schema change, and this ticket made none. If one is added later, it replaces the subquery and nothing else.
