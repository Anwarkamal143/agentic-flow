# `factory doctor` checks (Phase A, issue #3)

Routine, reversible choices for the environment checks.

- **Detection runs in the runtime, behind `GET /v1/doctor`.** The runtime is the process that will spawn git, gh and Claude Code, so its PATH and environment are the ones that matter. The CLI only renders the report. With no runtime, `factory doctor` says so and exits 3 (as `status` does).
- **Tools:** `node`, `git`, `gh`, `claude`, resolved on the runtime's PATH (first executable file wins), then `<tool> --version` with a 10s timeout. Only the first `x.y[.z]` on the first line leaves the runtime. Raw tool output is untrusted and is never returned. Each check is `ok` (version found), `missing` (not on PATH) or `failed` (found, but `--version` errored, timed out or printed no version). Missing and failed tools carry a `fix` hint. No minimum versions are enforced yet.
- **Exit code 0 whenever a report was produced,** even with missing tools. Missing tools are findings, not a doctor failure. Scripts read `factory doctor --json`.
- **Credentials are presence only.** Environment variables `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` are tested for non-empty; the value is never copied into the report. gh's stored login is the exit code of `gh auth status`, with its output discarded.
- **Probes get a minimal environment** (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`). No credential in the runtime's environment is passed to `--version` or `gh auth status`.
- **Doctor writes no events.** A check changes no state, so there is nothing to record in the outbox.

Known gaps: Claude Code's own stored login (`claude /login`, kept in the macOS Keychain or under `~/.claude`) isn't detected, because doing that safely would mean reading a credential store. `gh auth status` makes a network call, so offline it reports the login `absent`.
