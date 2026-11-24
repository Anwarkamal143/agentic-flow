/**
 * Entities and API contracts shared by the runtime and its clients. Zod schemas
 * only: no I/O (ARCHITECTURE §2).
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { TaskCancelReasonSchema, TaskStateSchema } from './execution.js';
import { BlockerSchema } from './rework.js';
import { GitHubCoordinatesSchema, parseCoordinates } from './github.js';
import { TaskKindSchema } from './integration.js';
import { ReviewRerunOnBaseChangeSchema, type ReviewRerunOnBaseChange } from './base-change.js';
import { SetupCommandSchema } from './setup.js';
import { DeliveryOrderSchema } from './delivery-order.js';
import {
  DEFAULT_SENSITIVE_PATHS,
  DetectedProfileSchema,
  ProfileCommandsSchema,
  RepositoryProfileSchema,
  type RepositoryProfile,
} from './profile.js';
import { ProjectJobLimitSchema } from './scheduling.js';
import {
  ChainLinkSchema,
  ConcurrencyOverrideSchema,
  ConfigSourceSchema,
  LEVEL_CONFIG_SHAPE,
  narrowingChain,
  PlanApprovalPolicySchema,
  type ConcurrencyOverride,
  type ConfigSource,
  type ConfigViolation,
  type PlanApprovalPolicy,
} from './config-levels.js';
import {
  EffectiveMergePolicySchema,
  MergeMethodSchema,
  MergePolicySchema,
  type MergeMethod,
  type MergePolicy,
} from './merge-gate.js';
import {
  DEFAULT_TOOL_POLICIES,
  ToolPoliciesSchema,
  withInvariants,
  type HarnessRole,
  type ToolPolicy,
} from './tool-policy.js';
import {
  RepositorySetBySchema,
  RiskSchema,
  RuleIssueSchema,
  TaskRoleSchema,
  TaskScopeSchema,
  VerificationCommandSchema,
} from './proposals.js';

export * from './proposals.js';
export * from './execution.js';
export * from './event-log.js';
export * from './billing.js';
export * from './findings.js';
export * from './review.js';
export * from './rework.js';
export * from './redaction.js';
export * from './logs.js';
export * from './recovery.js';
export * from './tool-policy.js';
export * from './activity.js';
export * from './approvals.js';
export * from './plan-view.js';
export * from './capacity.js';
export * from './dependency-base.js';
export * from './delivery-order.js';
export * from './contract-step.js';
export * from './questions.js';
export * from './clarification.js';
export * from './blocker-approvals.js';
export * from './carry-over.js';
export * from './keep-going.js';
export * from './delivery.js';
export * from './cleanup.js';
export * from './respecification.js';
export * from './github.js';
export * from './integration.js';
export * from './pull-request.js';
export * from './merge-gate.js';
export * from './pr-feedback.js';
export * from './base-change.js';
export * from './setup.js';
export * from './projects.js';
export * from './factory-level.js';
export * from './config-levels.js';
export * from './scheduling.js';
export * from './profile.js';
export * from './writability.js';

/** Operator-set Project configuration. Every field is optional: unset means inherit. */
export const ProjectConfigSchema = z
  .object({
    ...LEVEL_CONFIG_SHAPE,
    /**
     * Task concurrency limits (ARCHITECTURE §12); a Job may override them at
     * creation. `perProjectJobs` (ADR-0050) is read at each claim, not frozen.
     */
    concurrency: ConcurrencyOverrideSchema.extend({
      perProjectJobs: ProjectJobLimitSchema.optional(),
    })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Operator-set config. Jobs freeze it into their Effective Configuration at creation. */
  config: ProjectConfigSchema,
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** `POST /v1/projects` (`project create`). Names are unique. */
export const CreateProjectInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be letters, digits, ".", "_" or "-"'),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

/** `POST /v1/projects/:ref/config/set` (`project config set`): one key, dotted when nested. */
export const SetProjectConfigInputSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});
export type SetProjectConfigInput = z.infer<typeof SetProjectConfigInputSchema>;

/** A Job of a Project that has not reached a terminal status. */
export const ProjectJobSchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
export type ProjectJob = z.infer<typeof ProjectJobSchema>;

/** `GET /v1/projects`: each Project with its Repositories and active Jobs. */
export const ProjectSummarySchema = ProjectSchema.extend({
  repositories: z.array(z.object({ id: z.string(), name: z.string() })),
  activeJobs: z.array(ProjectJobSchema),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** The path given at registration. The factory never writes to it (ADR-0001). */
  source: z.string(),
  /** The source's `origin` URL at registration, when it had one. */
  remoteUrl: z.string().nullable(),
  /** The Factory Clone, under the workspace root. */
  clonePath: z.string(),
  defaultBranch: z.string(),
  profile: RepositoryProfileSchema,
  /**
   * Where the Repository lives on GitHub (ADR-0033): from a github.com
   * `remoteUrl`, or set with `repo add --github`. `null`: no GitHub remote.
   */
  github: GitHubCoordinatesSchema.nullable(),
  /** Set at `repo add` (default `never_auto`); a Job may only make it stricter (ADR-0038). */
  mergePolicy: MergePolicySchema,
  /** How the factory merges under `human_approval` (default `merge`, a merge commit; ADR-0038). */
  mergeMethod: MergeMethodSchema,
  createdAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

/** `GET /v1/projects/:ref` (`project show`): the Project, its Repositories in full and its active Jobs. */
export const ProjectDetailSchema = ProjectSchema.extend({
  repositories: z.array(RepositorySchema),
  activeJobs: z.array(ProjectJobSchema),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

const absolutePath = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), 'must be an absolute path');

/** `POST /v1/repositories/inspect`: read-only look at a path before registering it. */
export const InspectRepositoryInputSchema = z.object({ path: absolutePath });
export type InspectRepositoryInput = z.infer<typeof InspectRepositoryInputSchema>;

export const RepositoryInspectionSchema = z.object({
  /** The working tree root of the repository that contains `path`. */
  source: z.string(),
  name: z.string(),
  remoteUrl: z.string().nullable(),
  /** The GitHub coordinates `remoteUrl` gives, when it is a github.com URL. */
  github: GitHubCoordinatesSchema.nullable(),
  /**
   * What Profile Detection proposes (ADR-0060), from the source's HEAD; for
   * the human to confirm or replace. Never a setup command.
   */
  detected: DetectedProfileSchema,
});
export type RepositoryInspection = z.infer<typeof RepositoryInspectionSchema>;

/** `POST /v1/repositories`. `commands` are the human-confirmed ones. */
export const RegisterRepositoryInputSchema = z.object({
  path: absolutePath,
  /** An existing Project's name or id; an unknown one is refused, never created (ADR-0055). */
  project: z.string().trim().min(1).max(100),
  /**
   * The detected profile fields as the human confirmed them (`repo add`
   * shows each one; `--yes` accepts them). Saved with detection `detected`.
   */
  profile: DetectedProfileSchema,
  /** The Merge Gate's `requiredChecks`, from `repo add --required-check` (repeatable). */
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** `repo add --setup`: the Worktree setup command (ADR-0047). Never inferred. */
  setup: SetupCommandSchema.optional(),
  /** `owner/name`, from `repo add --github`. Wins over the coordinates the origin URL gives. */
  github: z
    .string()
    .refine((text) => parseCoordinates(text).ok, {
      message: 'must be a GitHub repository as owner/name (for example acme/widgets)',
    })
    .optional(),
  /** `repo add --merge-policy`; default `never_auto`. `auto_if_low_risk_and_green` is refused until Phase E. */
  mergePolicy: MergePolicySchema.optional(),
  /** `repo add --merge-method`; default `merge`. */
  mergeMethod: MergeMethodSchema.optional(),
});
export type RegisterRepositoryInput = z.infer<typeof RegisterRepositoryInputSchema>;

export const RegisterRepositoryResultSchema = z.object({
  project: ProjectSchema,
  repository: RepositorySchema,
  /** How the Factory Clone was made. */
  cloneMethod: z.enum(['origin_with_reference', 'path']),
});
export type RegisterRepositoryResult = z.infer<typeof RegisterRepositoryResultSchema>;

/** Error body of every non-2xx API response. */
export const ApiErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---- Jobs, Stage Runs, Recipes (ARCHITECTURE §4.2, §4.3) -------------------

/** The Stage IDs of the `feature` Recipe built so far (PRODUCT_SPEC §4). */
export const StageIdSchema = z.enum([
  'intake',
  'triage',
  'discovery',
  'specification',
  'planning',
  'plan_approval',
  'execution',
  'integration',
  'integration_review',
  'pull_request',
  'merge_approval',
  'merge',
  'closure',
]);
export type StageId = z.infer<typeof StageIdSchema>;

export const StageRunStateSchema = z.enum([
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'waiting_human',
  'skipped',
  'cancelled',
  'rejected',
  'superseded',
]);
export type StageRunState = z.infer<typeof StageRunStateSchema>;

/** Allowed Stage Run transitions. Everything else is refused by the engine. */
export const STAGE_RUN_TRANSITIONS: Readonly<Record<StageRunState, readonly StageRunState[]>> = {
  pending: ['queued', 'skipped', 'cancelled'],
  // `→ superseded` from queued, running or blocked: a requested Replan replaces `execution` once
  // no Attempt is in flight; a new Stage Run of it waits on the new Plan (ADR-0029).
  queued: ['running', 'cancelled', 'superseded'],
  running: ['succeeded', 'failed', 'blocked', 'waiting_human', 'cancelled', 'superseded'],
  blocked: ['queued', 'cancelled', 'superseded'],
  // `→ succeeded | rejected`: a human decided a Stage that waits only on that decision (plan_approval).
  // `→ superseded`: a human requested changes to the Plan; a new Stage Run of it waits on the new Plan (ADR-0019).
  waiting_human: ['queued', 'succeeded', 'rejected', 'cancelled', 'superseded'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
  // A correct "no", never `failed` (ARCHITECTURE §4.3).
  rejected: [],
  // Replaced by a later Stage Run of the same Stage; it no longer counts for the Job.
  superseded: [],
};

/** States a Stage Run never leaves. */
export const FINISHED_STAGE_RUN_STATES: readonly StageRunState[] = (
  Object.keys(STAGE_RUN_TRANSITIONS) as StageRunState[]
).filter((s) => STAGE_RUN_TRANSITIONS[s].length === 0);

/** Finished without a problem (or replaced by a later run): the Job can move past it. */
const PASSED: readonly StageRunState[] = ['succeeded', 'skipped', 'superseded'];

export function canTransitionStageRun(from: StageRunState, to: StageRunState): boolean {
  return STAGE_RUN_TRANSITIONS[from].includes(to);
}

export const JobStatusSchema = z.enum([
  'draft',
  'active',
  'waiting_human',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'rejected',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

export const JobTypeSchema = z.enum(['feature']);
export type JobType = z.infer<typeof JobTypeSchema>;

/** The frozen copy of a Recipe attached to a Job at creation. */
export const WorkflowSnapshotSchema = z.object({
  recipeId: z.string(),
  recipeVersion: z.number().int().positive(),
  stages: z.array(z.object({ id: StageIdSchema })).min(1),
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

/** The Stage IDs of each version of the built-in `feature` Recipe. */
const FEATURE_RECIPE_STAGES: Readonly<Record<2 | 3 | 4 | 5 | 6, readonly StageId[]>> = {
  // Version 2 added `plan_approval` (ADR-0016).
  2: [
    'intake',
    'triage',
    'discovery',
    'specification',
    'planning',
    'plan_approval',
    'execution',
    'closure',
  ],
  // Version 3 adds `integration` (ADR-0034).
  3: [
    'intake',
    'triage',
    'discovery',
    'specification',
    'planning',
    'plan_approval',
    'execution',
    'integration',
    'closure',
  ],
  // Version 4 adds `integration_review` (ADR-0035).
  4: [
    'intake',
    'triage',
    'discovery',
    'specification',
    'planning',
    'plan_approval',
    'execution',
    'integration',
    'integration_review',
    'closure',
  ],
  // Version 5 adds `pull_request`: the first push and the PR (ADR-0036).
  5: [
    'intake',
    'triage',
    'discovery',
    'specification',
    'planning',
    'plan_approval',
    'execution',
    'integration',
    'integration_review',
    'pull_request',
    'closure',
  ],
  // Version 6 adds `merge_approval` (the Merge Gate and the `merge` item) and `merge` (ADR-0037).
  6: [
    'intake',
    'triage',
    'discovery',
    'specification',
    'planning',
    'plan_approval',
    'execution',
    'integration',
    'integration_review',
    'pull_request',
    'merge_approval',
    'merge',
    'closure',
  ],
};

/** The `feature` Recipe versions a Job can be created at. */
export const FEATURE_RECIPE_VERSIONS = [2, 3, 4, 5, 6] as const;
export type FeatureRecipeVersion = (typeof FEATURE_RECIPE_VERSIONS)[number];

/**
 * The built-in `feature` Recipe at `version`. A Job freezes it at creation and
 * keeps its snapshot: a Job created at an earlier version runs its own Stages.
 */
export function featureRecipe(version: FeatureRecipeVersion): WorkflowSnapshot {
  return {
    recipeId: 'feature',
    recipeVersion: version,
    stages: FEATURE_RECIPE_STAGES[version].map((id) => ({ id })),
  };
}

/**
 * The built-in `feature` Recipe, Phase C cut so far: version 6, with
 * `integration` (ADR-0034), `integration_review` (ADR-0035), `pull_request`
 * (ADR-0036), and `merge_approval` and `merge` (ADR-0037).
 */
export const FEATURE_RECIPE: WorkflowSnapshot = featureRecipe(6);

/**
 * A Job's status, derived from its Stage Runs (ARCHITECTURE §4.2; precedence
 * from PROGRESS.md spec issue 9). Pure: the engine stores the result
 * denormalized on the Job in the same transaction.
 */
type StageRunPosition = Pick<StageRun, 'stageId' | 'state'>;

export function deriveJobStatus(stageRuns: readonly StageRunPosition[]): JobStatus {
  const states = new Set(stageRuns.map((s) => s.state));
  if (states.has('running') || states.has('queued')) return 'active';
  if (states.has('rejected')) return 'rejected';
  if (states.has('blocked')) return 'blocked';
  if (states.has('waiting_human')) return 'waiting_human';
  if (states.has('failed')) return 'failed';
  if (states.has('cancelled')) return 'cancelled';
  if (stageRuns.length > 0 && stageRuns.every((s) => s.state === 'pending')) return 'draft';
  if (stageRuns.length > 0 && stageRuns.every((s) => PASSED.includes(s.state))) return 'completed';
  // Work remains but nothing is queued: only seen between two steps of the engine.
  return 'active';
}

/** The first Stage that has not finished, or the last Stage when all have. */
export function currentStageOf(stageRuns: readonly StageRunPosition[]): StageId {
  const open = stageRuns.find((s) => !PASSED.includes(s.state));
  const stage = open ?? stageRuns.at(-1);
  if (stage === undefined) throw new Error('a Job has at least one Stage Run');
  return stage.stageId;
}

// ---- Configuration (ARCHITECTURE §15, ADR-0049, ADR-0057) -------------------

const effectiveValue = <T extends z.ZodType>(value: T) =>
  z.object({ value, source: ConfigSourceSchema });

/** A permission value: its value, its source, and (since Phase D) its chain of narrowings. */
const permissionValue = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    source: ConfigSourceSchema,
    /** Each level that set it, least specific first. Absent in snapshots from before Phase D. */
    chain: z.array(ChainLinkSchema).optional(),
  });

/**
 * One Repository's section of a Job's Effective Configuration (ADR-0049),
 * resolved for every Repository of the Project at creation.
 */
export const RepositoryEffectiveConfigSchema = z.object({
  repositoryId: z.string(),
  name: z.string(),
  /** The Merge Policy (ADR-0038): the Repository's, or the Job's stricter override. */
  mergePolicy: permissionValue(MergePolicySchema),
  mergeMethod: effectiveValue(MergeMethodSchema),
  /** The Worktree setup command (ADR-0047); `null`: none. */
  setup: effectiveValue(SetupCommandSchema.nullable()),
  /** The profile's named commands (v1 snapshots' `{test, typecheck}` read as named). */
  commands: effectiveValue(ProfileCommandsSchema),
  /**
   * The profile's Sensitive Paths (ADR-0051). Snapshots from before #100
   * have none frozen: they read as the fixed defaults.
   */
  sensitivePaths: effectiveValue(z.array(z.string())).default({
    value: [...DEFAULT_SENSITIVE_PATHS],
    source: 'repository',
  }),
  /** The Merge Gate's `requiredChecks`; empty: every check counts. */
  requiredChecks: effectiveValue(z.array(z.string())),
  /**
   * The profile's instruction files, given to the developer as context
   * (ADR-0051). Snapshots from before #102 froze none: they give none.
   */
  instructionFiles: effectiveValue(z.array(z.string())).default({
    value: [],
    source: 'repository',
  }),
});
export type RepositoryEffectiveConfig = z.infer<typeof RepositoryEffectiveConfigSchema>;

/** The settings for one Job once every level is resolved; each value records its source level. */
export const EffectiveConfigSchema = z.object({
  maxAttempts: effectiveValue(z.number().int().positive()),
  /** Jobs created before #13 have none frozen; they get the recipe default. */
  maxRetries: effectiveValue(z.number().int().nonnegative()).default({
    value: 2,
    source: 'recipe',
  }),
  /**
   * The Tier 0 tool policy per Role (ARCHITECTURE §11). Recipe-level only: a
   * Project can't widen it. Jobs created before #14 get the recipe default.
   */
  toolPolicies: effectiveValue(ToolPoliciesSchema).default({
    value: DEFAULT_TOOL_POLICIES,
    source: 'recipe',
  }),
  /** Jobs created before #35 get the recipe default. */
  maxQuestions: effectiveValue(z.number().int().nonnegative()).default({
    value: 3,
    source: 'recipe',
  }),
  /** Jobs created before #35 have no `plan_approval` Stage; the value is unused there. */
  planApproval: permissionValue(PlanApprovalPolicySchema).default({
    value: 'required',
    source: 'recipe',
  }),
  /** Jobs created before Phase B get the recipe default. */
  maxReplans: effectiveValue(z.number().int().nonnegative()).default({
    value: 2,
    source: 'recipe',
  }),
  /** Jobs created before Phase B get the recipe defaults. */
  concurrency: z
    .object({
      perRepository: effectiveValue(z.number().int().positive()),
      perJob: effectiveValue(z.number().int().positive()),
    })
    .default({
      perRepository: { value: 2, source: 'recipe' },
      perJob: { value: 2, source: 'recipe' },
    }),
  /** `review.rerunOnBaseChange` (ADR-0041). Jobs created before #62 get the recipe default. */
  reviewRerunOnBaseChange: effectiveValue(ReviewRerunOnBaseChangeSchema).default({
    value: 'if_diff_changed',
    source: 'recipe',
  }),
  /**
   * A section per Repository of the Project at creation, by name (ADR-0049).
   * Jobs created before Phase D have none: `repositoryConfigOf` builds their
   * one Repository's section from `mergePolicy` and `setup` below.
   */
  repositories: z.array(RepositoryEffectiveConfigSchema).default([]),
  /** Before Phase D only: the Job's one Repository's Merge Policy (ADR-0038). Unset before #59: `never_auto`. */
  mergePolicy: EffectiveMergePolicySchema.optional(),
  /** Before Phase D only: the Job's one Repository's setup command (ADR-0047). */
  setup: z
    .object({ value: SetupCommandSchema.nullable(), source: z.literal('repository') })
    .optional(),
});
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;

export const RECIPE_DEFAULTS: {
  readonly maxAttempts: number;
  readonly maxRetries: number;
  readonly maxQuestions: number;
  readonly planApproval: PlanApprovalPolicy;
  readonly maxReplans: number;
  readonly concurrency: { readonly perRepository: number; readonly perJob: number };
  readonly reviewRerunOnBaseChange: ReviewRerunOnBaseChange;
} = {
  maxAttempts: 3,
  maxRetries: 2,
  maxQuestions: 3,
  planApproval: 'required',
  maxReplans: 2,
  concurrency: { perRepository: 2, perJob: 2 },
  reviewRerunOnBaseChange: 'if_diff_changed',
};

/**
 * The Tier 0 tool policy of `role` in a Job's frozen Effective Configuration
 * (its JSON), with the invariant denials added (`withInvariants`). Pure.
 */
export function toolPolicyOf(configSnapshotJson: string, role: HarnessRole): ToolPolicy {
  return withInvariants(
    EffectiveConfigSchema.parse(JSON.parse(configSnapshotJson)).toolPolicies.value[role],
  );
}

/** What a Repository contributes to the hierarchy: its own settings and its profile's. */
export interface RepositoryConfigLevel {
  id: string;
  name: string;
  mergePolicy: MergePolicy;
  mergeMethod: MergeMethod;
  profile: Pick<RepositoryProfile, 'commands' | 'sensitivePaths'> & {
    instructionFiles?: string[] | undefined;
    requiredChecks?: string[] | undefined;
    setup?: string | undefined;
  };
}

/** The Job-wide keys a level sets; the Factory Level's `concurrency.global` is read by the scheduler only. */
export type LevelValues = Omit<ProjectConfig, 'concurrency'> & {
  concurrency?: (ConcurrencyOverride & { global?: number | undefined }) | undefined;
};

/** The levels `resolveEffectiveConfig` reads, least specific first (recipe defaults are built in). */
export interface EffectiveConfigLevels {
  factory?: LevelValues | undefined;
  project: ProjectConfig;
  /** Every Repository of the Project; each gets a section. */
  repositories?: readonly RepositoryConfigLevel[] | undefined;
  /** The Job's own overrides, given at creation (ARCHITECTURE §12). */
  job?:
    | { concurrency?: ConcurrencyOverride | undefined; mergePolicy?: MergePolicy | undefined }
    | undefined;
}

export type EffectiveConfigResolution =
  { ok: true; config: EffectiveConfig } | ({ ok: false } & ConfigViolation);

/**
 * Resolves the Effective Configuration (ADR-0049, ADR-0057): recipe < Factory
 * < Project < Repository < Job, the most specific level that sets a value
 * wins, and a permission value wider than its parent is refused with the
 * parent's value. Pure; frozen onto the Job at creation.
 */
export function resolveEffectiveConfig(levels: EffectiveConfigLevels): EffectiveConfigResolution {
  const factory = levels.factory ?? {};
  const { project } = levels;
  const pick = <T>(
    recipe: T,
    ...set: [ConfigSource, T | undefined][]
  ): { value: T; source: ConfigSource } => {
    let found: { value: T; source: ConfigSource } = { value: recipe, source: 'recipe' };
    for (const [source, value] of set) if (value !== undefined) found = { value, source };
    return found;
  };
  const cap = (key: 'maxAttempts' | 'maxRetries' | 'maxQuestions' | 'maxReplans') =>
    pick(RECIPE_DEFAULTS[key], ['factory', factory[key]], ['project', project[key]]);
  const limit = (key: keyof ConcurrencyOverride) =>
    pick(
      RECIPE_DEFAULTS.concurrency[key],
      ['factory', factory.concurrency?.[key]],
      ['project', project.concurrency?.[key]],
      ['job', levels.job?.concurrency?.[key]],
    );

  const planApproval = narrowingChain(
    'planApproval',
    [
      { source: 'factory', value: factory.planApproval },
      { source: 'project', value: project.planApproval },
    ],
    { value: RECIPE_DEFAULTS.planApproval, source: 'recipe' },
  );
  if (!planApproval.ok)
    return { ok: false, code: planApproval.code, message: planApproval.message };

  const repositories: RepositoryEffectiveConfig[] = [];
  const sorted = [...(levels.repositories ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  for (const repo of sorted) {
    const merge = narrowingChain(
      'mergePolicy',
      [
        { source: 'factory', value: factory.mergePolicy },
        { source: 'project', value: project.mergePolicy },
        { source: 'repository', name: repo.name, value: repo.mergePolicy },
        { source: 'job', value: levels.job?.mergePolicy },
      ],
      { value: repo.mergePolicy, source: 'repository' },
    );
    if (!merge.ok) return { ok: false, code: merge.code, message: merge.message };
    repositories.push({
      repositoryId: repo.id,
      name: repo.name,
      mergePolicy: {
        value: MergePolicySchema.parse(merge.value),
        source: merge.source,
        chain: merge.chain,
      },
      mergeMethod: { value: repo.mergeMethod, source: 'repository' },
      setup: { value: repo.profile.setup ?? null, source: 'repository' },
      commands: { value: repo.profile.commands, source: 'repository' },
      sensitivePaths: { value: repo.profile.sensitivePaths, source: 'repository' },
      requiredChecks: { value: repo.profile.requiredChecks ?? [], source: 'repository' },
      instructionFiles: { value: repo.profile.instructionFiles ?? [], source: 'repository' },
    });
  }

  return {
    ok: true,
    config: {
      maxAttempts: cap('maxAttempts'),
      maxRetries: cap('maxRetries'),
      toolPolicies: { value: DEFAULT_TOOL_POLICIES, source: 'recipe' },
      maxQuestions: cap('maxQuestions'),
      planApproval: {
        value: PlanApprovalPolicySchema.parse(planApproval.value),
        source: planApproval.source,
        chain: planApproval.chain,
      },
      maxReplans: cap('maxReplans'),
      concurrency: { perRepository: limit('perRepository'), perJob: limit('perJob') },
      reviewRerunOnBaseChange: pick(
        RECIPE_DEFAULTS.reviewRerunOnBaseChange,
        ['factory', factory.review?.rerunOnBaseChange],
        ['project', project.review?.rerunOnBaseChange],
      ),
      repositories,
    },
  };
}

/**
 * The section of `repository` in a Job's Effective Configuration. A Job
 * created before Phase D has none: its section is built from its frozen
 * `mergePolicy` and `setup` and, for what it never froze (the merge method,
 * the commands, the required checks), the Repository as it is now.
 */
export function repositoryConfigOf(
  config: EffectiveConfig,
  repository: RepositoryConfigLevel,
): RepositoryEffectiveConfig {
  const frozen = config.repositories.find((r) => r.repositoryId === repository.id);
  if (frozen !== undefined) return frozen;
  return {
    repositoryId: repository.id,
    name: repository.name,
    mergePolicy: config.mergePolicy ?? { value: 'never_auto', source: 'repository' },
    mergeMethod: { value: repository.mergeMethod, source: 'repository' },
    setup: config.setup ?? { value: null, source: 'repository' },
    commands: { value: repository.profile.commands, source: 'repository' },
    sensitivePaths: { value: repository.profile.sensitivePaths, source: 'repository' },
    requiredChecks: { value: repository.profile.requiredChecks ?? [], source: 'repository' },
    instructionFiles: { value: repository.profile.instructionFiles ?? [], source: 'repository' },
  };
}

/**
 * A Task's `maxAttempts`: the Plan's narrower cap (source `task`; Plan
 * validation refuses a wider one, ADR-0017), else the Job's.
 */
export function taskMaxAttempts(
  config: EffectiveConfig,
  planned: number | undefined,
): { value: number; source: ConfigSource } {
  return planned === undefined ? config.maxAttempts : { value: planned, source: 'task' };
}

/**
 * `GET /v1/projects/:ref/effective-config` and `GET /v1/repositories/:id/effective-config`:
 * the Effective Configuration a new Job of the Project would freeze now, with no Job-level
 * overrides (ADR-0059). Resolved at each read, never stored. A Repository's preview keeps
 * only that Repository's section.
 */
export const EffectiveConfigPreviewSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /** The Repository the preview is for; `null` for a Project's (every section). */
  repositoryId: z.string().nullable(),
  config: EffectiveConfigSchema,
});
export type EffectiveConfigPreview = z.infer<typeof EffectiveConfigPreviewSchema>;

// ---- Job API contracts ------------------------------------------------------

/** Why a Stage Run failed. Recorded on the Stage Run itself, not only in its event. */
export const StageFailureSchema = z.object({
  /**
   * `invalid_output`: the proposal failed validation, also after the one re-prompt.
   * `harness_failed`: the Harness Run did not end with exit code 0.
   * `factory_error`: the factory itself could not run the Stage (a bug or a broken setup).
   * `task_failed`: a Task of the Stage failed for a reason with no Rework route.
   * `delivery_failed`: GitHub or git refused the push or the pull request (ADR-0036).
   */
  reason: z.enum([
    'invalid_output',
    'harness_failed',
    'factory_error',
    'task_failed',
    'delivery_failed',
  ]),
  message: z.string(),
  issues: z.array(RuleIssueSchema),
});
export type StageFailure = z.infer<typeof StageFailureSchema>;

export const StageRunSchema = z.object({
  id: z.string(),
  stageId: StageIdSchema,
  state: StageRunStateSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  failure: StageFailureSchema.nullable(),
  /** Why a `blocked` or `waiting_human` Stage Run can't go on, and what would clear it. */
  blocker: BlockerSchema.nullable(),
  version: z.number().int(),
});
export type StageRun = z.infer<typeof StageRunSchema>;

/** A Repository a Job touches, as the Job API shows it. */
export const JobRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type JobRepository = z.infer<typeof JobRepositorySchema>;

export const JobSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /**
   * The Repositories the Job touches (one or more of its Project's, ADR-0052),
   * by name. Empty only while triage has yet to choose them (ADR-0067).
   */
  repositories: z.array(JobRepositorySchema),
  /** Who chose `repositories`: the operator (named, or the Project's only one) or triage (ADR-0067). */
  repositorySetBy: RepositorySetBySchema,
  title: z.string(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  currentStage: StageIdSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  /** Bumped by every state change of the Job or its Stage Runs. Send it back on operations. */
  version: z.number().int(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const JobSchema = JobSummarySchema.extend({
  description: z.string(),
  workflowSnapshot: WorkflowSnapshotSchema,
  effectiveConfig: EffectiveConfigSchema,
  stageRuns: z.array(StageRunSchema),
  /**
   * A Replan was requested during execution and waits for every Attempt in flight to settle
   * (ARCHITECTURE §4.7, ADR-0029). Persisted state; cleared when planning starts.
   */
  replanRequested: z.boolean(),
  /** Replans used, against `maxReplans`. */
  replans: z.object({ used: z.number().int(), max: z.number().int() }),
  /**
   * The Delivery Order of the newest persisted Plan (ADR-0052, ADR-0065): its
   * Repositories upstream first. `null` before a Plan's Tasks exist.
   */
  deliveryOrder: DeliveryOrderSchema.nullable(),
});
export type Job = z.infer<typeof JobSchema>;

/** `POST /v1/jobs/:id/replan` (`requestReplan`, ADR-0029). */
export const RequestReplanInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  feedback: z.string().trim().min(1).max(5000),
});
export type RequestReplanInput = z.infer<typeof RequestReplanInputSchema>;

/** `POST /v1/jobs`. */
export const CreateJobInputSchema = z
  .object({
    /**
     * The Project, by id or name. Unset: the Repositories' Project, or else the only
     * Project; with several, the request is refused (PRODUCT_SPEC §5, ADR-0055).
     */
    project: z.string().min(1).optional(),
    /**
     * One Repository: the same as `repositoryIds` with one entry. Neither: the
     * Project's only Repository; with several, triage chooses the set (ADR-0067).
     */
    repositoryId: z.string().min(1).optional(),
    /**
     * The Repositories of a multi-repo Job (ADR-0052, ADR-0065), all of one
     * Project, each once. Triage can't change a named set.
     */
    repositoryIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).default(''),
    /** Overrides of the Effective Configuration's concurrency limits, up or down (ARCHITECTURE §12). */
    concurrency: ConcurrencyOverrideSchema.optional(),
    /** A Merge Policy at least as strict as each Repository's (PRODUCT_SPEC §9); a looser one is refused. */
    mergePolicy: MergePolicySchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.repositoryId !== undefined && input.repositoryIds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['repositoryIds'],
        message: 'name the Repositories with repositoryId or repositoryIds, not both',
      });
    }
    const ids = input.repositoryIds ?? [];
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (repeated.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['repositoryIds'],
        message: `each Repository is named once (${[...new Set(repeated)].join(', ')} more than once)`,
      });
    }
  });
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;

/** `POST /v1/jobs/:id/cancel`. `expectedVersion` is the Job version the caller saw. */
export const CancelJobInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().max(1000).optional(),
});
export type CancelJobInput = z.infer<typeof CancelJobInputSchema>;

// ---- Artifacts, Acceptance Criteria, Tasks (ARCHITECTURE §5) -----------------

/**
 * `triage`, `discovery`, `spec`, `plan`: the proposal Stages' outputs.
 * `task_result`: what a Harness Run claimed. `log`: a verification command's
 * output. `report`: the Delivery Report.
 */
export const ArtifactKindSchema = z.enum([
  'triage',
  'discovery',
  'spec',
  'plan',
  'task_result',
  'log',
  'report',
  'review',
  /** A Replan asked for during execution (ADR-0029): the feedback and who asked, never regenerated. */
  'replan_request',
  /** A re-specification asked for by a `spec` Finding or a human (ADR-0031), never regenerated. */
  'respec_request',
  /**
   * A proposal Stage Run's output that stopped on its questions (ADR-0071):
   * kept, never applied and never regenerated; the next Stage Run reads it.
   */
  'clarification',
  /** The Technical decisions an agent made in a proposal Stage Run, ADR-style (ADR-0071). */
  'decision_record',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** An immutable stored output, addressed by the SHA-256 of its bytes. */
export const ArtifactSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  stageRunId: z.string().nullable(),
  taskId: z.string().nullable(),
  attemptId: z.string().nullable(),
  kind: ArtifactKindSchema,
  /** `sha256:<hex>` of the content bytes served by `GET /v1/artifacts/:id/content`. */
  contentHash: z.string(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  code: z.string(),
  text: z.string(),
  mandatory: z.boolean(),
  verification: z.string(),
  /** The Specification Artifact it was taken from. */
  artifactId: z.string(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** What the Plan says about a Task, stored with it (`tasks.definition_json`). */
export const TaskDefinitionSchema = z.object({
  objective: z.string(),
  role: TaskRoleSchema,
  risk: RiskSchema,
  scope: TaskScopeSchema,
  /** Keys of the Tasks this one depends on. */
  dependsOn: z.array(z.string()),
  /** Codes of the Acceptance Criteria it covers. */
  acceptance: z.array(z.string()),
  verification: z.array(VerificationCommandSchema),
});
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const TaskSchema = TaskDefinitionSchema.extend({
  id: z.string(),
  jobId: z.string(),
  /** `plan`: from the Plan. `integration`: the factory's Integration Task, not part of the Plan (ADR-0034). */
  kind: TaskKindSchema,
  key: z.string(),
  title: z.string(),
  repositoryId: z.string(),
  state: TaskStateSchema,
  /** Why a `cancelled` Task was cancelled; `null` otherwise. */
  cancelReason: TaskCancelReasonSchema.nullable(),
  maxAttempts: z.number().int().positive(),
  /** Retries allowed after interrupted Attempts (not counted toward `maxAttempts`). */
  maxRetries: z.number().int().nonnegative(),
  /** Answer Attempts allowed after Questions (not counted toward `maxAttempts` or `maxRetries`). */
  maxQuestions: z.number().int().nonnegative(),
  /** Why a `blocked` Task can't go on, and what would clear it. */
  blocker: BlockerSchema.nullable(),
  /** The Plan Artifact it was taken from; for the Integration Task, the Plan whose Tasks it integrates. */
  planArtifactId: z.string(),
  version: z.number().int(),
});
export type Task = z.infer<typeof TaskSchema>;

// ---- Events (ARCHITECTURE §4.1, §17) ----------------------------------------

export const FactoryEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  entityKind: z.string(),
  entityId: z.string(),
  jobId: z.string().nullable(),
  type: z.string(),
  actor: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type FactoryEvent = z.infer<typeof FactoryEventSchema>;
