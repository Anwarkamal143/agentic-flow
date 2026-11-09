# Product Specification

*What* the factory does. *How* is in `ARCHITECTURE.md`; *when* is in `ROADMAP.md`.

Every requirement is tagged:
- **[MVP]**: built in Phases A–C
- **[v1]**: built in Phases D–E
- **[Later]**: not built; leave an interface or extension point only

---

## 1. Vision

A human states an outcome ("Add password reset"). The factory works out the scope, asks only the questions it can't answer for itself, writes a testable spec and a task DAG, runs agents in parallel in isolated worktrees, verifies and reviews their work independently, and delivers PRs. Merge and deploy stay behind explicit policy. At every moment it can answer: **what is happening, why, who or what is responsible, what evidence exists, and what happens next.**

Non-goals for the first release: hosted multi-tenant SaaS, a visual workflow editor, deployment automation, and any harness other than Claude Code.

## 2. Principles

1. Persisted truth only. No UI simulation, no fake metrics.
2. Evidence-based completion. The factory re-verifies everything agents claim.
3. Human control over product decisions, permission expansion, merge, and deploy.
4. Deterministic orchestration around LLM proposals (ARCHITECTURE §3).
5. Recoverable after any crash, without duplicate execution.
6. Honest limits: mocked, partial, estimated and unenforced things are labeled as such.
7. Simple defaults. Advanced controls are reachable but not required.

## 3. Entities

| Entity | Definition | Tag |
|---|---|---|
| Project | A product or initiative; groups repositories and jobs | MVP |
| Repository | A git repo with a generated **profile** (commands, branches, sensitive paths) | MVP |
| Job | One requested outcome; runs a frozen workflow snapshot | MVP |
| Stage run | One execution of a workflow stage for a job | MVP |
| Task | A DAG node with a single repository scope and a Task Packet | MVP |
| Attempt | One try at a task (implementation or rework) | MVP |
| Artifact | An immutable stored output (spec, plan, log, review, report) | MVP |
| Evidence | A verdict on a criterion or gate, tied to `(head_sha, base_sha)` | MVP |
| Approval | A question or authorization request waiting for a human | MVP |
| Harness (agent) | An executable coding tool (Claude Code, Fake) | MVP |
| Role | A responsibility (developer, reviewer, …) mapped to a harness and model | MVP (fixed set) / v1 (configurable) |
| Recipe | A versioned workflow definition | MVP (built-in YAML) / v1 (custom) |
| Skill | Reusable instructions loaded per task | v1 |
| Pull request | A delivery unit per repo per job | MVP (Phase C) |
| Organization, User | Ownership and identity | v1 |
| Release / Deployment | A delivery to an environment | Later |

## 4. Lifecycle

Stages have **IDs**. A recipe picks a subset and their order.

| Stage ID | Purpose | Responsible | Output | Tag |
|---|---|---|---|---|
| `intake` | Normalize the request into a job | system | job record | MVP |
| `triage` | Validity, type, risk, repo scope; may **reject** | triage role (LLM) | triage artifact | MVP |
| `discovery` | Bounded inspection of the relevant repos | researcher | discovery report + file map | MVP |
| `specification` | Testable spec with `AC-xx` criteria | spec role | spec artifact + `acceptance_criteria` rows | MVP |
| `design` | Architecture fit, contracts, trade-offs (skipped for low risk) | architect | design artifact | v1 |
| `planning` | Task DAG with scopes, dependencies and verification commands | planner | plan artifact + tasks | MVP |
| `plan_approval` | Human approves, edits, rejects or replans (policy may skip it for low risk) | human | approval decision | MVP |
| `execution` | Schedule and run tasks: implement → verify → review per task | scheduler + roles | attempts, evidence, reviews | MVP |
| `integration` | Merge approved task branches into the job branch, then re-verify | integration role | integration evidence | MVP (Phase C) |
| `integration_review` | Fresh-session review of the whole integrated change against the full Specification. Catches problems between tasks. Skipped for single-task jobs where integration changed nothing. | reviewer | review artifact on the integration-branch SHA | MVP (Phase C) |
| `pull_request` | Push, open or update PRs, and track CI | system | PRs | MVP (Phase C) |
| `merge_approval` | The merge gate (policy or human) | human / policy | decision | MVP (Phase C) |
| `merge` | Perform the authorized merge | system | merge record | MVP (Phase C) |
| `deploy_*` | Deploy approval, deploy, production verification | release role / human | release record | Later |
| `closure` | Delivery report and tracker update | system | report artifact | MVP |
| `retrospective` | Proposed learnings, which need approval before reuse | observer | learnings (proposed) | v1 |

Documentation updates happen **inside execution** and ship in the PR, not after merge.

Routing rules:
- `triage` can end in `rejected` (the job record is kept).
- `plan_approval` can lead to approve, edit (back to `plan_approval`), replan (back to `planning`, capped by `max_replans`), or reject (`rejected`).
- Rework routes by `fault_origin` (ARCHITECTURE §4.6).
- A blocker resumes at `resume_stage_id`, never at the start of the job.
- Cancelling is possible from any non-terminal stage. It runs the cleanup list in §12.

### Built-in recipes

| Recipe | Stages | Tag |
|---|---|---|
| `feature` | intake, triage, discovery, specification, [design if risk ≥ medium], planning, plan_approval, execution, integration, integration_review, pull_request, merge_approval, merge, closure | MVP |
| `bug` | Same as feature. Specification must include **reproduction steps** and a failing **regression test** task that comes before the fix task. | MVP |
| `docs` | intake, triage, planning, execution, pull_request, merge_approval, merge, closure (no design, single task allowed) | v1 |
| `refactor`, `dependency_upgrade`, `security_fix`, `qa_existing` | variants | v1 |
| `incident`, `performance` | | Later |

## 5. Intake [MVP: dashboard + CLI; v1: GitHub Issues; Later: Linear, Jira, webhooks, schedules]

Fields: title (required), description (required), project (required, or inferred if there is only one), repositories (optional; triage proposes them), type, priority, acceptance criteria (optional), attachments (v1), and links.

**The clarification engine** sorts each open question into one of these categories:

| Category | Who answers | Example |
|---|---|---|
| Discoverable | The factory, through repo inspection. **Never ask the human.** | "Which test framework?" |
| Technical decision | The agent, recorded in an ADR | "Which hashing library?" |
| Product decision | The human | "Should reset links expire in 1 h or 24 h?" |
| Security / permission | The human, with approver rights | "Allow writes under `infra/`?" |
| Operational | An admin | "Increase the concurrency limit?" |

Questions are asked one at a time (or as one tightly related batch), each with options and a recommended default.

**The readiness score** [v1] is advisory only. The mandatory conditions for leaving `specification` are separate and checked in code: at least one mandatory AC, every task has a repo, and every mandatory AC is mapped to at least one verification approach.

**Duplicate detection** [v1] is advisory only and shown during triage.

## 6. Specification format [MVP]

Required sections: Problem, Objective, Scope, Out of scope, Functional requirements (`FR-xx`), Acceptance criteria (`AC-xx`, each marked mandatory or optional, each testable), Edge cases, Security considerations, Verification strategy (which AC is checked how), Definition of Done.

These sections are included only when relevant: data/migrations, API, UI/UX, performance, dependencies, risks.

## 7. Planning and tasks [MVP]

A good task is **one coherent engineering outcome in one repository**. Splitting work into tiny tasks just to raise parallelism is rejected by the plan validator: under 2 writable paths *and* fewer than 20 estimated changed lines raises a warning to merge the task with another.

Each task specifies: objective, repository, writable/forbidden globs, dependencies, mandatory ACs covered, verification commands, role, risk, and max attempts.

The **plan approval view** shows: the spec, the DAG, the affected repos, which tasks will run in parallel, the risks, any human decision points, and an estimate (task count and expected attempts; cost only if it can be computed). Allowed edits: remove, add or edit a task, change dependencies, change a task's repo, and change priority. Every edit is re-validated.

## 8. Execution, QA and review [MVP]

Per task: **implement → factory verification (commands + path gate) → independent review**. If anything fails, the work routes back by fault origin.

QA verdicts per acceptance criterion: `pass | fail | blocked | not_tested | not_applicable (+ justification)`. **A task can't be `approved` while any mandatory AC is `fail`, `blocked` or `not_tested`.**

Review covers two axes: (A) engineering standards and (B) spec compliance. Findings have a severity of critical, high, medium, low or info. Critical and high findings block by default.

The developer contract (it goes into the prompt template and is enforced where possible):
- Stay within scope. Request a scope change through `scope_change_request` instead of editing outside it.
- Never remove tests, loosen types, or disable checks to get green results.
- Never claim results it didn't produce. The factory re-runs everything anyway.

## 9. Merge and deploy policy [MVP merge; Later deploy]

Merge policies per repo: `never_auto` (default), `human_approval`, `auto_if_low_risk_and_green`. Job overrides can only make a policy stricter.

- `never_auto`: the factory never merges. A human merges on GitHub, and polling detects it.
- `human_approval`: the factory merges after an Inbox Approval.

While it waits on either, the Job is `waiting_human` with a human-kind Blocker. A PR closed without merging opens an Inbox Question and never auto-cancels the Job.

The merge gate requires all of these: the correct repo, base and head; the reviewed SHA equals the PR head; required CI checks are green; there are no blocking review findings or unresolved "changes requested" reviews; there are no conflicts; branch protection is satisfied; and an approval, if policy requires one.

Deploy is a separate lifecycle and never implied by a merge [Later]. The factory never invents a rollback. If no supported rollback exists, it reports the failure and asks a human.

## 10. Human approval inbox [MVP]

One inbox. Each item shows: job, project, repo, stage, requesting actor, the question or action, why it's needed, the options, the recommended option, the risks, the evidence links, and its expiry behavior. Actions: approve, reject, request changes, answer, defer, and cancel the job. Escalation is v1.

Approvals pause the work durably (no agent process stays alive). They never auto-approve.

## 11. Dashboard [MVP pages first]

| Page | Tag | Must answer |
|---|---|---|
| Jobs list + board (columns = stages) | MVP | What exists and where is each job? |
| Job detail: overview, timeline (events), spec, plan/DAG, tasks + attempts, evidence matrix, reviews, PRs, artifacts/logs | MVP | What's done, running, waiting or blocked, and what happens next? |
| Inbox | MVP | What needs me? |
| Live activity (running attempts with harness, model, repo, tier, heartbeat, tail of the log) | MVP | What's running right now? |
| Projects and repositories (with profiles) | MVP | What's registered and is it ready? |
| System health (runtime, scheduler, harness detection, GitHub connectivity, disk) | MVP | Is the factory OK? |
| Effective configuration viewer (value + source level) | v1 | Why is this setting what it is? |
| Analytics: cycle time, first-pass approval rate, attempts per task, usage | v1 | How well is it working? |
| Cost and budgets | v1 | What are we spending? |
| Workflow designer, calendar, saved views | Later | |

UI standards: light and dark themes, keyboard navigation, accessible controls, empty/loading/error states on every page, and live updates through SSE with replay after a refresh. **Mocked or unavailable data is labeled visibly** (for example "cost: unknown (subscription)").

Agent analytics never rank agents on raw counts. They show sample size and mark low-sample results as insufficient data.

## 12. Cancellation and cleanup [MVP]

Cancelling a job: stop the running attempts (graceful, then forced), release the leases, set the worktrees to `preserved`, and mark open approvals `cancelled`. **Then ask the human** about each external side effect: close the PRs? delete the remote branches? Never delete local unreviewed work automatically.

## 13. Onboarding [v1; MVP = `factory init` + `factory doctor`]

MVP: `factory init` creates `~/.factory`, generates the token, detects Node, git, gh and Claude Code (presence and version only; auth status only where it can be detected safely), and asks for the workspace root. `factory doctor` re-runs the checks with actionable fixes. `factory repo add <path|url>` creates the factory's own clone (your checkout is never modified; ADR-0001), generates a repository profile, and **asks for confirmation of any detected commands** before saving them.

v1: a dashboard wizard with steps for basics, harnesses, GitHub, first project and repo, policy preset (Manual / **Assisted (default)** / Controlled autonomy / Advanced), concurrency, and verification. It supports save and resume. Onboarding can't finish while mandatory checks fail.

Repository profiles **never modify** existing `CLAUDE.md` or `AGENTS.md`. The factory's own instructions are injected into the Task Packet at runtime and are not written into the repo.

## 14. Skills [v1]

Skills are versioned folders containing `SKILL.md` with frontmatter: name, version, triggers, roles, compatible harnesses, and whether it is interactive. They are selected per task by job type, task role, detected tech and risk. Only the selected skills load. **Interactive skills are never loaded into unattended runs.** Every skill ships at least one eval case (see §16).

## 15. Knowledge and learnings [v1]

Context sources: the repo profile, existing instruction files, specs and ADRs from earlier jobs, and **approved** learnings. Retrospective learnings are *proposed* and only become retrievable after a human approves them. This protects against poisoning from injected issue or PR text. Every context item injected into a packet is listed, which keeps it traceable.

## 16. Factory quality evaluation [v1]

A benchmark suite of 10–20 small tasks on the fixture repos, with known-good acceptance tests. `pnpm eval` runs it with the real harness and reports the pass rate, attempts per task, review-finding counts, duration and usage. Run it whenever prompt templates, skills or routing rules change, and compare against the stored baseline. A regression of more than 10% in pass rate blocks the change.

## 17. Budgets and usage [MVP record; v1 enforce]

Budget scopes: project, job, and harness account. Policies: warn, soft limit (pause new dispatch), hard limit (pause, and cancel only when that is explicitly configured). Continuing past a limit needs human authorization. Subscription usage windows count as capacity, not budget (ARCHITECTURE §13).

## 18. Integrations

| Integration | Tag |
|---|---|
| Claude Code harness | MVP |
| GitHub (polling: PRs, checks, reviews, comments) | MVP (Phase C) |
| GitHub Issues intake | v1 |
| Codex / OpenCode / Gemini CLI harnesses | Later (adapter only) |
| Linear, Jira, Slack, email, webhooks | Later |
| GitLab / Bitbucket | Later |
| Container execution tier (Docker) | v1 |
| Postgres, remote runners | Later |
