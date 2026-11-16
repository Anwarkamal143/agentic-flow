# The Worktree setup command

**Status:** accepted (spec issue 43, Phase C). The human chose option (a) on 2026-11-16 (relayed from session s-factory-e3): pull a minimal per-Repository setup command into Phase C, because C7 is a Phase C exit test. Discovering a Repository's package manager and commands stays Phase D.

## Context

The factory verifies work by running the Repository's commands in a Worktree, and nothing installed its dependencies. On `tiny-ts`, `tsc` failed with `TS2307: Cannot find module 'vitest'`. The real developer stopped to ask, the factory's own Gate failed, and no PR could be opened (C7 run 2026-11-16, and A7 earlier). ARCHITECTURE §10 already says dependency installs use the shared package-manager store. The §11 table refuses untrusted repo setup scripts unless a human overrides it for that Repository.

## Decision

- **A human-set Repository setting, and nothing else.** The Repository profile has an optional `setup`, set only with `factory repo add --setup '<cmd>'`. `repo add` shows it before the operator confirms. It is never detected and never taken from repo content, a Plan or agent output (CLAUDE.md §2). It is one line of at most 1000 characters (`SetupCommandSchema`). Each Job freezes it into its Effective Configuration (`setup: { value, source: 'repository' }`) at creation, so a later change can't reach a running Job. Jobs made before this have `null`.
- **The factory runs it itself**, with `sh -c` in the Worktree, under the Tier 0 guardrail environment of the Attempt. To that, `setupEnvironment` adds only factory-set variables, which always win:
  - the shared caches under `<factory home>/cache`: `npm_config_cache`, `npm_config_store_dir` (pnpm) and `YARN_CACHE_FOLDER`;
  - lifecycle scripts off: `npm_config_ignore_scripts=true` (npm and pnpm) and `YARN_ENABLE_SCRIPTS=false`.
  The allowlist itself is not widened. The time limit is the verification command limit (10 min by default). The running process is recorded on the Attempt (`kind: setup`), and live activity shows it. **After a crash during setup**, recovery stops the process and resumes the same Attempt: the cut-short run was never recorded, so the Worktree is set up again. No Retry is spent, because no Harness was interrupted.
- **When it runs.** Before the developer's Harness Run, and right before verification, both for developer Attempts and for the Integration Task's factory-made Attempts (merge, base merge-in, foreign push). It runs only when `setupNeeded` holds: the Worktree has no setup run yet, its latest one did not pass, or the hash of its dependency files changed since. The dependency files are `package.json` and every lockfile (`DEPENDENCY_FILES`), because a Repository without a lockfile still has its manifest. So it runs once per Worktree, again when a lockfile changes (within an Attempt, before verification, or in a later one), and never otherwise.
- **Recorded like a verification run** in a `setup_runs` row (migration 0027) with a `setup_run.finished` event, in one transaction. It records:
  - the command, the exit code (`null` on a timeout) and the duration;
  - the dependency hash, and the `(head_sha, base_sha)` it ran on;
  - the Worktree's disk usage after the run (`du -sk`), for ARCHITECTURE §10's "record disk usage per worktree";
  - a redacted `log` Artifact.
  - `passed` (it exited 0 and left the Worktree as it found it) and `failure` (why not). The exit code is always the real one (`null` for a timeout or a signal).
  It is not Evidence: a setup that passes proves nothing about the work.
- **It must leave git status clean.** Dependencies go to ignored paths (`node_modules`), so a setup that modifies or adds tracked or untracked files, or moves HEAD, fails. It is recorded as not passed, so the next Attempt sets up again. This is the existing rule that verification leaves the Worktree as it found it.
- **A failure is a human Blocker, never Rework.** The Attempt ends `setup_failed`, the new exit reason (`routeFailedAttempt` routes it before anything else). The Task then waits on the human Blocker `setup_failed`, whose Blocker Approval offers:
  - **Retry the setup:** the `retry_now` path, with the setup running first.
    - A developer Attempt's Retry is a `retry` Attempt and counts against `maxRetries`, which is raised by one, audited, when none is left.
    - A factory-made Attempt's Retry keeps its cause (`merge`, `base_merge`, `foreign_push`) and verifies the same head in the same Worktree again: nothing is merged twice, and it doesn't count as a `retry`.
  - **Cancel the Job.**
  A failure before the Harness Run means no Harness ran. It ends the Attempt in one transaction (`running → verifying → failed`), and nothing the setup left is committed: the factory makes no WIP commit for it.
- **Shown** in `factory job show` (a `setup:` line per run), on the dashboard's Attempt view (a Setup table with a link to the log), on the Attempt API (`setupRuns`), and in the Delivery Report. Each delivered Task has `setup`, the latest run in its Worktree (`DeliveredSetupSchema`, picked from the API's `SetupRunSchema`), with a default `null`, so `reportVersion` stays 6. When any setup ran, a known limitation says it ran on this machine with network access: the Tier 0 guardrail, not isolation.

## Consequences

- The install runs on the host, with network access, as the operator's user. Lifecycle scripts are off for npm, pnpm and yarn, but a command that runs other tools is not confined: Tier 0 is a guardrail, not a sandbox.
- A Repository with no lockfile needs a command that writes none (for example `npm install --no-package-lock`); `npm ci` refuses one with no lockfile. C7's sandbox uses `npm install --no-package-lock --ignore-scripts --no-audit --no-fund`.
- A dependency that needs its install script (a native build) fails at use. There is no per-Repository override yet.
- There is no command to change a Repository's setup after `repo add` (the same holds for its other profile fields).
- Each Worktree gets its own `node_modules`, filled from the shared cache. The Integration Task's Worktree is set up again too.
- A setup that leaves the Worktree changed fails, and the factory never cleans up after it (it discards nothing). A Retry fails the same way until a human cleans the Worktree, or the Job is cancelled. After a crash in `verifying`, the resumed verification's WIP commit would hold whatever a cut-short setup wrote to tracked paths.
- The dependency hash reads only the Worktree root: a workspace member's `package.json` changing doesn't run the setup again. The yarn v1 cache is not safe for concurrent writers.
- The command is stored as given, like verification commands (the database redacts known secret patterns and named secrets as it writes, so a secret in the command text is stored redacted, and the command that then runs is the redacted one). Put credentials in the package manager's own config, never in the command.

## Tests

- **Unit:** `tests/unit/worktree-setup.test.ts` covers:
  - the environment: the caches, scripts off whatever the guardrail environment says, nothing else and no secret added;
  - `setupNeeded`, and the command schema;
  - that `setup_failed` routes to the human Blocker, with its options and titles;
  - that a setup log is redacted the way the Artifact store stores it.
- **Scenario:** `tests/scenarios/worktree-setup.test.ts`, with the Fake Harness:
  - the setup runs before the Harness (a developer step checks its output, the cache path and the scripts-off flag), once per Worktree, and in the Integration Task's Worktree; its log is redacted; the Delivery Report, `job show` and the events record it;
  - a failing setup raises `setup_failed`, no Harness runs, and "Retry the setup" completes the Job with a `retry` Attempt;
  - a lockfile change runs it again before verification, and an Attempt with unchanged dependency files runs none;
  - a crash during setup resumes the same Attempt and sets it up again, with no Retry;
  - a failure in the Integration Task's Worktree raises `setup_failed`, and its Retry verifies the same merge again, in the same Worktree.
