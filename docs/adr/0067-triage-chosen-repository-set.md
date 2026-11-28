# A triage-chosen Repository set

**Status:** accepted (Phase D, #107; builds the "Repository set" part of ADR-0052). Supersedes ADR-0055's `409 repository_required` for a Project with several Repositories. The choices below are routine and reversible; one (confirming the set by approving the Plan) is flagged for human review.

## Context

ADR-0052 decided that `job create` names zero or more Repositories: a named set can't be changed by triage; with none, triage proposes the set from the Project's Repositories, and a proposed set of more than one waits for a human even under `planApproval: skip`. Until now, `POST /v1/jobs` with no Repository in a Project with several was refused (`repository_required`, ADR-0055). ARCHITECTURE (Effective Configuration) already freezes a section for every Repository of the Project at creation, so a set chosen later still runs under values frozen at creation.

## Decision

- **Who chose the set.** `jobs.repository_set_by` (migration 0034, default `operator`) is `operator` (named at creation, or the Project's only one) or `triage`. The Job API returns it as `repositorySetBy`; `job.created` carries it. A Job created with no Repository in a Project with several is `triage` and has no `job_repositories` rows until triage succeeds; `repositories` is then `[]` (the only case it may be empty).
- **Candidates.** Triage of a `triage` Job with no Repository yet chooses from the Project's Repositories that have a section in the Job's frozen Effective Configuration, by name. A Repository added to the Project after creation is not a candidate. The Merge Policy override at creation is checked against every candidate. The triage prompt lists them as "(none chosen yet) the Project's: …" with a short instruction (template `proposal-stage@7`); the Harness runs in the first candidate's Factory Clone (read-only).
- **Proposal and validation.** `TriageProposal` gains optional `repositories` (names). The pure `validateTriage` (rule `triage.repositories`) requires it when the set is triage's to choose, and every name must be a candidate, each listed once. An invalid set is re-prompted like any invalid proposal (one re-prompt, then `invalid_output`). When the set is fixed (named, or already chosen), the field is ignored and never applied: **a named set is never changed**.
- **Applying.** The valid proposal's set is written to `job_repositories` with a `job.repositories_chosen` event (ids, names, triage Artifact id) in the same transaction that stores the triage Artifact. It is written once; recovery and replay never re-run triage for it.
- **Confirmation.** Entering `plan_approval` waits for a human whatever the policy while the set is triage-chosen, has more than one Repository, and no `plan` item of the Job has been decided `approve` (pure `repositorySetNeedsConfirmation`). The `plan` item's question and why name the set and say it waits even under `planApproval: skip`; `plan show` and the dashboard mark the set "chosen by triage", and the derived decision points list `plan_approval`. *(flagged for review)* Approving the Plan confirms the set; there is no separate confirmation item. To change the set, the human rejects and creates the Job again with `--repo`. Once a Plan of the Job is approved, a later replan under `skip` is skipped as usual. A triage-chosen set of one Repository follows the policy.
- **Display.** `job create` prints "triage will choose its Repositories from the Project's"; `job list`/`job show` and the dashboard say "to be chosen by triage" before triage and "chosen by triage" after.

## Consequences

- A Project with several Repositories no longer needs `--repo` on `job create`.
- The CLI and API offer no way to edit a triage-chosen set in place; the alternative (a dedicated `repository_set` Approval with an "edit" answer) would need a new Approval kind and is left for a later ticket if wanted.
- Tests: unit `triage-repository-set` (validation, set ordering, confirmation rule, decision points) and the scenario `triage-repository-set` (3: a set of two waits under `skip` and completes after approval; another Project's or a repeated name is re-prompted and a set of one skips plan approval; a named set ignores triage's proposal).
