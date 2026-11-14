/**
 * The Tier 0 tool policy (ARCHITECTURE §11): which tools each Role's Harness
 * Run may use, and which uses are denied whatever else allows them. It is part
 * of the Effective Configuration, frozen onto the Job, and the Harness turns it
 * into its own permission flags. Rules use Claude Code's permission-rule
 * syntax (`Tool` or `Tool(specifier)`), the only real Harness so far.
 *
 * This is a guardrail, not isolation: the Harness enforces it on itself, and
 * the factory checks the result afterwards (the path-scope Gate, a reviewer
 * that changed the Worktree). A denied pattern is defense in depth only; a
 * determined process running as the operator can get around it.
 */
import { z } from 'zod';

/** What a Role asks of a Harness Run (GLOSSARY: Role). */
export const HarnessRoleSchema = z.enum([
  'triager',
  'researcher',
  'specifier',
  'planner',
  'developer',
  'reviewer',
]);
export type HarnessRole = z.infer<typeof HarnessRoleSchema>;

export const ToolPolicySchema = z.object({
  /** Tools (or tool uses) the Run may use without asking. Anything else is denied. */
  allow: z.array(z.string().min(1)),
  /** Uses denied even when `allow` covers them. */
  deny: z.array(z.string().min(1)),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** One tool policy per Role. */
export const ToolPoliciesSchema = z.record(HarnessRoleSchema, ToolPolicySchema);
export type ToolPolicies = z.infer<typeof ToolPoliciesSchema>;

const READ_ONLY = ['Read', 'Glob', 'Grep'];

/** Dangerous operations (ARCHITECTURE §11) a developer's shell is denied. Defense in depth only. */
const DANGEROUS_SHELL = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean:*)',
  'Bash(git rebase:*)',
  'Bash(git switch:*)',
  'Bash(git checkout -b:*)',
  'Bash(git branch -D:*)',
  'Bash(git config:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(sudo:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
];

/** No Role reaches the network through the Harness's own tools. */
const NO_WEB = ['WebFetch', 'WebSearch'];

/**
 * Immutable Invariant denials (GLOSSARY): denied to every Role whatever its
 * policy says. Today the Harness lock-out from GitHub (ADR-0032): GitHub is the
 * factory's job, through its own credentials; no Harness Run drives the
 * operator's `gh` login. A guardrail only: the `gh` login on disk stays
 * readable under Tier 0, and another program can still reach GitHub.
 */
export const INVARIANT_DENY: readonly string[] = ['Bash(gh:*)'];

/**
 * The recipe's tool policies. The proposal Roles and the reviewer read only
 * (the reviewer may also read git history); the developer edits files and runs
 * commands in its Worktree.
 */
export const DEFAULT_TOOL_POLICIES: ToolPolicies = {
  triager: { allow: READ_ONLY, deny: [...NO_WEB, ...INVARIANT_DENY] },
  researcher: { allow: READ_ONLY, deny: [...NO_WEB, ...INVARIANT_DENY] },
  specifier: { allow: READ_ONLY, deny: [...NO_WEB, ...INVARIANT_DENY] },
  planner: { allow: READ_ONLY, deny: [...NO_WEB, ...INVARIANT_DENY] },
  developer: {
    allow: [...READ_ONLY, 'Edit', 'Write', 'Bash'],
    deny: [...NO_WEB, ...DANGEROUS_SHELL, ...INVARIANT_DENY],
  },
  reviewer: {
    allow: [
      ...READ_ONLY,
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
    ],
    deny: [...NO_WEB, 'Edit', 'Write', 'NotebookEdit', ...INVARIANT_DENY],
  },
};

/**
 * `policy` with {@link INVARIANT_DENY} added to its `deny`, once each. A Job
 * frozen before an Immutable Invariant existed gets it too: invariants rank
 * above every configuration level, the frozen snapshot included, and adding
 * one only narrows. Pure.
 */
export function withInvariants(policy: ToolPolicy): ToolPolicy {
  return { allow: policy.allow, deny: [...new Set([...policy.deny, ...INVARIANT_DENY])] };
}

/**
 * The tools a policy makes available at all: the tool name of every `allow`
 * rule, once each, in order (`Bash(git diff:*)` makes `Bash` available, limited
 * to that use). Pure.
 */
export function toolsOf(policy: ToolPolicy): string[] {
  return [...new Set(policy.allow.map((rule) => rule.replace(/\(.*$/s, '')))];
}
