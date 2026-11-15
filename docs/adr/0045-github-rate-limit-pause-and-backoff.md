# The GitHub rate-limit pause and the transient backoff

**Status:** accepted (#66, Phase C). The human decision is Phase C grilling Q23 in PROGRESS.md (ARCHITECTURE §13 and §14). The choices below are routine and reversible. Extends ADR-0033 (the port's failure classes) and ADR-0037 (the poller).

## A rate limit pauses every GitHub call

A rate limit is capacity, not failure, as a Harness Usage Window is (ARCHITECTURE §13). The port already classifies a 429, or a 403 with `x-ratelimit-remaining: 0` or `retry-after`, as `rate_limited` with GitHub's reset (ADR-0033).

- **Where it is kept.** The new `github_state` table (migration 0026) has one row (`id = 'github'`) with `paused_until`, `paused_at` and `pause_status`. Only the runtime writes it (`GitHubPauseGate`, `apps/runtime/src/github-pause.ts`), with an event in the same transaction: `github.paused` when a pause starts, `github.pause_extended` when a later reset moves it, and `github.resumed` when it ends. The events have `entity_kind: github` and no Job.
- **Where it is enforced.** `GitHubPort` takes an optional `RateLimitGate`. Every rate-limit response is reported to it, and before each request the port asks it for the pause in force. While `until` is in the future, the request is not sent: it fails `rate_limited` at once with the same reset. Every caller goes through the one port, so the poller, the `pull_request` Stage, the merger, the cancel cleanup and the Inbox's `rerun_checks` and `reopen_pr` all stop at once, and each handles `rate_limited` as it already did: it waits, or (an Inbox decision) answers 502 with nothing decided. The gate keeps the committed row in memory (one writer), so a request costs no query.
- **Ending it.** A timer fires at the reset, clears the row with `github.resumed`, and wakes the schedulers and the poller. The row is persisted: a runtime started during a pause keeps it, and one started after the reset ends it at once (with `github.resumed`).
- **No Stage Run changes and no Blocker.** The poller runs no pass while paused (no log line per PR). The `pull_request` Stage's retry loop waits for the reset after a `rate_limited` and tries again without spending one of its transient tries (in 1-second slices, so a shutdown isn't held up). Before this change, a rate limit used up the tries and failed the Stage. The merger and the cleanup already treated a rate limit as "try again later".
- **Shown.** `GET /v1/github` returns `{ pause: { pausedUntil, pausedAt, status } | null }`, and `GET /v1/status` carries the same value as `github`. `factory status` prints `github: paused until <reset> …` or `github: not paused`. `factory job show` prints it above the pull requests. The dashboard shows a "GitHub calls are paused until …" card on the Job list and on the Job detail. They read only the persisted row.

Not covered: `git push` and `git ls-remote` go over git, not the REST API, and GitHub's REST rate limit doesn't apply to them. A push is not held back by the pause.

## Transient failures back off exponentially

When a PR's poll fails with a `transient` failure (a 5xx, a dropped connection, a timeout, or a default branch that `git ls-remote` could not read), the poller reads that PR again only after `transientBackoffMs(failures, pollIntervalMs)` (`@factory/domain`). That is the poll interval doubled for each failure in a row, at most 5 minutes (`GITHUB_BACKOFF_CAP_MS`), and never less than the interval. A successful poll resets the count. The count is per PR and in memory only, so a restart starts afresh. A `refused` failure keeps the earlier behavior: it is tried at the next poll. Transient failures don't touch the Job, its Stage Runs or the pause.

## Limitations

- The merger retries a transient failure at the poll interval, and the `pull_request` Stage keeps its own bounded retries (2 s, 5 s, 15 s, 40 s). Only the poller backs off exponentially, which is the loop Q23 names.
- The Job detail page's live refresh listens to the Job's own events only, so `github.paused` and `github.resumed` re-render the Job list but not an open Job detail page. A reload shows the current state.
- A response the gate gets after the pause is cleared, from a request already in flight, can start a new pause. That is GitHub's answer, and it is honored.
