# Verification commands come from the Repository Profile

**Status:** accepted (Phase D design grilling, Q11, Q12, Q20, Q21, Q32, Q35; resolves spec issue 44; confirmed by the human 2026-11-17).

The planner used to write each Task's verification as free shell commands, and one of them most likely installed dependencies, getting around the rule that setup is set only by a human (spec issue 44). A Task's verification now names commands of the confirmed Repository Profile, so what the factory runs as Evidence is always something a human confirmed.

## Decision

- **Profile Detection is deterministic file inspection, no LLM.** It proposes the package manager, named commands (from `package.json` scripts), CI files (`.github/workflows/*`, with candidate required checks), instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) and Sensitive Paths (a fixed list: `.env*`, `.github/workflows/**`, `infra/**`, `**/*.pem`, … plus every instruction file found). Every value is a proposal until confirmed; `repo add` asks interactively, or `--yes` accepts what was detected. `setup` is never detected (ADR-0047). Detection never writes to the source or the Factory Clone (D4).
- **Verification entries are `{key, command, args?, required, criteria}`**, `command` a profile command name. Free shell is refused by the plan validator and goes through the usual re-prompt. A profile command marked `acceptsArgs: true` takes arguments matching `^[A-Za-z0-9._/:=@+,-]+$`, shell-quoted and appended; other commands refuse arguments. Every mandatory AC still needs one entry naming it.
- **Sensitive Paths are added to every Task's `forbidden`** at plan validation; forbidden beats writable. A `writable` entry that is literally a Sensitive Path pattern makes the plan invalid. Widening is Phase E's `scope_change`; until then a human edits the profile.
- **Existing profiles are migrated to v2 without detection,** their new fields marked "not detected" and the fixed Sensitive Paths list applied; `factory doctor` recommends `repo profile detect <repo>` (a diff to confirm). `repo profile set` edits fields directly.
- **Instruction files are listed, never written,** and given to the Task Packet as context items.
