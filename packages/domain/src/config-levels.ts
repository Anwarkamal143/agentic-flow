/**
 * The configuration levels (ADR-0049, ADR-0057): recipe < Factory < Project <
 * Repository < Job < Task, the keys each level may set, and the narrowing rule
 * for permission values. Pure. Kept apart from `index.ts` so the Factory Level
 * and the Project config share one set of keys without an import cycle.
 */
import { z } from 'zod';
import { ReviewRerunOnBaseChangeSchema } from './base-change.js';
import { MergePolicySchema, type MergePolicy } from './merge-gate.js';

/**
 * `required`: every new Plan waits at `plan_approval` for a human. `skip`: the
 * Stage Run ends `skipped`, with the reason in its event (PRODUCT_SPEC §4).
 */
export const PlanApprovalPolicySchema = z.enum(['required', 'skip']);
export type PlanApprovalPolicy = z.infer<typeof PlanApprovalPolicySchema>;

/** Task concurrency limits set at a level (Factory, Project, or a Job at creation); unset inherits. */
export const ConcurrencyOverrideSchema = z
  .object({
    perRepository: z.number().int().min(1).max(16).optional(),
    perJob: z.number().int().min(1).max(16).optional(),
  })
  .strict();
export type ConcurrencyOverride = z.infer<typeof ConcurrencyOverrideSchema>;

/** Where an effective value came from, least to most specific; `invariant` is the ceiling. */
export const ConfigSourceSchema = z.enum([
  'invariant',
  'recipe',
  'factory',
  'project',
  'repository',
  'job',
  'task',
]);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

/**
 * The Job-wide keys the Factory Level and a Project may set (every one
 * optional: unset inherits). `concurrency` differs per level, so each schema
 * adds its own.
 */
export const LEVEL_CONFIG_SHAPE = {
  /** Attempts per Task, Rework included (ARCHITECTURE §4.6). */
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** Retries per Task: new Attempts after an interrupted one. They don't count toward `maxAttempts`. */
  maxRetries: z.number().int().min(0).max(10).optional(),
  /** Answered Questions per Task, each a new Attempt (ARCHITECTURE §8). */
  maxQuestions: z.number().int().min(0).max(10).optional(),
  /** Whether a new Plan waits for a human at `plan_approval` (ADR-0016). A permission value. */
  planApproval: PlanApprovalPolicySchema.optional(),
  /** Replans per Job; re-specification counts too, a Plan Edit doesn't (ARCHITECTURE §4.6, §4.7). */
  maxReplans: z.number().int().min(0).max(10).optional(),
  /** How a Review follows a moved base (ADR-0041): `rerunOnBaseChange`, `if_diff_changed` by default. */
  review: z
    .object({ rerunOnBaseChange: ReviewRerunOnBaseChangeSchema.optional() })
    .strict()
    .optional(),
  /**
   * A ceiling on the Merge Policy of every Repository below (ADR-0057). A
   * permission value: a Repository or Job may only be as strict or stricter.
   */
  mergePolicy: MergePolicySchema.optional(),
};

/** One level's value in a permission value's chain of narrowings. */
export const ChainLinkSchema = z.object({ source: ConfigSourceSchema, value: z.string() });
export type ChainLink = z.infer<typeof ChainLinkSchema>;

/**
 * The permission values and their order, narrowest first (ADR-0049: a lower
 * level may only narrow them). Concurrency and the caps are not permission
 * values (PROGRESS Phase B Q7).
 */
export const PERMISSION_ORDER = {
  mergePolicy: ['never_auto', 'human_approval'],
  planApproval: ['required', 'skip'],
} as const satisfies Record<string, readonly string[]>;
export type PermissionKey = keyof typeof PERMISSION_ORDER;

/** A level that may set a permission value; `value` undefined: it sets nothing. */
export interface PermissionLevel {
  source: ConfigSource;
  /** The Project's or Repository's name, for messages. */
  name?: string | undefined;
  value: string | undefined;
}

export interface ConfigViolation {
  code: 'config_widens_parent';
  message: string;
}

export type ChainResult =
  | { ok: true; value: string; source: ConfigSource; chain: ChainLink[] }
  | ({ ok: false } & ConfigViolation);

/** How a level is named in a message: "the Factory Level", "Project 'shop'". */
export function levelLabel(level: Pick<PermissionLevel, 'source' | 'name'>): string {
  switch (level.source) {
    case 'factory':
      return 'the Factory Level';
    case 'project':
    case 'repository': {
      const kind = level.source === 'project' ? 'Project' : 'Repository';
      return level.name === undefined ? `the ${kind}` : `${kind} '${level.name}'`;
    }
    case 'job':
      return 'the Job';
    case 'task':
      return 'the Task';
    case 'recipe':
      return 'the Recipe';
    case 'invariant':
      return 'the Immutable Invariants';
  }
}

/**
 * A permission value through its levels, least specific first. The most
 * specific level that sets it wins; a level wider than the nearest level above
 * that sets it is refused, naming that parent and its value. Levels that set
 * nothing are left out of the chain; `fallback` (the recipe default) is no
 * parent and is used only when no level sets the value.
 */
export function narrowingChain(
  key: PermissionKey,
  levels: readonly PermissionLevel[],
  fallback: { value: string; source: ConfigSource },
): ChainResult {
  const order: readonly string[] = PERMISSION_ORDER[key];
  const chain: ChainLink[] = [];
  let parent: PermissionLevel | undefined;
  for (const level of levels) {
    if (level.value === undefined) continue;
    if (parent?.value !== undefined && order.indexOf(level.value) > order.indexOf(parent.value)) {
      return {
        ok: false,
        code: 'config_widens_parent',
        message:
          `${levelLabel(level)} sets ${key} ${level.value}, wider than its parent: ` +
          `${levelLabel(parent)} sets ${parent.value}. A lower level may only narrow a permission value.`,
      };
    }
    chain.push({ source: level.source, value: level.value });
    parent = level;
  }
  if (parent?.value === undefined) return { ok: true, ...fallback, chain: [] };
  return { ok: true, value: parent.value, source: parent.source, chain };
}

/** The permission values one level sets (the Factory Level or a Project). */
export interface PermissionValues {
  mergePolicy?: MergePolicy | undefined;
  planApproval?: PlanApprovalPolicy | undefined;
}

/** Every stored level that may set a permission value: the Factory Level, each Project, each Repository. */
export interface ConfigTree {
  factory: PermissionValues;
  projects: readonly {
    name: string;
    config: PermissionValues;
    repositories: readonly { name: string; mergePolicy: MergePolicy }[];
  }[];
}

/**
 * The first level of `tree` wider than its parent, or undefined. Run over the
 * whole tree after a proposed change, so a set that widens a level and a set
 * that narrows a parent below a child are both refused.
 */
export function configTreeViolation(tree: ConfigTree): ConfigViolation | undefined {
  for (const project of tree.projects) {
    const factory: PermissionLevel = { source: 'factory', value: undefined };
    const own: PermissionLevel = { source: 'project', name: project.name, value: undefined };
    const plan = narrowingChain(
      'planApproval',
      [
        { ...factory, value: tree.factory.planApproval },
        { ...own, value: project.config.planApproval },
      ],
      { value: 'required', source: 'recipe' },
    );
    if (!plan.ok) return { code: plan.code, message: plan.message };
    const parents = [
      { ...factory, value: tree.factory.mergePolicy },
      { ...own, value: project.config.mergePolicy },
    ];
    const levels = project.repositories.length === 0 ? [parents] : [];
    for (const repo of project.repositories) {
      levels.push([
        ...parents,
        { source: 'repository', name: repo.name, value: repo.mergePolicy },
      ]);
    }
    for (const chain of levels) {
      const merge = narrowingChain('mergePolicy', chain, {
        value: 'never_auto',
        source: 'repository',
      });
      if (!merge.ok) return { code: merge.code, message: merge.message };
    }
  }
  return undefined;
}
