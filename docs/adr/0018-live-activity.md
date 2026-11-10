# Live activity, and the tail-only polling exception (Phase B, issue #49)

Choices made while building the live activity page and `factory activity` (PRODUCT_SPEC §11: "What's running right now?"). All are routine and reversible.

## What "running" means and what is shown

- **A running Attempt is one in `running`, `verifying` or `in_review`**: a developer Harness Run, a verification command or a reviewer Harness Run may be in progress. `GET /v1/activity` lists them oldest first (`ActivitySchema` in `@factory/domain`, new `activity.ts`), each with its Job, Task, Harness (id and version as recorded), model, Repository, tier, start time, heartbeat and port block, plus `at`, when the runtime answered.
- **The tier** is the recorded `attempts.tier` with its label and detail from `SECURITY_TIER_LABELS` (ADR-0014), sent by the API (`tierLabel`, `tierDetail`) so every client words it the same. It is a guardrail, never called a sandbox.
- **The model is always `null` for now, shown as "unknown (not reported by the Harness)"** (`MODEL_UNKNOWN_LABEL`). No Harness reports its model while it runs, and no column records one. Claude Code names its model in its stream-json `init` event; recording it needs a schema change (the `db` owner's) and is left for later. The configured `harness.model` is not shown in its place: it is a request, not a report.
- **The heartbeat is the Task lease's `heartbeat_at`** (renewed every 15 s by the runtime holding it, ADR-0012), with its age in ms as of the answer. `null` when the Task holds no lease.
- **The port block is the Worktree's `port_base`** and the block size (`PORT_BLOCK_SIZE`, 10), so `base` to `base + 9`.

## The tail: read from the spool, redacted at the API

- **`GET /v1/attempts/:id/tail`** reads the last 256 KiB of `output` in the spool of the process the Attempt records (`attempts.process_json`, ADR-0012), redacts it with the runtime's redactor (ADR-0011), and keeps the last 200 lines (`TAIL_LINES`, the pure `tailLines`). It answers `{attemptId, running, process: {kind, label} | null, lines, truncated, heartbeat}`; `label` is the spool's name (`developer-1`, `reviewer-1`, `verify-<key>`). An unknown Attempt is a 404. An ended Attempt has `running: false` and no lines: its spool is gone, and its output is in its `log` Artifacts (`factory logs`).
- **The spool holds raw output, so the tail is the one read path that redacts on the way out** instead of on the way in. The chunk is redacted whole before it is cut into lines. When the chunk was cut from the middle of the output its first line is partial and is dropped, so a secret cut by the 256 KiB boundary is not shown in part. The redaction scenario's limits still hold: a secret the factory doesn't know of and that matches no pattern is shown.
- **Claude Code's spool is stream-json**, so its tail shows JSON lines, as written. A friendlier rendering is not built.

## `factory activity`

- `factory activity [--lines <n>] [--json]`: one block per running Attempt (Job, Task, Attempt, state, Repository, Harness, model, tier label and detail, heartbeat age, ports, start), then the last `n` (default 20) redacted tail lines. `--json` prints the activity with each Attempt's whole tail. With nothing running it says "Nothing is running."

## The dashboard page: SSE for state, polling for the tail only

- **`/activity`** (linked from the header) renders the running Attempts and each one's tail on the server, so the page is complete without scripts. Its state is kept live as every other page's (ADR-0014): an event triggers `router.refresh()`, so an Attempt that starts or ends appears or goes.
- **The tail is polled every 5 s** (`LiveTail`, through the dashboard's `GET /api/attempts/[id]/tail`, a pass-through that keeps the token on the server, checks the id and is GET only). **This is a deliberate exception to ADR-0014's "nothing polls"**, limited to the tail: process output is not an event (Harness progress events are counted, not stored, ADR-0011), so the event stream can't carry it, and streaming it would need a second, per-process stream for a view that is fine 5 s late. The heartbeat age comes with each tail, for the same reason: lease renewals are not events. Nothing else on the page polls. A failed poll says so on the page and the next one tries again.
- The page has the empty, unavailable-runtime and ended-Attempt states, and no write action.

## Not built

- The model of a running Attempt (see above). The tail of a proposal Stage's Harness Run (proposal Runs are not Attempts; their output is in their Artifacts). Rendering Claude Code's stream-json readably. Following a tail live between polls.
