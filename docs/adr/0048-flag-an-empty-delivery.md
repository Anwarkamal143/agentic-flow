# Flag an empty delivery

**Status:** accepted (Phase C gate follow-up). The human decided on 2026-11-17, answering the Phase C report: flag a delivery whose diff is empty, don't refuse it. The choices below are routine and reversible.

## Context

C7 run 5 (`factory-sandbox#6`) opened a PR, and after the human's approval merged it, although it changed no files: `sum()` was already on the default branch, so the planner made a no-op Task. Nothing in the factory said so. The PR body, the `merge` item, `job show` and the dashboard all looked like any other delivery.

## Decision

- **Counted at each push.** When the `pull_request` Stage opens a PR or updates one in place (including a force-push after `integration_rewrite`), the factory counts the files the head changes against its base in the Factory Clone (`git diff --name-only <base_sha>..<head_sha>`, the Attempt's own pair) and records the count in `pull_requests.changed_files` (migration 0029), in the same write as the head.
- **Flagged, never refused.** A count of 0 changes nothing about the flow: the PR is opened, polled, gated and merged as any other. It is flagged with one sentence (`emptyDeliveryNote`), shown:
  - at the top of the PR body, as a `## No changes` section before the summary;
  - at the start of the `merge` item's `why`, where the human decides;
  - in `factory job show` (`flagged: …`) and on the dashboard Job page's pull requests card;
  - in the PR record (`changedFiles`) through the API.
- **The poller re-renders from the stored count.** It doesn't diff again, so a body re-rendered for CI shows the same flag.
- **Unknown is not empty.** A PR recorded before this change has `changed_files` null and is never flagged.

## Consequences

- One `git diff --name-only` per push, local to the Factory Clone.
- The count is of the head the factory pushed. A foreign push is adopted through an Attempt and then pushed (ADR-0042), so it is counted when that head is pushed, not when it is first seen.
- The Delivery Report doesn't carry the flag (its version is unchanged); the PR, the merge item and the views do.
