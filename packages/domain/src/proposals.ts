/**
 * LLM proposals for the proposal Stages (ARCHITECTURE §3): triage, discovery,
 * specification and planning. A Harness Run's output is parsed against these
 * schemas, then checked by the validators below, which are plain code. Every
 * problem names the rule that broke.
 */
import picomatch from 'picomatch';
import { z } from 'zod';

const text = z.string().trim().min(1).max(10_000);
const shortText = z.string().trim().min(1).max(500);
const code = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-\\d{2,}$`), `must be numbered like ${prefix}-01`);

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

export const TriageProposalSchema = z.object({
  summary: text,
  type: z.enum(['feature']),
  risk: RiskSchema,
});
export type TriageProposal = z.infer<typeof TriageProposalSchema>;

export const DiscoveryProposalSchema = z.object({
  summary: text,
  /** The file map: what is relevant, and why. */
  files: z.array(z.object({ path: shortText, reason: shortText })).max(500),
});
export type DiscoveryProposal = z.infer<typeof DiscoveryProposalSchema>;

export const AcceptanceCriterionProposalSchema = z.object({
  code: code('AC'),
  text,
  mandatory: z.boolean(),
  /** How the criterion is checked (PRODUCT_SPEC §5: every mandatory AC has one). */
  verification: shortText,
});

/** PRODUCT_SPEC §6. */
export const SpecificationProposalSchema = z.object({
  problem: text,
  objective: text,
  scope: z.array(shortText),
  outOfScope: z.array(shortText),
  requirements: z.array(z.object({ code: code('FR'), text })),
  acceptanceCriteria: z.array(AcceptanceCriterionProposalSchema).min(1).max(100),
  edgeCases: z.array(shortText),
  securityConsiderations: z.array(shortText),
  definitionOfDone: z.array(shortText).min(1),
});
export type SpecificationProposal = z.infer<typeof SpecificationProposalSchema>;

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'must be a lowercase slug (a-z, 0-9, -), at most 40 long');

export const VerificationCommandSchema = z.object({
  key: slug,
  command: z.string().trim().min(1).max(1000),
  required: z.boolean().default(true),
  /**
   * Codes of the Task's Acceptance Criteria this command verifies. Its exit
   * code becomes their Evidence; a criterion no command names has none yet.
   */
  criteria: z.array(z.string()).default([]),
});
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

export const TaskScopeSchema = z.object({
  writable: z.array(z.string()).min(1),
  forbidden: z.array(z.string()).default([]),
  readHints: z.array(shortText).default([]),
});
export type TaskScope = z.infer<typeof TaskScopeSchema>;

export const TaskRoleSchema = z.enum(['developer']);

export const PlanTaskProposalSchema = z.object({
  key: slug,
  title: shortText,
  objective: text,
  /** A Repository of the Job, by name or id. */
  repository: shortText,
  role: TaskRoleSchema,
  risk: RiskSchema,
  scope: TaskScopeSchema,
  /** Keys of Tasks that must be approved first. */
  dependsOn: z.array(z.string()).default([]),
  /** Codes of the Acceptance Criteria this Task covers. */
  acceptance: z.array(z.string()).default([]),
  verification: z.array(VerificationCommandSchema).min(1),
});
export type PlanTaskProposal = z.infer<typeof PlanTaskProposalSchema>;

export const PlanProposalSchema = z.object({
  tasks: z.array(PlanTaskProposalSchema).min(1).max(50),
});
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

/** One problem with a proposal. `rule` is stable: `schema`, `spec.*` or `plan.*`. */
export const RuleIssueSchema = z.object({
  rule: z.string(),
  message: z.string(),
});
export type RuleIssue = z.infer<typeof RuleIssueSchema>;

/** Turns a schema failure into rule issues (`rule: schema`). */
export function schemaIssues(error: z.ZodError): RuleIssue[] {
  return error.issues.map((i) => ({
    rule: 'schema',
    message: `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`,
  }));
}

export function validateSpecification(spec: SpecificationProposal): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!spec.acceptanceCriteria.some((c) => c.mandatory)) {
    issues.push({
      rule: 'spec.mandatory_criterion',
      message: 'the Specification has no mandatory Acceptance Criterion',
    });
  }
  for (const dup of duplicates(spec.acceptanceCriteria.map((c) => c.code))) {
    issues.push({ rule: 'spec.unique_codes', message: `${dup} is used more than once` });
  }
  for (const dup of duplicates(spec.requirements.map((r) => r.code))) {
    issues.push({ rule: 'spec.unique_codes', message: `${dup} is used more than once` });
  }
  return issues;
}

export interface PlanContext {
  /** The Job's Repositories. */
  repositories: readonly { id: string; name: string }[];
  /** The Specification's Acceptance Criteria. */
  criteria: readonly { code: string; mandatory: boolean }[];
}

/**
 * The Plan's DAG checks (ARCHITECTURE §3): unique keys, a Repository of the Job
 * on every Task, valid scope globs, existing dependencies, no cycles, and
 * Acceptance Criteria that exist and are all covered when mandatory.
 */
export function validatePlan(plan: PlanProposal, ctx: PlanContext): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const keys = new Set(plan.tasks.map((t) => t.key));
  const criteria = new Set(ctx.criteria.map((c) => c.code));

  for (const dup of duplicates(plan.tasks.map((t) => t.key))) {
    issues.push({
      rule: 'plan.unique_task_keys',
      message: `Task key ${dup} is used more than once`,
    });
  }
  for (const task of plan.tasks) {
    const at = `Task ${task.key}`;
    if (!ctx.repositories.some((r) => r.id === task.repository || r.name === task.repository)) {
      issues.push({
        rule: 'plan.task_repository',
        message: `${at}: repository '${task.repository}' is not a Repository of this Job (${ctx.repositories.map((r) => r.name).join(', ')})`,
      });
    }
    for (const [list, globs] of [
      ['writable', task.scope.writable],
      ['forbidden', task.scope.forbidden],
    ] as const) {
      for (const glob of globs) {
        const problem = globProblem(glob);
        if (problem !== undefined) {
          issues.push({
            rule: 'plan.valid_globs',
            message: `${at}: ${list} glob '${glob}' ${problem}`,
          });
        }
      }
    }
    for (const dep of task.dependsOn) {
      if (!keys.has(dep)) {
        issues.push({
          rule: 'plan.dependencies_exist',
          message: `${at} depends on unknown Task ${dep}`,
        });
      }
    }
    for (const ac of task.acceptance) {
      if (!criteria.has(ac)) {
        issues.push({
          rule: 'plan.criteria_exist',
          message: `${at} covers ${ac}, which the Specification does not define`,
        });
      }
    }
    for (const v of task.verification) {
      for (const ac of v.criteria) {
        if (!task.acceptance.includes(ac)) {
          issues.push({
            rule: 'plan.verification_criteria',
            message: `${at}: verification ${v.key} verifies ${ac}, which the Task does not cover`,
          });
        }
      }
    }
    for (const dup of duplicates(task.verification.map((v) => v.key))) {
      issues.push({
        rule: 'plan.unique_verification_keys',
        message: `${at}: verification key ${dup} is used more than once`,
      });
    }
  }
  const cycle = findCycle(plan.tasks);
  if (cycle !== undefined) {
    issues.push({ rule: 'plan.no_cycles', message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  for (const c of ctx.criteria) {
    if (c.mandatory && !plan.tasks.some((t) => t.acceptance.includes(c.code))) {
      issues.push({
        rule: 'plan.mandatory_criteria_covered',
        message: `mandatory ${c.code} is covered by no Task`,
      });
    }
  }
  return issues;
}

/**
 * Why a scope glob is unusable, or `undefined` when it is valid. Globs are
 * POSIX paths relative to the Repository root.
 */
export function globProblem(glob: string): string | undefined {
  if (glob === '' || glob.trim() !== glob) return 'is empty or has surrounding whitespace';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(glob)) return 'contains a control character';
  if (glob.includes('\\')) return 'contains a backslash (use / separators)';
  if (glob.startsWith('/')) return 'is absolute (scopes are relative to the Repository root)';
  if (glob.startsWith('!')) return 'is negated (list it under forbidden instead)';
  if (glob.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    return 'has an empty, . or .. path segment';
  }
  try {
    picomatch.makeRe(glob, { strictBrackets: true });
  } catch (err) {
    return `is not a valid glob (${err instanceof Error ? err.message : String(err)})`;
  }
  return undefined;
}

/** A cycle in the dependency graph as a list of keys (first repeated at the end), if any. */
function findCycle(tasks: readonly { key: string; dependsOn: readonly string[] }[]) {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    if (state.get(key) === 'done') return undefined;
    if (state.get(key) === 'visiting') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'visiting');
    path.push(key);
    for (const dep of deps.get(key) ?? []) {
      if (!deps.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return undefined;
  };
  for (const t of tasks) {
    const cycle = visit(t.key);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const v of values) (seen.has(v) ? dups : seen).add(v);
  return [...dups];
}
