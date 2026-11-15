# The Integration Review

**Status:** accepted (#56, Phase C, C8). Routine and reversible choices inside ARCHITECTURE §9, the Phase C grilling (Q2, Q17, Q18, Q24, Q25) and the GLOSSARY.

## The `feature` Recipe, version 4

Version 4 adds `integration_review` between `integration` and `closure`. Versions 2 and 3 are kept (`featureRecipe(version)`); a Job keeps its frozen Workflow Snapshot, so a Job created at v3 approves its Integration Task on its verification alone, and a Rework of it is reviewed by the Task reviewer, as in ADR-0034. `FACTORY_TEST_RECIPE_VERSION` accepts `2`, `3` and `4`.

## Where the Integration Review runs: the Integration Task's own review step

Q2 says the Integration Task's first Attempt "merges, verifies and runs the Integration Review", and Q17 says `integration` is merge plus verification, and `integration_review` holds the Integration Review and its Rework. Both hold with one rule: **the Integration Task runs in `integration` until its Gates pass, then in `integration_review`.**

- When the Integration Task's Gates pass on the integration head while it runs in `integration` (its merge Attempt, or a Rework after a failed integration Gate), the factory decides, in the transaction that records the passing Gates (`enterIntegrationReview`):
  - **skip** (the rule below): `integration_review` is `skipped` with the reason in its event; the Attempt passes, the Task is approved, `integration` succeeds and closure is queued, as before.
  - **review**: `integration` succeeds, `integration_review` goes `queued → running`, and the Attempt and Task go to `in_review`. The Attempt's review step is the Integration Review.
- `stageOfTask(kind, integrationReviewStarted)` (pure) gives a Task's Stage: `execution` for Plan Tasks; for the Integration Task, `integration_review` once the Job's newest `integration_review` Stage Run has started (neither `pending` nor `skipped`), else `integration`. Everything that asked for a Task's Stage (the claim, Blocker and Question items, the re-queue after a cleared Blocker, a cancel check, the Harness Run subject) now uses this, so a Rework, a cap Blocker, a grant or a Question of the Integration Task waits and resumes in `integration_review`. The claim joins a ready Integration Task to `integration` or `integration_review` (at most one is ever queued or running).
- `settleIntegration` settles whichever of the two the Integration Task is in, with the keep-going rule (`executionOutcome`). An Integration Task approved in `integration` with its Integration Review neither started nor skipped is an invariant breach and throws.
- An Integration Review once started is never skipped: its Rework is reviewed again, and a merge Attempt redone after one interrupted during its review ("retry now") goes straight to the Integration Review.

Alternative not taken: a separate review-only Attempt in `integration_review` after the merge Attempt passed. It would need an Attempt with no work, or a review row with no Attempt; reviews, Findings, caps and Rework routing are all per Attempt (Q2: reused).

## The skip rule

`integrationReviewSkip({ planTasks, integrationTree, reviewedTree })` (pure, unit-tested): skipped only when the Job's newest Plan has exactly one Plan Task and the Integration Branch's tree equals the tree of the head the Integration Branch merged for that Task, when a review approved that head (Q18). With a moved base the trees differ and the review runs. No approving review to compare with → it runs.

## The review itself

- **Packet:** `ReviewPacket.scope: 'task' | 'integration'` (default `task`, so stored packets still parse). The Integration Review's packet has the current Specification, **every** Acceptance Criterion of it (not only the Integration Task's union), the diff `base..integration head` (the Attempt's base is the freshly fetched base the merge started from), and the factory's Evidence on the integration head. Its criterion Evidence and the approval rule use the same set.
- **Template:** `integration-review-packet@1`, recorded on the review row with its hash; it asks for problems between Tasks (inconsistent changes, duplicated helpers, criteria no single Task meets) and says which Fault Origin a fix on the branch, a Plan problem or a Specification problem takes. Same output schema and validation as a Task review, one re-prompt.
- **Valid only for its SHA:** the review row records the integration `(head_sha, base_sha)`; `decideApproval` judges it against the head as git reads it when the review ends.

A failed `execution` skips `integration_review` along with `integration`, and a failed `integration` skips it too ("nothing to review").

## Routing its Findings

`routeFailedAttempt` routes them like any review's (§4.6), unchanged:
- `implementation`: a Rework Attempt of the Integration Task, a developer Run on the Integration Branch in the same Worktree, carrying the Findings, writable paths the union of the Plan Tasks' writable globs (its definition, ADR-0034). A change outside fails the path-scope Gate; a `scope_change_request` becomes the existing Question (guidance, or replan with the request as feedback). Caps come from the Effective Configuration; at the cap, the `rework_cap_reached` Blocker Approval.
- `plan`: the existing plan route cancels the Integration Task (`cancel_reason: replan`, Worktree preserved) and asks for a Replan with the Findings as feedback. `activeTaskStage` now includes `integration_review`; replacing it adds new Stage Runs of `integration` and `integration_review`, and a new Integration Task rebuilds the branch once the new Plan's Tasks are approved (Q25).
- `spec`: the existing spec route; on approval its Replan cancels the Integration Task the same way.

## Nothing is delivered before approval

No push exists yet (`pull_request` is a later issue). The Delivery Report is written by closure, which is queued only when `integration_review` succeeds or is skipped, and offers the integration head the review approved.

## The Fake Harness

A Task's scripted Runs are now counted per (Job, Task key, Role) across Stages, as its header already said, so the Integration Task's responses go on in order when it moves from `integration` to `integration_review`. The shared scenario script carries one approving `integration` review.
