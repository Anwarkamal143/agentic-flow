# The tests verify by named fixture commands (Phase D, #103)

**Status:** accepted (Phase D, #103; the migrate step between ADR-0062's expand and #104's refusal of free shell). The choices below are routine and reversible and touch tests only.

## Context

ADR-0062 lets a verification entry name a Repository Profile command and still runs free shell until #104 refuses it. The Fake Harness script (`tests/support/scripts.ts`) and the scenarios' Plans verified with free shell (`grep -q …`, `test -f …`), and the `tiny-ts` fixture's detected commands (`npm test`, `npm run typecheck`) need a dependency install the scenarios avoid. #103 moves every Plan to names with no behaviour change.

## Decision

- **One fixture command set, `FIXTURE_COMMANDS`** (`tests/support/scripts.ts`), each a plain shell check: `has-sum` and `math-exists` (the valid script's two checks, with the same shell as before), `exists` (`test -f`, accepts arguments), `dir-exists` (`test -d`, accepts arguments) and `pass` (`true`).
- **Declared through the runtime API after `repo add`**, by `declareCommands(rt, ref, commands = FIXTURE_COMMANDS)` (`tests/support/api.ts`), one `POST /v1/repositories/:ref/profile/set` per field, as `repo profile set` does. `registeredRepo` calls it; every scenario that runs its own `repo add` calls it before creating the Job, which freezes the profile (ADR-0060). The fixture generator is unchanged: Profile Detection still proposes `test` and `typecheck` from its `package.json`, which the real tests use.
- **A scenario-specific check is declared next to its test**, as a named command whose `run` is the old shell (`show-fixture` in `redaction`, `no-api-key` in `api-key-billing`, `all-docs` in `parallel-dag`, `a-alone` and `a-alone-or-indexed` in `integration`), so its Evidence's shell is what it was. A per-file check uses `exists` with the path as its argument; where a test asserts the shell that ran, the expectation now reads the quoted argument (`test -f 'docs/a.md'`).
- **What stays free shell:** the tests of free shell itself (the `typecheck` entry in `verification-commands`, and the free-shell cases in unit `plan-validation`), which #104 turns into refusals, and inputs that are Evidence or setup, not a Plan (unit `pull-request-body`, `worktree-setup`).

## Consequences

- Each scenario's profile has five more commands and seven more `repository.profile_updated` events (one per field set) before its Job; no scenario counts them.
- When #104 refuses free shell, the Fake script and the scenario Plans already pass.
