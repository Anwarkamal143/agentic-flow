# Refuse free shell verification, the contract step (Phase D, #104)

**Status:** accepted (Phase D, #104; the contract step after ADR-0062's expand and ADR-0063's test migration; implements the last part of ADR-0051 and closes spec issue 44). The choices below are routine and reversible.

## Context

ADR-0062 let a verification entry's `command` name a Repository Profile command and still ran any other string as free shell. ADR-0063 moved the tests and the Fake Harness script to names. What is left is to make a non-name a Plan error, and to tell the planner and the developer.

## Decision

- **A new rule, `plan.verification_command`.** `validatePlan` reports an entry whose `command` is not a name of the Task's Repository's frozen profile commands, with or without arguments, naming the Repository's commands (or "it has none"). It replaces the "is not a profile command" case of `plan.verification_args`, so such an entry gets one issue, not two; `plan.verification_args` keeps the `acceptsArgs` and pattern checks. The planner gets the usual one re-prompt, and a Plan Edit's error goes back to the human.
- **A Plan accepted before #104 still runs as written.** A stored Plan is never re-validated or regenerated on replay or recovery (CLAUDE.md §2), so `resolveVerification` keeps running a non-name entry as free shell, with no arguments, and its Evidence keeps `profileCommand: null`. Only such a Plan can still reach it.
- **The planner prompt, `proposal-stage@6`,** says a verification command must be the name of a profile command, never a shell command, and that any other makes the Plan invalid; the planning ask says "the Repository Profile commands that verify it". The template hash now covers the template, every Stage's ask and the planner's profile rules, since the last two were outside the hashed text and a change to them left the hash unchanged.
- **Task Packet v3, template `task-packet@8`.** The packet's shape is unchanged; v3 marks that every entry's `command` is a profile command (free shell only in a Plan accepted before #104, its `run` the same string). The template says each entry names a human-confirmed profile command whose `run` the factory itself runs. Packets stored as version 1 or 2 still parse.

## Consequences

- Unit `plan-validation`'s free-shell cases are now refusals (free shell, a Repository with no commands, a non-name with arguments); its default Plan verifies with a `pass` profile command. Scenario `verification-commands` shows the re-prompt of a Plan verifying with `npm install && npm test`, the corrected Plan's runs all naming profile commands, and `proposal-stage@6` on both planning Runs; its first scenario's free-shell entry became `math-exists`.
- PRODUCT_SPEC §7 and ARCHITECTURE §7 (packet version, step 4) describe the refusal.
