# The Harness lock-out from GitHub

**Status:** accepted (#53, Phase C). Implements Phase C decision Q9 (PROGRESS.md "Human decisions"), inside ARCHITECTURE §11 (Tier 0). Pure rule in `packages/domain/src/tool-policy.ts` (`INVARIANT_DENY`, `withInvariants`); the env scrub in `packages/harness/src/guardrail.ts` (`ENV_SCRUBBED`).

## Decision

Before the factory's own GitHub credentials are in play (the GitHub adapter, Q4), no Harness Run can drive the operator's GitHub login.

- **`gh` is denied to every Role.** `Bash(gh:*)` is in every recipe tool policy's `deny`. It is also an **Immutable Invariant** (GLOSSARY, `INVARIANT_DENY`): `toolPolicyOf` adds it to whatever policy a Job's frozen Effective Configuration holds, so a Job created before this change is locked out too. Invariants rank above every configuration level (ARCHITECTURE §15), the frozen snapshot included; this is the only place a frozen value is changed on read, and only ever to narrow it.
- **The GitHub credentials never reach a guarded process.** `GH_TOKEN`, `GITHUB_TOKEN` and `GH_CONFIG_DIR` are removed from the environment of every process the guardrail starts (Harness Runs and verification commands), whoever adds them: `guardrailEnv` drops them, and `spawnGuarded` drops them again from the final environment, so a Harness's own additions (the API key under `api_key` billing) can't carry them either. The allowlist already left them out; the scrub makes it hold if the allowlist or the factory's variables grow. Verification commands are included on purpose: they run Repository code, which is just as untrusted.

## What this is not

A **guardrail**, never isolation. Under Tier 0 the Harness runs as the operator's user:

- the `gh` login on disk (`~/.config/gh/hosts.yml`, or the macOS Keychain) stays readable to it;
- the deny rule is a prefix match on the command the Harness's shell tool runs. It is defense in depth only: `env gh …`, `/usr/local/bin/gh …`, a script that calls `gh`, or any other program that reaches GitHub gets around it. (`git push` through a stored credential helper and `curl` are separate deny rules; only the developer and the reviewer have a shell at all, the reviewer limited to reading git.)

The tier label (`SECURITY_TIER_LABELS`, shown by the dashboard and `factory job show`) and the Delivery Report's limitations say so. Real isolation is Tier 1 (Phase E).

## Known gaps

- The scenario test (`tests/scenarios/claude-code.test.ts`) puts the variables in the runtime's environment only; the factory layer of the scrub has no test of its own, since unit tests cover `@factory/domain` only.
