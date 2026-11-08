# Software Factory

A local-first platform that takes a requested software outcome, plans it into dependent units of work, has AI coding tools carry them out in isolation, verifies the results independently, and delivers them as pull requests under human-controlled policy.

## Language

### Ownership

**Project**:
A product or initiative that owns Repositories and Jobs. It is the boundary for policy and fair sharing of capacity.
_Avoid_: Workspace, product

**Repository**:
A git repository registered with the factory. It belongs to exactly one Project.
_Avoid_: Repo (fine in casual speech), codebase

**Factory Clone**:
The factory's own copy of a Repository, from which every Worktree is made. The owner's own checkout is never written to.
_Avoid_: Mirror, local repo, checkout

### Work

**Job**:
One requested outcome, belonging to one Project. It may touch only that Project's Repositories.
_Avoid_: Ticket, issue, request, work item

**Recipe**:
A versioned, reusable definition of which Stages a kind of Job goes through and in what order.
_Avoid_: Template, pipeline

**Workflow Snapshot**:
The frozen copy of a Recipe attached to a Job when the Job is created. Later edits to the Recipe never change it.
_Avoid_: Workflow (on its own), pipeline instance

**Stage**:
A named step in a Recipe, such as triage, specification, planning or execution.
_Avoid_: Phase (reserved for the factory's own build roadmap), step

**Stage Run**:
One execution of a Stage for a particular Job.
_Avoid_: Stage execution

**Specification**:
The Artifact that states a Job's intended outcome, its scope, and its Acceptance Criteria. It is finished only when every mandatory criterion has a way of being verified.
_Avoid_: Requirements doc, PRD, story

**Acceptance Criterion**:
One numbered, testable condition in a Specification, either mandatory or optional. A Task can't be approved while a mandatory criterion it covers has no Evidence, or has Evidence of fail, blocked or not tested.
_Avoid_: Test case, Definition of Done item, requirement

**Task**:
A unit of work within a Job's plan. Its scope is one Repository, and it can depend on other Tasks.
_Avoid_: Subtask, ticket, step

**Plan**:
The Task graph for a Job, together with each Task's scope and dependencies. Once approved it never changes; replanning produces a new Plan, and Tasks already approved carry over.
_Avoid_: Roadmap, breakdown, schedule

**Attempt**:
One try at a Task: implementing it, the factory's own verification, and independent review. A Retry, a Rework, or resuming after a human answer always starts a new Attempt.
_Avoid_: Execution, try, iteration

**Retry**:
A new Attempt started because the previous one was cut short by an infrastructure failure, such as a crash or a timeout, rather than by a verdict on the work. It carries no Findings and doesn't count against the Rework limit.
_Avoid_: Rework, rerun

**Rework**:
A new Attempt started because a Gate failed or a review produced blocking Findings. It carries those Findings forward and counts against the Task's attempt limit.
_Avoid_: Retry, fix-up, iteration

**Blocker**:
A recorded reason why work cannot proceed, with a kind (human, infrastructure, recovery or policy) and the action that would clear it. A Task waiting on unfinished dependencies is not blocked; it is pending.
_Avoid_: Impediment, hold, wait

### Harnesses

**Harness**:
An executable AI coding tool the factory drives, such as Claude Code or the scripted Fake.
_Avoid_: Agent, bot, provider

**Model**:
The underlying AI model a Harness is configured to use.
_Avoid_: Engine, provider

**Role**:
A responsibility a Harness is asked to carry out, such as Developer, Reviewer or Planner.
_Avoid_: Agent, persona

**Harness Run**:
Exactly one invocation of a Harness in one Role, in any Stage.
_Avoid_: Run (on its own), execution, agent run

**Session**:
A Harness's own conversation, which may continue across several Harness Runs.
_Avoid_: Conversation, thread

**Harness Account**:
One set of credentials a Harness runs under. Usage, capacity and budgets are tracked per Harness Account.
_Avoid_: Login, subscription, key

**Usage Window**:
The period during which a subscription-mode Harness Account is paused after the Harness reported a usage limit. New work for that account waits until it resets, and this is never a failure.
_Avoid_: Quota, rate limit (on its own), allowance

**Worktree**:
The isolated checkout of a Repository where exactly one Task is carried out.
_Avoid_: Workspace, sandbox, environment

**Security Tier**:
How strongly a Harness Run is contained, either as a local guardrail or in an isolated container. A guardrail is never called a sandbox.
_Avoid_: Sandbox (for the guardrail tier), environment

### Verification

**Gate**:
A named, deterministic pass/fail check that must pass before work can advance.
_Avoid_: Check (on its own), quality bar

**Evidence**:
The recorded verdict of a Gate or an acceptance criterion, valid only for the exact code version it was produced against.
_Avoid_: Gate result, proof, test result

**Review**:
An independent judgement of one Task's change by a reviewer Harness Run in a fresh Session, which sees only the Review Packet. It approves the change or requests changes, carries Findings and a verdict per acceptance criterion, and is valid only for the `(head_sha, base_sha)` it reviewed. It is a Gate, stored once and never regenerated.
_Avoid_: Code review (on its own), QA, check

**Review Packet**:
What a reviewer is sent: the specification, the acceptance criteria the Task covers, the diff of the Task Branch, and the factory's own Evidence. Never the implementer's transcript or its claims.
_Avoid_: Review context, review prompt

**Finding**:
A problem raised by a review, with a severity, a Fault Origin, a location and a recommended correction. It may be blocking. Verdicts on acceptance criteria are Evidence, not Findings.
_Avoid_: Issue, comment, defect

**Fault Origin**:
Where a Finding's root cause lies: in the implementation, the Plan, the specification, or the infrastructure (the setup, tooling or machine broke). It decides where Rework goes.
_Avoid_: Root cause, category

**Artifact**:
An immutable stored output, such as a specification, plan, log, review or report.
_Avoid_: File, attachment, output

### Delivery

**Task Branch**:
The branch a single Task's work is committed to, inside its Worktree.
_Avoid_: Feature branch, work branch

**Integration Branch**:
The per-Job, per-Repository branch where a Job's approved Task Branches are combined before delivery.
_Avoid_: Job branch, release branch

**Integration Review**:
An independent review of a Job's combined change against its whole Specification, done after Task Branches are integrated and before delivery. It catches problems that no single Task's review can see.
_Avoid_: Final review, job review

**Delivery**:
Putting a Job's result in front of its owner: as pull requests, or before pull requests exist, as the local Task Branch plus a Delivery Report. Delivery is not deployment.
_Avoid_: Release, deployment, shipping

**Delivery Report**:
The closing Artifact of a Job, summarising what was delivered, the Evidence for it, and known limitations.
_Avoid_: Summary, completion report

### Configuration

**Policy**:
A rule that limits what the factory may do on its own, such as when it may merge, which paths may change, or which actions need an Approval.
_Avoid_: Setting, rule set, permission

**Immutable Invariant**:
A safety rule that no level of configuration can loosen. Lower levels may only narrow permissions, never widen them.
_Avoid_: Safety invariant, hard rule, default

**Effective Configuration**:
The settings that result for one Job once every configuration level is resolved, frozen when the Job is created. Unlike the Workflow Snapshot, a human may deliberately re-freeze it.
_Avoid_: Config (on its own), merged settings

### Human decisions

**Inbox Item**:
Anything waiting on a human. It is either a Question or an Approval.
_Avoid_: Notification, ticket, request

**Question**:
An Inbox Item asking for information the factory lacks. It is answered with content.
_Avoid_: Clarification request, prompt

**Approval**:
An Inbox Item asking for authorization of a protected action, such as accepting a plan, merging or expanding scope. It is decided as approve, reject or request changes.
_Avoid_: Sign-off, permission request
