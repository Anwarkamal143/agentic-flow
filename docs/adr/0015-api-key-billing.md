# API-key billing for Claude Code (a permission expansion)

**Status:** accepted. Approved by the human on 2026-11-09 (PROGRESS.md "Human decisions", option (b): built after the Phase A gate, before Phase B).

This is a **permission expansion**. Under `billing: "api_key"`, the factory hands a credential to the agent. ARCHITECTURE §11 Tier 0 says "secrets never in env unless a policy grants a named one", and this ADR is that grant, for exactly one name.

## The grant

- **Named and off by default.** In `config.json`, `harness: { "id": "claude-code", "billing": "api_key" }` passes exactly `ANTHROPIC_API_KEY`, taken from the runtime's environment, to every Claude Code Harness Run: triage through planning, the developer, and the reviewer. The default, `subscription`, passes no credential, as ADR-0013 does, and a key in the runtime's environment is stripped by the guardrail allowlist.
- **To Harness Runs only.** The key is added by the Claude Code adapter (`ClaudeCodeHarness.credentialEnv`), not by the guardrail. The factory's own verification commands, git calls and probes never get it. A scenario proves this with a required verification command, `test -z "${ANTHROPIC_API_KEY:-}"`.
- **Refused when it can't be honoured.** `billing: "api_key"` without `ANTHROPIC_API_KEY` in the runtime's environment stops the runtime at startup (`API_KEY_MISSING`: `billing 'api_key' needs ANTHROPIC_API_KEY in the runtime's environment`). Otherwise every Harness Run would silently fall back to the login or fail. The adapter's options make the bad state unrepresentable: `ClaudeCodeBilling` is `{ kind: 'subscription' } | { kind: 'api_key'; apiKey }`.

## What it exposes, said plainly

- **The key is visible to the Harness and every command it runs.** It is in the Harness Run's environment, and Tier 0 is a guardrail, not isolation:
  - a `Bash` command can read it;
  - the network is not restricted;
  - any process of the operator's user can read it (e.g. `ps eww`).

  It is never written to the spool, which holds only the prompt. The wording is defined once, `API_KEY_EXPOSURE` and `API_KEY_BILLING_NOTE` in `@factory/domain`. It is shown in:
  - `factory doctor` ("Billing: Claude Code is billed to an API key (ANTHROPIC_API_KEY, present): the key is visible to the Harness and every command it runs (Tier 0 guardrail, not isolation).")
  - `factory status` ("billing: billed to an API key, …")
  - `job show`, on every Attempt whose Harness Runs were given the key
  - the dashboard, next to that Attempt's cost

  The human's wording said "agent"; the GLOSSARY's term is "Harness".
- **Redaction** already covers the key: `*_API_KEY` and the Anthropic key pattern (ADR-0011). A scenario has the Harness print the key and finds it nowhere: not in the logs API, events, Attempts, reviews, Artifacts, the runtime log, `factory logs`, or any file in the factory home.

## Cost: tagged by what the Run was actually billed to

- **Two facts, kept apart.**
  - **What was passed.** `Usage.billing` is the billing the factory set up for the Harness Run: `api_key` means the key was in its environment. The exposure wording follows this, so a Harness Run given the key says so even if it died before reporting anything. `addUsage` keeps `api_key` if either Harness Run had it.
  - **What paid.** The cost tag follows what the Harness Run was actually billed to, as the `init` event's `apiKeySource` reports it (`none` is the CLI's own login, `ANTHROPIC_API_KEY` the key). If the CLI used the login despite `api_key`, the cost is `unknown/subscription`, with the warning still shown.
- **Under the key, the cost is `estimated`** (ARCHITECTURE §13). It is computed per model from the result event's `modelUsage`, by the pure `harnessRunCost` (`@factory/domain`):
  - **A configured price table** (`harness.prices`), when it lists the model: `{ inputUsdPerMTok, outputUsdPerMTok, cacheReadUsdPerMTok, cacheWriteUsdPerMTok }`. This is for negotiated rates. All cache writes are priced at one rate, although Claude Code reports 5-minute and 1-hour cache writes separately.
  - **Otherwise Claude Code's own list price** (`costUSD`, `costBasis: "list"`). The repo ships no prices of its own, because they would go stale.
  - A model with neither, or no per-model usage at all, makes the cost `unknown`, never a guess.
- **The shape was checked against Claude Code 2.1.x on 2026-11-09** with one minimal real run (a one-word prompt, tools off, on the subscription login, approved by the human). The result event carries `modelUsage.<model>.{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, costBasis}`, and the `init` event carries `apiKeySource`. The stand-in CLI (`tests/support/claude-stub.mjs`) now emits both. A real run billed to an API key has not been made.

## Not built

- No other credential: no `CLAUDE_CODE_OAUTH_TOKEN` grant, no `apiKeyHelper`. Billing doesn't change usage-window handling (Phase E, E2).
- Proposal-Stage Harness Runs (triage through planning) get the key too, but have no usage record of their own (ADR-0006: events only). Only `factory status`, `factory doctor` and the configuration say that they had it.
- A real Harness Run billed to an API key has not been made, so `apiKeySource: "ANTHROPIC_API_KEY"` is what the stand-in reports, not yet what Claude Code was seen to report. When a login also exists, a real run may report otherwise. Then the cost is tagged `unknown/subscription`, and the warning is still shown.
- No budget enforcement (v1). The estimate is recorded, not acted on.
