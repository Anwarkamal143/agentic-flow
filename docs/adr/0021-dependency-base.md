# The Dependency Base, which is not the Integration Branch

**Status:** accepted (#39, Phase B). Routine and reversible choices inside ARCHITECTURE §10 ("Dependency Base") and the GLOSSARY.

## What a dependent Task starts from

- **When.** A `pending` Task becomes `ready` in the same transaction that approves the last Task it depends on (`task.ready`, reason `dependencies_approved`). So it is never claimed before its last dependency's `task.approved` event.
- **What.** The pure `planDependencyBase` (`@factory/domain`) takes the dependencies in **Plan order** (the order the Plan lists the Tasks, which is the Tasks' row order), each with its state and the head its passing Attempt was approved on:
  - no dependency: the default branch, freshly fetched (as before);
  - one distinct head: that commit itself;
  - several: their heads merged, in Plan order, into a local commit;
  - a dependency not approved, or with no head: refused (it can't happen for a `ready` Task, so the runtime fails it as a factory error).
- **How the merge is made** (`apps/runtime/src/dependency-base.ts`, `@factory/git` `mergeCommits` and `commitTree`): `git merge-tree --write-tree` on the first head and the next, then `git commit-tree` with both as parents, then the result with the next head, and so on. Only objects are written: no ref, index or Worktree moves, and the user's checkout is never touched. The commit is the factory's (`Software Factory`), with a `Factory-Dependency-Base: true` trailer. Two dependencies give one merge commit whose parents are their heads, in Plan order.
- **That commit is the base.** The Worktree's branch is created at it, and it is the Attempt's (and the Worktree's) `base_sha`, so every Gate's `(head_sha, base_sha)` and the review's diff are against it: the dependent Task is judged on its own commits only. Its branch keeps the commit reachable; no extra ref is made. `worktree.created` records which Tasks it holds (`dependencyBase`).
- **It is made once.** Rework and Retry reuse the Worktree and its base. A dependency's head can't change after it is approved in Phase B, so the base stays valid.
- **It runs under the clone's setup lock** (ADR-0020), with the fetch and `git worktree add`.

## Not the Integration Branch

The Dependency Base is local to one dependent Task: nothing pushes it, no branch is named after it, and it does not combine the Job's leaves. The Integration Branch (`factory/<job-id>`, §14) is Phase C. B1 asserts no `factory/<job-id>` branch exists.

## Conflicts: a stopgap until #44

The Plan validator rejects overlapping writable paths for Tasks that no dependency orders (ADR-0017), so siblings rarely conflict. When they do, `merge-tree` reports the conflicting paths, and until the `base_merge_conflict` human Blocker and its Approval land (#44) the Task **fails** with `factory_error` and a message naming the dependencies and the paths. Nothing is merged, and nothing retries it silently.
