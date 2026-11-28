# Repository Profile v2 and Profile Detection (Phase D, #100)

**Status:** accepted (Phase D, #100; implements the detection and migration parts of ADR-0051). The choices below are routine and reversible.

## Context

ADR-0051 decides that a Repository Profile is proposed by Profile Detection, confirmed by a human, and that verification will name its commands. #100 builds the profile v2 shape, detection, `repo add` confirmation, `repo profile detect | set`, the migration of v1 profiles and the `doctor` recommendation. Enforcing Sensitive Paths (#101) and verification by command name (#102) build on it.

## Decision

- **The snapshot is the source's HEAD commit, read by git plumbing.** `committedPaths` (`git ls-tree -r -z --name-only HEAD`) and `committedFile` (`git cat-file`, files over 1 MiB left out) read objects only, never the index or the working tree. Detection reads `package.json` and `.github/workflows/*.y{a,}ml` (`profileDetectionReads`); every other rule uses paths only. Uncommitted files are not what the Factory Clone gets, so they are not detected. `repo profile detect` reads the source's HEAD again (not the Factory Clone, which is not fetched), and refuses with `422 source_unreadable` when the source is no longer a working tree.
- **The profile v2 shape** (`packages/domain/src/profile.ts`): `version: 2`, `detection: detected | not_detected`, `packageManager`, `commands` (a record of named commands, `{run, acceptsArgs}`), `ciFiles` (`{path, checks}`), `instructionFiles`, `sensitivePaths`, and as before the human-set `requiredChecks`, `setup` and `confirmedBy`/`confirmedAt`.
- **Detected commands** are `build`, `lint`, `test` and `typecheck` (from `typecheck`, `type-check` or `tsc`), with ADR-0004's runner rules. Other scripts (`dev`, `release`, `setup`, …) are never proposed; a human adds one with `repo profile set <repo> commands.<name> <command>`. `acceptsArgs` is never detected (always `false`); a human turns it on with `commands.<name>.acceptsArgs true`.
- **Candidate checks** are each workflow job's `name`, else its id, read by a line reader, not a YAML parser; a name built from `${{ … }}` is left out. They are only candidates: `requiredChecks` stays human-set (`--required-check`, or `repo profile set <repo> requiredChecks '[…]'`), so `--yes` never changes what the Merge Gate counts.
- **Instruction files** are any tracked `CLAUDE.md`, `AGENTS.md` or `.cursorrules`, at any depth. Each is added to the Sensitive Paths after the fixed defaults `.env*`, `**/.env*`, `.github/workflows/**`, `infra/**`, `**/*.pem`, `**/*.key`.
- **v1 profiles are upgraded when read, not rewritten.** `RepositoryProfileSchema` reads a v1 profile as v2 `not_detected` with the default Sensitive Paths and its two commands named; the stored row changes only when a human runs `repo profile detect` or `set`. So nothing changes silently, and no data migration is needed. The Job snapshot's per-Repository section now carries `commands` as named commands (a v1 `{test, typecheck}` reads as named) and `sensitivePaths` (absent in older snapshots: the defaults), so #101 and #102 read them from the frozen section.
- **`repo add`** shows every detected field (`--test-command` / `--typecheck-command` still replace or, empty, remove one) and sends the confirmed fields as `profile`; the runtime saves them with `detection: detected`. `--yes` accepts what was shown.
- **`repo profile detect <repo> [--yes]`** shows the proposal and a field-by-field diff (`profileChanges`) and saves on `y`. The apply call carries the shown profile's `confirmedAt` as its basis; a profile changed since is `409 profile_changed`. Detection never changes `setup` or `requiredChecks`.
- **`repo profile set <repo> <key> <value>`** sets `commands.<name>` (empty removes), `commands.<name>.acceptsArgs`, `packageManager` (`none` clears), `sensitivePaths`, `instructionFiles`, `requiredChecks` (JSON arrays) and `setup` (empty removes; still never detected). Removing a Sensitive Path is allowed (PRODUCT_SPEC story 40). `detection` and `ciFiles` are not settable.
- **Each change is audited** (`repository_profile.detected` / `repository_profile.set`, target `repository:<id>`, before and after) with a `repository.profile_updated` event (`via`, `changes`) in the same transaction. A `<repo>` is an id or a name unique across Projects (`409 repository_ambiguous` otherwise).
- **`factory doctor`** lists each `not_detected` profile under "Repository Profiles" with the `repo profile detect` command (`undetectedProfiles` in `--json`).

## Consequences

- D4 is tested end to end (`tests/scenarios/repo-add.test.ts`): a `CLAUDE.md` stays byte-identical in the source and the Factory Clone, and is listed as an instruction file and a Sensitive Path.
- The Sensitive Paths are stored and frozen here; #101 merges them into each Task's `forbidden` (ADR-0061). Instruction files are not yet given to the Task Packet (they are since #102, ADR-0062).
- Detection covers `package.json` projects and GitHub Actions only.
