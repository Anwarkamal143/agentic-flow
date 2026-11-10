# The read-only dashboard (Phase A, issue #15)

Choices made while building `apps/dashboard`: the job list and the job detail page (ROADMAP Phase A, PRODUCT_SPEC §11). All are routine and reversible.

## Stack and build

- **Next.js 16.4 (App Router, Turbopack), React 19.3, Tailwind CSS 4.3, shadcn/ui.** The shadcn/ui primitives used (`Badge`, `Card`, `Table`) are copied into `src/components/ui/`, the way shadcn/ui is meant to be used, with its design tokens in `globals.css` (light and dark from `prefers-color-scheme`). There is no shadcn CLI config: three components don't need one.
- **The dashboard is not part of `tsc -b`.** Next needs `moduleResolution: Bundler` and JSX, so it has its own non-composite `tsconfig.json`. `pnpm build` runs `tsc -b`, then `next build`. `pnpm typecheck` runs `next typegen && tsc --noEmit` for it. `next-env.d.ts` points into `.next/`, so it is generated (gitignored), not source. `turbopack.root` is the monorepo root, so the workspace packages resolve. `agentRules: false` stops Next from writing an `AGENTS.md` into the app.
- **`pnpm dev`** (`scripts/dev.mjs`) runs `factory start`, then `next dev` on `127.0.0.1:${FACTORY_DASHBOARD_PORT:-7421}`. If a runtime is already running, it uses that one and leaves it running. If it started the runtime, it stops it on exit.

## Only through the runtime API, with the token kept on the server

- **Every read goes through the runtime HTTP API** (`src/lib/runtime.ts`), from server components and one route handler. The dashboard never opens the database (CLAUDE.md "One writer"). ARCHITECTURE §1 allows it to open the database read-only for heavy queries, but none is heavy yet.
- **The token never reaches the browser.** The server reads it, with the runtime record, from the factory home (`FACTORY_HOME`, through `@factory/home`), on every request. If the runtime is not running, the page says so and says how to start it.
- **Responses are parsed against the `@factory/domain` schemas**, so the pages show only persisted data the contract describes. A drifted runtime fails loudly instead of rendering guesses.
- **Read-only:** only GET requests to the runtime; no forms, buttons, inputs or Server Actions; the stream route answers GET only (405 otherwise). Changes go through the CLI. *Superseded by ADR-0022 (#37): the Inbox is now the one write path; every other page stays without write controls.*

## Live updates: SSE as a signal, the API as the truth

- **`GET /api/events/stream`** passes the runtime's `GET /v1/events/stream` through (`job`, `after`, `Last-Event-ID`; parameters are checked as ids and integers). It writes an SSE comment first, because Next sends the response head only with the first body chunk. Without it, a stream with nothing to replay would never open.
- **An event triggers `router.refresh()`** (coalesced over 250 ms), which re-renders the server components from the API. The event is only the signal, so every value shown is persisted state, never one rebuilt from event payloads. Nothing polls. When the stream opens or reopens it also refreshes once, which covers anything persisted between the render and the subscription.
- **The timeline** starts from the Job's events the page was rendered with (read page by page, 1000 at a time). It streams from the last of them (`after=<seq>`); `EventSource` then resumes by `Last-Event-ID` on its own. The rendered events and the streamed ones are merged by `seq` with the pure `mergeEventLog` (`@factory/domain/event-log`, a subpath with no imports, so the browser bundle doesn't take zod). A re-delivered `seq` is dropped and the first copy kept. A reload renders the persisted log again and streams after its end, so no event is missing or shown twice.
- **When EventSource gives up** (a non-200 answer, such as the 503 while the runtime is down, closes it for good), the page opens a new stream after a backoff (1 s, doubling, at most 30 s), starting after the last `seq` it saw. Meanwhile the badge says `disconnected`, never `reconnecting`. Closing the browser's stream aborts the upstream request (`request.signal`), so no runtime subscription outlives its tab (checked by hand: open sockets to the runtime went from 6 to 0 as 3 clients left).
- **Each refresh re-reads the Job's whole event log.** That is acceptable because the log holds state changes only (Harness progress events are counted, not stored, ADR-0011). A long-lived Job with many events would want the timeline to read only what is new.

## Honest labels

- **Attempts record their security tier** (`attempts.tier`, `SecurityTier = 'local'`, migration 0008, default `local`: every earlier Attempt ran under Tier 0). The UI shows the recorded value, not an assumption, and the column gives Tier 1 (Phase E) its place. The wording is defined once, `SECURITY_TIER_LABELS` in `@factory/domain`: "Tier 0 · local guardrail" and "Guardrails only: the Harness runs as your user, without isolation." The dashboard and `factory job show` both use it. The word "sandbox" appears nowhere.
- **Usage that wasn't recorded or reported says so:** tokens "unknown (not reported by the Harness)", cost "unknown (subscription)" for `unknown/subscription`, "unknown" for an unknown cost, an estimate with its tag, and "unknown (not recorded)" without usage.
- **A review whose `(head, base)` differs from its Attempt's is marked stale.**

## Local-only

- **The dashboard listens on 127.0.0.1**, and `src/proxy.ts` refuses (403) any request whose `Host` isn't a loopback name. Without that check, a site whose name resolves to 127.0.0.1 (DNS rebinding) could read the factory's state through the dashboard, which holds the token. There is no dashboard login: a local process that can reach the port could reach the runtime's files too (single local user, CLAUDE.md §7 answer 1).

## Not built (Phase A scope)

- Only the job list and the job detail exist (no board, Inbox, live activity, projects, health). The job detail doesn't show the Specification or Plan Artifacts' content, the DAG, worktrees or logs (`factory logs`). The status line has no runtime health. A `loading.tsx` is left out on purpose: a streamed response sends its 200 before a missing Job's 404 is known.
