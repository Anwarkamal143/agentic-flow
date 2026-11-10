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

/** A Task's scheduling priority (ARCHITECTURE §7, §12). */
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * How a priority is stored in `tasks.priority` (an integer; higher runs
 * first). `normal` is 0, so Tasks planned before priorities existed are
 * `normal`. ADR-0017.
 */
export const TASK_PRIORITY_WEIGHT: Readonly<Record<TaskPriority, number>> = {
  low: -1,
  normal: 0,
  high: 1,
};

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
  priority: TaskPrioritySchema.default('normal'),
  /** Attempts this Task may take. It may only narrow the Effective Configuration's value. */
  maxAttempts: z.number().int().positive().optional(),
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
  /** The Effective Configuration's `maxAttempts`, which a Task may only narrow. */
  maxAttempts: number;
  /**
   * The tracked files of each Repository (by id) at the planning base in the
   * Factory Clone. They only name the paths an overlap matches; they never
   * decide whether globs overlap.
   */
  trackedFiles: ReadonlyMap<string, readonly string[]>;
}

/**
 * The Plan's DAG checks (ARCHITECTURE §3, §7): unique keys, a Repository of
 * the Job on every Task, valid scope globs, existing dependencies, no cycles,
 * Acceptance Criteria that exist and are all covered when mandatory, a
 * `maxAttempts` that only narrows, and no overlapping writable paths between
 * Tasks that no dependency path orders.
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
    if (task.maxAttempts !== undefined && task.maxAttempts > ctx.maxAttempts) {
      issues.push({
        rule: 'plan.max_attempts_narrow',
        message: `${at}: maxAttempts ${String(task.maxAttempts)} is above the Effective Configuration (${String(ctx.maxAttempts)}); a Plan may only narrow it`,
      });
    }
  }
  const cycle = findCycle(plan.tasks);
  if (cycle !== undefined) {
    issues.push({ rule: 'plan.no_cycles', message: `dependency cycle: ${cycle.join(' → ')}` });
  }
  issues.push(...overlapIssues(plan, ctx));
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

/** Tracked paths listed in one overlap message, at most. */
const MAX_LISTED_PATHS = 10;

/**
 * `plan.no_overlapping_writes`: two Tasks of one Repository that no dependency
 * path orders (in either direction, transitively) could run in parallel, so
 * their writable globs must not overlap. A static-prefix overlap decides; the
 * tracked files at the planning base only name the paths both globs match.
 */
function overlapIssues(plan: PlanProposal, ctx: PlanContext): RuleIssue[] {
  const repoOf = (t: PlanTaskProposal) =>
    ctx.repositories.find((r) => r.id === t.repository || r.name === t.repository)?.id;
  const ancestors = ancestorsOf(plan.tasks);
  const ordered = (a: string, b: string) =>
    (ancestors.get(a)?.has(b) ?? false) || (ancestors.get(b)?.has(a) ?? false);
  const issues: RuleIssue[] = [];
  plan.tasks.forEach((a, i) => {
    for (const b of plan.tasks.slice(i + 1)) {
      const repo = repoOf(a);
      if (repo === undefined || repo !== repoOf(b) || a.key === b.key || ordered(a.key, b.key)) {
        continue;
      }
      const pairs = a.scope.writable.flatMap((ga) =>
        b.scope.writable.filter((gb) => globsOverlap(ga, gb)).map((gb) => [ga, gb] as const),
      );
      if (pairs.length === 0) continue;
      const inA = matcherOf(a.scope.writable);
      const inB = matcherOf(b.scope.writable);
      const paths = (ctx.trackedFiles.get(repo) ?? []).filter((p) => inA(p) && inB(p));
      const listed =
        paths.length === 0
          ? 'no tracked file at the planning base matches both yet'
          : `tracked files at the planning base both match: ${paths.slice(0, MAX_LISTED_PATHS).join(', ')}${paths.length > MAX_LISTED_PATHS ? ` and ${String(paths.length - MAX_LISTED_PATHS)} more` : ''}`;
      issues.push({
        rule: 'plan.no_overlapping_writes',
        message: `Tasks ${a.key} and ${b.key} may run in parallel (no dependency orders them) but both may write the same paths: ${pairs.map(([ga, gb]) => `'${ga}' and '${gb}'`).join('; ')}; ${listed}. Make one depend on the other, or split their writable paths.`,
      });
    }
  });
  return issues;
}

/**
 * True when two globs may match a common path, judged by their static
 * prefixes (the leading path segments without glob syntax): they overlap
 * when one prefix is, segment by segment, a prefix of the other. An empty
 * prefix (`**\/*.md`) overlaps everything. Conservative: `src/*.ts` and
 * `src/*.css` overlap.
 */
function globsOverlap(a: string, b: string): boolean {
  const pa = staticSegments(a);
  const pb = staticSegments(b);
  const n = Math.min(pa.length, pb.length);
  return pa.slice(0, n).every((s, i) => s === pb[i]);
}

function staticSegments(glob: string): string[] {
  const { base } = picomatch.scan(glob);
  return base === '' ? [] : base.split('/');
}

function matcherOf(globs: readonly string[]): (path: string) => boolean {
  const tests = globs.map((g) => picomatch(g, { dot: true }));
  return (path) => tests.some((t) => t(path));
}

/** Every Task's transitive dependencies, by key (unknown keys and cycles tolerated). */
function ancestorsOf(tasks: readonly { key: string; dependsOn: readonly string[] }[]) {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const result = new Map<string, Set<string>>();
  for (const t of tasks) {
    const seen = new Set<string>();
    const stack = [...t.dependsOn];
    for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(...(deps.get(key) ?? []));
    }
    result.set(t.key, seen);
  }
  return result;
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
