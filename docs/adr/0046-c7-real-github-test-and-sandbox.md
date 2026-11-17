# C7: the `[real]` GitHub test and its sandbox

**Status:** accepted (#67, Phase C, C7). **C7 passed on 2026-11-17** (run 5, `Anwarkamal143/factory-sandbox#6`), after the Worktree setup command (spec issue 43, ADR-0047) and the merge-guard fix (#87); its PR changed no files, because run 4 had already merged `sum()` (see PROGRESS.md and `docs/phases/C.md`). The sandbox is the human's answer 4 (PROGRESS.md): `Anwarkamal143/factory-sandbox`, a dedicated throwaway repository, used only by the `[real]` tests. The choices below are routine and reversible.

## Decision

### The test

`tests/real/c7-github.test.ts` runs only with `pnpm test:real` (never `pnpm test`, never CI). It uses the real Claude Code (as A7 does) and the real GitHub:

1. Preconditions, each failing with its own message (none of them is a C7 result): `gh` logged in as the sandbox's owner with the `repo` and `workflow` scopes, and `claude` logged in.
2. The sandbox setup (below).
3. A factory home with `github.token: gh`, `pollIntervalMs: 10000`, and the Repository registered from a clone of the sandbox with `--merge-policy human_approval --required-check test`. Plan approval is skipped (Project config), so the merge is the human's one decision in the run.
4. One Job, "Add sum() to math.ts". The test waits for `merge_approval` to be `waiting_human`, then checks the PR on GitHub: open, head `factory/<job-id>/integration`, base `main`, the Job's marker in its body, and its head is the head the factory approved and pushed. That head is the reviewed SHA: the Integration Review's approved head when it ran, or, when it was skipped (one Plan Task, ADR-0035), a head whose tree is the tree of the Task head its review approved.
5. CI is real GitHub Actions. The test waits for the required check to pass and the `merge` item to offer `merge`, and checks that the policy condition is still pending and the PR is not merged.
6. **The human decides the merge.** The test prints the exact `factory inbox decide … merge` command (with that run's `FACTORY_HOME`) and writes it to `tests/real/results/c7-waiting.txt`, then waits up to 30 minutes. On each poll while it waits, it checks that the PR on GitHub is still unmerged. The test never decides it itself: a run nobody approves times out, unmerged.
7. After the decision: the Job is `completed`, the PR is merged on GitHub, the recorded merge SHA is GitHub's, `merge.approved` is audited by `user:local` for the reviewed head with method `merge`, and the merge commit's parents are (`main` before the run, the reviewed head).

Each run writes `tests/real/results/c7-<time>.json` (gitignored): the setup, the Job, the PR, the gate, the decision, the reasons it stopped, and the Job's logs.

### Credentials

The runtime keeps the token reference `gh`. Its pushes are plain git (ADR-0036), so the test gives the runtime, through `GIT_CONFIG_COUNT`, a github.com credential helper of `gh auth git-credential` only (the machine's own helpers are cleared for that URL). The pushes and the API calls then use the same login, and the operator's keychain is never consulted. The test reads the token with `gh auth token` for its own reads and never prints it.

### The sandbox setup (`tests/support/sandbox.ts`)

- **Seeded once.** A sandbox with no branches gets two commits on `main`: the generated `tiny-ts` fixture's own commit, then `.github/workflows/ci.yml`, one job named `test` that runs `npm install`, `npm run typecheck` and `npm test` on `pull_request` and on pushes to `main`. A sandbox with branches is never re-seeded. A `main` without that workflow is refused as "not a sandbox this test seeded", and nothing is changed.
- **The workflow kept current (#77).** The seeded workflow now also has the job `rerun-probe`, for `tests/real/rerun-checks.test.ts`: it fails its workflow run's first attempt when the head has `rerun-probe.txt`, and passes otherwise (so it never fails C7, which requires only `test`). Every workflow these tests seed starts with the header `# Seeded by the Software Factory's`. At each run's start, a `main` whose workflow carries that header but differs from today's gets one commit replacing it, pushed as a fast-forward (a `main` that moved meanwhile refuses the push). This is the only write to `main` after the seed. A workflow without the header is refused as "not one these tests seeded", and nothing is changed.
- **Cleaned at the start of each run, not at the end.** The run's own PR stays for the human to look at, and the next run cleans it up. It closes an open PR only when all three hold: its head branch is under `factory/`, the head is in the sandbox itself (not a fork), and its body carries a factory marker. It then deletes every `factory/*` branch, except one that is the head of an open PR the factory didn't open. Deleting that branch would close someone else's PR.
- **Scoped to one repository.** Every API request is built under `/repos/<owner>/<name>/`, and the full name is checked against GitHub's owner/name shape before anything is sent. The C7 test passes the constant `SANDBOX`. Apart from the sandbox, the test reads only `GET /user` (the precondition).

`tests/integration/sandbox.test.ts` drives the same client against the fake GitHub, over real HTTP: it seeds an empty repository once and refuses a `main` without the workflow. With a second repository holding a marked factory PR, it closes only the marked factory PR, deletes only the factory branches that no unmarked PR uses, and sends requests to the sandbox's paths only. For this the fake GitHub gained empty repositories and `GET /repos/{o}/{n}/git/matching-refs/{ref}`. This widens the integration tier (ADR-0025, ADR-0033) to a test-support GitHub client driven against the fake; CLAUDE.md §6 says so.
- **One page only.** The cleanup reads one page of 100 open PRs. With 100 or more it refuses and changes nothing, because a later page could hold an unmarked PR whose `factory/*` branch must be kept.

## Consequences

- C7 needs the human to finish. It is a demonstration on demand, not a regression check.
- C5 on the real GitHub needs a review from a second account (Q7), so C7 doesn't run it. C1–C6 and C8 are proven against the fake GitHub only.
- A subscription usage limit hit during the run fails the Job with the CLI's reason (the usage-window pause is Phase E, E2). The outcome file records it, and it is not a C7 result.
