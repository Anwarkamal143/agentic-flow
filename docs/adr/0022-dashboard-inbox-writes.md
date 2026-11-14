# The dashboard Inbox, its write path, and the plan view (Phase B, issue #37)

**Status:** accepted (#37, Phase B). **Supersedes ADR-0014's "Read-only" bullet**; the rest of ADR-0014 stands. The design is ARCHITECTURE §1 ("Dashboard writes"), PRODUCT_SPEC §7 and §10; the choices below are routine and reversible.

## The Inbox is the only write path

- **Every page but the Inbox stays without write controls.** The job list, the job detail (with its plan view), live activity and the Artifact page have no form, button, input or Server Action. The read-only scenario's "no write action" assertion is narrowed to those pages, not deleted. Job changes other than a decision (cancel, Plan Edit) still go through the CLI.
- **Plain HTML forms posting to a route handler**, `POST /api/inbox/[id]/[action]` with `action` one of `decide | defer | undefer`, `application/x-www-form-urlencoded`. Not Server Actions: a route handler has one obvious URL and body, so the Host, Origin and version checks are tested over HTTP exactly as a browser sends them, and the forms work without scripts.
- **Server-side, as `user:local`.** The handler calls the runtime's `POST /v1/inbox/:id/{decide,defer,undefer}` with the token read from the factory home (`changeInboxItem` in `src/lib/runtime.ts`). The token stands for `user:local` only (ADR-0016), so that is the actor. Neither the token nor the runtime's URL appears in any page.
- **One decide path for every kind.** A plan item is decided through `/v1/inbox/:id/decide` with its option (`approve`, `reject`) and its subject (the plan Artifact id), the same rule as `approvePlan`/`rejectPlan`. The form is built from the item's `options`, so a kind added later (question, blocker, spec change, cleanup) renders and posts without dashboard changes. Until its runtime handler exists, the runtime refuses it `not_decidable`, and the dashboard shows that refusal.

## Checks on every mutation

In this order, before the runtime is called:

1. **`Host` is loopback** (`127.0.0.1`, `localhost`, `[::1]`, any port). The proxy already refuses any other Host for every request (ADR-0014); the route checks again (`forbidden_host`, 403).
2. **`Origin` is the dashboard's own: exactly `http://<Host>`.** A missing Origin, `null`, another site, or another local port is refused (`forbidden_origin`, 403). Browsers send Origin on every form POST, so requiring it costs nothing and stops a cross-site form (the token is server-side, so CSRF is the risk, not token theft).
3. **The form is well formed** (zod): `expectedVersion` (a non-negative integer), and to decide `subjectRef` and `option` (a `comment` is optional; an empty one is left out). Anything else is 400. An id outside `[A-Za-z0-9_-]` or an unknown action is 404. Only POST is served (405 otherwise).

The version and the subject come from hidden inputs holding what the page was rendered with, so the runtime's own rule (`checkInboxChange`, ADR-0016) refuses a stale decision. The dashboard adds no rule of its own.

## Answers

- **Success is a 303** to a `return` path the form names (`/inbox`, `/inbox?all=true` or `/inbox/<id>`, checked against that pattern; otherwise `/inbox/<id>`), which renders the persisted result.
- **A refusal is the runtime's status (409, 400, 403, 404) with a small self-contained HTML page**: the runtime's message as it is (escaped), "Nothing was changed", and a link back to the item. Not a redirect carrying the message in the URL: a link could then show any text on the dashboard. A runtime that can't be reached gives 503 with its reason.

## Pages

- **`/inbox`**: the open, not deferred items (`GET /v1/inbox`); `?all=true` shows every item (deferred, decided, cancelled). Empty state: "Nothing needs you right now." **`/inbox/[id]`**: one item; a `plan` item shows the read-only Plan under it, with a warning when the item's subject is not the Job's newest Plan.
- **Each item shows PRODUCT_SPEC §10's list:** Job (linked), Project and Repository (names from `GET /v1/projects` and `/v1/repositories`, with their ids), Stage and Task, the requesting actor, the question, why, the options with their descriptions (an agent-proposed one is labelled "proposed by an agent"), the recommended option (or "none"), the risks, the Evidence links, the expiry behaviour (`remain_pending`: "Stays pending until a human decides; never auto-approved") and the version. Open items carry the decide form (a button per option, an optional comment) and Defer or Undefer.
- **Risks:** an `Approval` has no risk field. A `plan` item's risks are its Plan's, from `GET /v1/jobs/:id/plan` (the triage risk and every Task's). Any other kind shows "None recorded for this item" until its ticket gives the item risks.
- **Evidence links** go to the new read-only **`/artifacts/[id]`**: the Artifact's record (kind, schema version, content hash, creation) and its stored content as JSON (redacted when stored, ADR-0011).
- **The plan view** is a section of the Job detail (`#plan`), read-only, from `GET /v1/jobs/:id/plan`: the Plan Artifact; where its approval stands (a link to the open item in the Inbox, the decision made, or "not held for a human" under `planApproval: skip`); the Specification (rendered when it parses as `SpecificationProposalSchema`, otherwise shown as stored, labelled); each Task with its objective, Repository, state, risk, dependencies, covered criteria, caps and writable paths; the affected Repositories; the parallel waves; the risks; the human decision points; and the estimate with its label ("bounds, not a forecast") and "Cost unknown: <reason>". A Job without a Plan (`no_plan`) says "No Plan yet".
- **Live:** the Inbox pages use `LiveRefresh`, so an event (for example `approval.decided` from the CLI) re-renders them from the API (ADR-0014).

## Not built

- Replan-with-feedback (the Plan Edit ticket, #38), and "cancel the Job" from the Inbox (PRODUCT_SPEC §10 lists it; the CLI cancels).
- Task priority in the plan view: the plan view API doesn't return it.
- A visual DAG: dependencies are listed per Task, with the parallel waves.
- The client-side code (live refresh, focus after an action) is not exercised in a real browser by a test; the scenarios read the server-rendered HTML and post forms over HTTP.
