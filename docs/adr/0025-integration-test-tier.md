# The integration test tier and the claim race (Phase B, issue #40)

**Status:** accepted (#40, Phase B exit test B2). Routine and reversible choices about tests only; no runtime, schema or product behavior changes. Builds on ADR-0020 (the claim and capacity tokens).

## Why a third tier

The unit tier tests pure `@factory/domain` rules, and the scenario tier drives the built runtime and CLI over HTTP without opening the database. Neither can show that two writers racing on one SQLite file claim a ready Task once: the scenario tier has only one runtime, and the unit tier has no database. B2 asks for exactly that race, so `tests/integration/` is a new tier between them.

## What the tier may do

- **Open the real database and call exported runtime functions.** Tests open the file with `openDatabase` (`@factory/db`: WAL mode, `busy_timeout`, migrations) and import the built runtime (`apps/runtime/dist/*.js`), never its sources, so they test what ships. The runtime is not changed for the tier: `claimNextTask` and `releaseClaim` were already exported by #39 (`apps/runtime/src/claim.ts`).
- **Use real child processes, no mocks.** A racing writer is a `fork`ed Node process (`tests/integration/claimer.mjs`) with its own connection, driven over IPC.
- **Seed state directly.** A test may insert the rows a scenario would reach through intake, planning and plan approval (a Project, a Repository, a Job at `execution`, ready Tasks with `task.created` events), with snapshots built by the domain's own functions (`FEATURE_RECIPE`, `resolveEffectiveConfig`, `TaskDefinitionSchema`). It may also tidy between rounds. Seeded rows are fixtures, labelled as such in the test, not evidence that the scheduler produced them.
- The root `package.json` gains dev dependencies on `@factory/db` and `drizzle-orm` (the pinned version the workspace already uses) so the tier can open and query the database.

## Test-only: "one writer" still holds

Two processes writing one database exist **only in this tier**. In production only `apps/runtime` writes the database, and only its Task scheduler calls `claimNextTask` (CLAUDE.md §2). The tier proves the claim stays correct if that is ever not so (a second runtime started by mistake, or recovery overlapping a live process), because the claim relies on `BEGIN IMMEDIATE`, the re-check of `ready` inside the transaction, and the `leases` primary key, not on there being one writer.

## The claim race (B2)

`tests/integration/claim-race.test.ts`: two dispatchers (`runtime:race-a`, `runtime:race-b`) share one temporary database file. Each round the test seeds a new Job with three ready Tasks, sends both processes "go" at once, and each calls `claimNextTask` until it returns `undefined`.

- **Every ready Task is claimed exactly once (100 rounds).** Limits leave room for all three (global 3, per Repository 3, per Job 3). The two processes' claims together name each seeded Task once; each claimed Task is `claimed`, has one `task.claimed` event whose actor is the winner, and one `task` lease with the winner's holder and `lease_id`. Over the rounds both processes must win some claims, so the test shows a real race and not one process doing all the work.
- **No capacity token is held twice at the limits (100 rounds).** Three ready Tasks, room for two (global 2, per Job 2). Exactly two claims; the third Task stays `ready`. The claims' tokens are distinct, three per claim, and equal to the `capacity.*` rows in `leases` with matching `lease_id`s; each kind's slots are the lowest free ones (`0`, `1`).
- After each round the claims are released with the runtime's `releaseClaim` (as an Attempt ending does), and an unclaimed leftover Task is set `cancelled` directly so the next round can't claim it (fixture tidy-up, not a transition the runtime made).
- The test was checked against a broken claim: with the in-transaction `ready` re-check and the `task` lease check removed from the built `claim.js`, both tests fail (a second process steps a Task `claimed → claimed`). The real build was restored afterwards.

## Is it part of `pnpm test`?

**Yes.** `pnpm test` runs every `tests/**/*.test.ts` except `tests/real/`, so the tier runs with it. It is deterministic (the assertions hold for every interleaving), uses no network and no Harness, and takes a few seconds. `pnpm test:integration` runs only this tier (`vitest run tests/integration`), like `pnpm test:e2e` for the scenarios. Both go through the same global setup, which builds first, because the tier imports the built runtime.

## Not done

- No other runtime function is covered by the tier yet. A later test may join it under the same rules.
- The race is two processes on one machine. It doesn't exercise the scheduler around the claim (repository setup, the Harness), which the scenario tier covers with one runtime.
