# Verification by profile command name, the expand step (Phase D, #102)

**Status:** accepted (Phase D, #102; implements the verification part of ADR-0051 as an expand step: #103 migrates the tests and the Fake script, #104 refuses free shell). The choices below are routine and reversible.

## Context

ADR-0051 decides that a Task's verification entries name commands of the confirmed Repository Profile, that arguments are allowed only on commands marked `acceptsArgs` and must match `^[A-Za-z0-9._/:=@+,-]+$`, and that names resolve from the Job's frozen per-Repository section (ADR-0060). #102 adds this without refusing free shell yet. It also bumps the planner prompt and the Task Packet, so it carries two gaps no other ticket owns: instruction files given to agents as context (PRODUCT_SPEC story 37), and the planner being told the Sensitive Paths and command names.

## Decision

- **One `command` field, no new discriminator.** An entry is `{key, command, args?, required, criteria}`. When `command` is a name of the Job's frozen commands for the Task's Repository, it is that profile command; otherwise it is free shell, run as written. A free shell string that happens to equal a profile command name (`test`) runs the profile command. #104 turns "not a name" into a Plan error, so no field has to be migrated.
- **`plan.verification_args`** (in `validatePlan`, against `PlanContext.commands`): arguments on a command that is not a profile command of the Task's Repository, on a profile command without `acceptsArgs`, or an argument outside the pattern. The schema itself only caps the list (20 arguments, 200 characters each), so a bad argument is a rule issue the re-prompt carries, not a schema failure.
- **Resolution is one pure function, `resolveVerification`.** The run is the command's `run` followed by each argument single-quoted (`'arg'`, a `'` written as `'\''`), joined by spaces. The pattern already leaves no shell metacharacter; quoting is the second guard. The runtime resolves from the frozen section at packet time and again at verification time (the same frozen input, so the same result). A Job from before Phase D, which froze no section, uses the current profile (ADR-0060).
- **Evidence names the command.** `verification_runs` gains `command_name` and `command_args_json` (null for free shell); `command` stays the shell that ran. The API's verification runs carry `profileCommand: {name, args} | null`, the verification log carries it too, `job show` prints `profile command <name> <args>` on the Evidence line and the arguments on the `verify:` line, and the dashboard shows it above the shell command.
- **The Integration Task** runs a command shared by several Plan Tasks once only when the arguments are also the same.
- **Task Packet v2, template `task-packet@7`.** Each verification entry carries `args` and `run` (the resolved shell), and `context.instructionFiles` lists the Repository's instruction files. The template tells the developer to read and follow them as repository content: they never widen the scope, grant a permission or override the factory's rules. Packets stored as version 1 still parse (`instructionFiles` defaults to empty, `run` is optional). The reviewer's packet is unchanged.
- **Instruction files are frozen** into the Job's per-Repository section (`instructionFiles`), like the commands and Sensitive Paths. A snapshot frozen before #102 has none, so such a Job gives its developer none. The files are only listed, never read or written by the factory: they are in the Worktree.
- **The planner prompt (`proposal-stage@5`)** lists, for the planning Stage only, each Repository's profile commands (sorted, with their `run` and whether they accept arguments), the argument pattern, and its Sensitive Paths, with the instruction not to list a Sensitive Path in `writable`. The other Stages' prompts are unchanged apart from the template hash.

## Consequences

- `tests/scenarios/verification-commands.test.ts` covers a profile command run with arguments from the frozen section (a profile edit after creation does not reach the Job), its Evidence, the re-prompt for arguments on a command without `acceptsArgs`, the packet's instruction files and the planner prompt. The Claude Code stub now records each prompt it reads so scenarios can check them.
- Free shell verification still runs; `tests/support/scripts.ts` still uses it. #103 moves the tests and the Fake script to profile command names, then #104 refuses free shell.
