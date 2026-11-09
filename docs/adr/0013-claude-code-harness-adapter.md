# The Claude Code Harness adapter (Phase A, issue #14)

Choices made while adding the first real Harness (ROADMAP exit test A7). All are routine and reversible except where marked.

## Selection and startup

- **Runtime configuration is the only switch.** `config.json` `harness: { "id": "claude-code", "command": "claude", "model"?: "…", "billing": "subscription" }`. `command` is an absolute path or a name looked up on the runtime's PATH (default `claude`). No other code path changes: the proposal Stages, the developer and the reviewer go through the same `AgentHarness` contract as the Fake.
- **A Harness that can't be driven stops the runtime at startup** (`harness 'claude-code' <version> can't be used: …`), like a broken Fake script. Starting anyway would turn every Harness Run into a failure caused by configuration. A missing login is only a warning (`credentials: absent`): the login can be fixed without a restart, and Harness Runs fail with the CLI's own reason (`Not logged in · Please run /login`) until it is.

## Flags verified against the installed version (shared with `factory doctor`)

- **`probeClaudeCode`** (`packages/harness/src/claude-code.ts`) is the one check, used by the adapter's `detect` and by `GET /v1/doctor`. It runs `--version`, `--help` and `auth status` (exit code only, output discarded) with the guardrail env, so no secret reaches it. Every flag in `CLAUDE_CODE_FLAGS` must be listed in `--help`; a missing one is a `problem` (doctor: Claude Code `failed`, with the flags in `fix`).
- **`--max-turns` can't be verified offline.** Claude Code 2.1.319 accepts it but leaves it out of `--help`, and `--version` short-circuits before options are checked, so no dry probe exists. It is listed as `unverified` (a doctor note), still passed, and a CLI that rejects it fails the Harness Run with its own reason (`error: unknown option '--max-turns'`). Dropping it would leave only the wall-clock limit, which costs more when a Harness Run loops.
- `doctor` gains the `claude_login` credential (`claude auth status`), which replaces the "not checked" line (ADR-0003's known limitation).

## How a Harness Run is driven

- **Headless and structured:** `--print --output-format stream-json --verbose`. The prompt goes on **stdin**: the guardrail gains `GuardedOptions.input`, written to the spool (mode 0600) and given as the process's stdin. It never goes on the command line (`ps` shows argv; prompts can be large).
- **The Session id is chosen by the adapter** (`--session-id <uuid v4>`), so `HarnessRun.sessionRef` is known before the process starts and is recorded on the Attempt (developer) or the review (reviewer) as before. Each Harness Run is a new Session; `resume` stays unimplemented (Phase B's questions protocol).
- **Nothing outside the factory's policy is loaded:** `--setting-sources ''` (neither the Repository's `.claude/settings*.json`, which is untrusted repo content, nor the operator's own settings and hooks can widen the policy), `--strict-mcp-config` with no `--mcp-config` (no MCP server), `--disable-slash-commands` (no skills). The Repository's `CLAUDE.md` is still read by the CLI: repo content may inform the work, never grant anything.
- **Output is read from the spool**, like every guarded process (ADR-0012), so a Harness Run can be re-attached after a runtime crash (`reattach`, the token is the Session id). While the process runs, the adapter tails the output file every 200 ms and turns stream events into `HarnessEvent`s (assistant text → `text`, a tool use or a permission denial → `progress`, the result → `usage`); the runtime counts them as before.

## The Tier 0 tool policy comes from the Effective Configuration

- **`EffectiveConfig.toolPolicies`**: one `{allow, deny}` per Role, in Claude Code's rule syntax, recipe-level only (a Project can't widen it), frozen onto the Job like the rest. Jobs created before #14 get the recipe default. `HarnessStartInput.policy` carries the Role's entry; the Fake ignores it.
- **Recipe defaults** (`DEFAULT_TOOL_POLICIES`, `packages/domain/src/tool-policy.ts`): the proposal Roles get `Read, Glob, Grep`; the reviewer gets those plus `Bash(git diff|log|show|status:*)` and is denied `Edit`, `Write`, `NotebookEdit`; the developer gets `Read, Glob, Grep, Edit, Write, Bash` and is denied `git push`, `git reset --hard`, `git clean`, `git rebase`, `git switch`, `git checkout -b`, `git branch -D`, `git config`, `curl`, `wget`, `sudo` and package publishing. Every Role is denied `WebFetch` and `WebSearch`.
- **The flags:** `--tools` (the tools that exist at all: the tool names of `allow`), `--allowed-tools <allow…>`, `--disallowed-tools <deny…>`, under `--permission-mode dontAsk` and `--permission-prompts none`: anything not allowed is denied, never prompted for.
- **This is a guardrail, not isolation** (ARCHITECTURE §11). The CLI enforces it on itself, a shell command can do anything the operator can, and the network is not restricted. The factory still checks the result itself (the path-scope Gate; a reviewer that changes the Worktree fails the Gates).

## Results, failures and usage

- **A Harness Run succeeds only with a successful `result` event.** Exit 0 with `is_error: true`, or no `result` event at all, is reported as a failed Harness Run (`exited` with code 1 when the process exited 0). The Harness Run's output is the result text (for proposals and reviews, the JSON the runtime validates); for a failed Harness Run, the raw stream (it becomes the Harness Run's `log` Artifact, redacted).
- **Failures carry a specific reason.** `HarnessExit` `exited` gains an optional `reason`, and `describeHarnessExit` appends it, so every failure message the runtime already writes says why: `the triage Harness Run exited with code 1: Claude Code reported error_max_turns: Reached maximum number of turns (30)`. The reason is untrusted text from the CLI, cut to 500 characters and redacted on write; it explains a failure and decides nothing.
- **Usage gets two honest tags.** `Usage.tag` is the trust of the token counts; the new `Usage.costTag` is the trust of the cost and can be `unknown/subscription` (ARCHITECTURE §13). The adapter reports the CLI's token counts as `actual` (input includes cache reads and writes: the Harness Run read them) and the cost as `null`, `unknown/subscription`: the CLI's `total_cost_usd` is a list-price figure, not what a subscription Harness Run cost. `addUsage` keeps the less trusted cost tag (`actual` > `estimated` > `unknown/subscription` > `unknown`). Usage recorded before #14 has no `costTag`; `costTagOf` reads its `tag`. `job show` prints `usage 15 in / 3 out tokens (actual), cost unknown/subscription`.
- **Proposal Harness Runs get `maxTurns` 30**; developer and reviewer Harness Runs keep 50 (`MAX_TURNS`).

## Credentials (permission question left open)

- **No credential is passed to the Harness process.** Its env is the guardrail allowlist (ADR-0007); the CLI finds the operator's subscription login (the macOS keychain) through `HOME` and `USER`, both allowlisted. Without `USER` it reports `Not logged in`, so the runtime must be started from the operator's own session. An `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the runtime's environment never reaches it, so a Harness Run can't bill an API key by accident.
- **API-key billing is not built.** It would mean passing a secret into a process whose shell commands inherit it, which is a permission expansion (CLAUDE.md §1.6) for the human to decide. `billing` accepts only `subscription` until then. The same goes for operators whose only login is a `CLAUDE_CODE_OAUTH_TOKEN` in the environment.

## Tests

- **Deterministic, in `pnpm test`:** `tests/scenarios/claude-code.test.ts` points the runtime at `tests/support/claude-stub.mjs`, a stand-in CLI (NOT Claude Code) that speaks the stream-json protocol with responses scripted per Role and records each invocation (argv, env names, pids). It covers the selection by config, every Role through the adapter, the flags per Role from the policy, no secret in the env, the prompt on stdin, the Session id, version and usage tags on the Attempt and review, the failure reasons, cancellation with a child process, the startup refusal and the doctor report.
- **`[real]`, on demand only:** `pnpm test:real` (`vitest.real.config.ts`, `tests/real/`), excluded from `pnpm test` and CI. A7 runs the A1 scenario on a generated `tiny-ts` with the real CLI (the runtime gets the operator's `HOME` and `USER` so the CLI finds its login; no login is a precondition failure, never an A7 result), and passes when the Job completes or stops with a specific recorded reason; a second test cancels a real Harness Run and checks no process of its group is left. Each run writes its outcome to `tests/real/results/` (gitignored).

## Known limitations

- The usage window (`paused_until` per Harness account, ARCHITECTURE §13) is not tracked: a Harness Run that hits a usage limit fails with the CLI's reason, like any other failure, instead of pausing dispatch.
- `--max-turns` is unverified (above). A Claude Code version that changes the stream-json event shapes would be read as "no result event" and fail the Harness Run with that reason, not silently succeed.
- The developer's own `git commit` runs the Repository's hooks (Tier 0 can't stop that); the factory's own git calls still disable them (ADR-0007).
- Claude Code writes its Session transcripts under the operator's `~/.claude/`, outside the factory home. They are not redacted by the factory.
