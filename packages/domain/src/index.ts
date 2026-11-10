/**
 * Entities and API contracts shared by the runtime and its clients. Zod schemas
 * only: no I/O (ARCHITECTURE §2).
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { TaskStateSchema } from './execution.js';
import { BlockerSchema } from './rework.js';
import {
  DEFAULT_TOOL_POLICIES,
  ToolPoliciesSchema,
  type HarnessRole,
  type ToolPolicy,
} from './tool-policy.js';
import {
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

const commandSchema = z.string().trim().min(1).max(1000).nullable();

/** Shell commands the factory runs to verify work in a Repository. `null`: none. */
export const RepositoryCommandsSchema = z.object({
  test: commandSchema,
  typecheck: commandSchema,
});
export type RepositoryCommands = z.infer<typeof RepositoryCommandsSchema>;

export const PackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

/**
 * What the factory knows about how to work in a Repository. Detected commands
 * are proposals until a human confirms them; only confirmed profiles are saved.
 */
export const RepositoryProfileSchema = z.object({
  version: z.literal(1),
  packageManager: PackageManagerSchema.nullable(),
  commands: RepositoryCommandsSchema,
  confirmedBy: z.string(),
  confirmedAt: z.string(),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

/**
 * `required`: every new Plan waits at `plan_approval` for a human. `skip`: the
 * Stage Run ends `skipped`, with the reason in its event (PRODUCT_SPEC §4).
 */
export const PlanApprovalPolicySchema = z.enum(['required', 'skip']);
export type PlanApprovalPolicy = z.infer<typeof PlanApprovalPolicySchema>;

/** Operator-set Project configuration. Every field is optional: unset means inherit. */
export const ProjectConfigSchema = z
  .object({
    /** Attempts per Task, Rework included (ARCHITECTURE §4.6). */
    maxAttempts: z.number().int().min(1).max(10).optional(),
    /** Retries per Task: new Attempts after an interrupted one. They don't count toward `maxAttempts`. */
    maxRetries: z.number().int().min(0).max(10).optional(),
    /** Answered Questions per Task, each a new Attempt (ARCHITECTURE §8). */
    maxQuestions: z.number().int().min(0).max(10).optional(),
    /** Whether a new Plan waits for a human at `plan_approval` (ADR-0016). */
    planApproval: PlanApprovalPolicySchema.optional(),
    /** Replans per Job; re-specification counts too, a Plan Edit doesn't (ARCHITECTURE §4.6, §4.7). */
    maxReplans: z.number().int().min(0).max(10).optional(),
    /** Task concurrency limits (ARCHITECTURE §12). A Job may override them at creation. */
    concurrency: z
      .object({
        perRepository: z.number().int().min(1).max(16).optional(),
        perJob: z.number().int().min(1).max(16).optional(),
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
  createdAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

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
  packageManager: PackageManagerSchema.nullable(),
  /** Proposed commands, for the human to confirm or replace. */
  detectedCommands: RepositoryCommandsSchema,
});
export type RepositoryInspection = z.infer<typeof RepositoryInspectionSchema>;

/** `POST /v1/repositories`. `commands` are the human-confirmed ones. */
export const RegisterRepositoryInputSchema = z.object({
  path: absolutePath,
  project: z.string().trim().min(1).max(100),
  commands: RepositoryCommandsSchema,
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
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'blocked', 'waiting_human', 'cancelled'],
  blocked: ['queued', 'cancelled'],
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

/**
 * The built-in `feature` Recipe, Phase B cut: without `integration`,
 * `integration_review` and the delivery Stages (ROADMAP). Version 2 added
 * `plan_approval` (ADR-0016); Jobs created at version 1 keep their snapshot.
 */
export const FEATURE_RECIPE: WorkflowSnapshot = {
  recipeId: 'feature',
  recipeVersion: 2,
  stages: StageIdSchema.options.map((id) => ({ id })),
};

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

// ---- Configuration (ARCHITECTURE §15, Phase A minimal) ---------------------

export const ConfigSourceSchema = z.enum(['recipe', 'project']);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

const effectiveValue = <T extends z.ZodType>(value: T) =>
  z.object({ value, source: ConfigSourceSchema });

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
  planApproval: effectiveValue(PlanApprovalPolicySchema).default({
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
});
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;

export const RECIPE_DEFAULTS: {
  readonly maxAttempts: number;
  readonly maxRetries: number;
  readonly maxQuestions: number;
  readonly planApproval: PlanApprovalPolicy;
  readonly maxReplans: number;
  readonly concurrency: { readonly perRepository: number; readonly perJob: number };
} = {
  maxAttempts: 3,
  maxRetries: 2,
  maxQuestions: 3,
  planApproval: 'required',
  maxReplans: 2,
  concurrency: { perRepository: 2, perJob: 2 },
};

/** The Tier 0 tool policy of `role` in a Job's frozen Effective Configuration (its JSON). Pure. */
export function toolPolicyOf(configSnapshotJson: string, role: HarnessRole): ToolPolicy {
  return EffectiveConfigSchema.parse(JSON.parse(configSnapshotJson)).toolPolicies.value[role];
}

/** Resolves the Effective Configuration. Pure; frozen onto the Job at creation. */
export function resolveEffectiveConfig(levels: { project: ProjectConfig }): EffectiveConfig {
  const { project } = levels;
  return {
    maxAttempts:
      project.maxAttempts === undefined
        ? { value: RECIPE_DEFAULTS.maxAttempts, source: 'recipe' }
        : { value: project.maxAttempts, source: 'project' },
    maxRetries:
      project.maxRetries === undefined
        ? { value: RECIPE_DEFAULTS.maxRetries, source: 'recipe' }
        : { value: project.maxRetries, source: 'project' },
    toolPolicies: { value: DEFAULT_TOOL_POLICIES, source: 'recipe' },
    maxQuestions:
      project.maxQuestions === undefined
        ? { value: RECIPE_DEFAULTS.maxQuestions, source: 'recipe' }
        : { value: project.maxQuestions, source: 'project' },
    planApproval:
      project.planApproval === undefined
        ? { value: RECIPE_DEFAULTS.planApproval, source: 'recipe' }
        : { value: project.planApproval, source: 'project' },
    maxReplans:
      project.maxReplans === undefined
        ? { value: RECIPE_DEFAULTS.maxReplans, source: 'recipe' }
        : { value: project.maxReplans, source: 'project' },
    concurrency: {
      perRepository:
        project.concurrency?.perRepository === undefined
          ? { value: RECIPE_DEFAULTS.concurrency.perRepository, source: 'recipe' }
          : { value: project.concurrency.perRepository, source: 'project' },
      perJob:
        project.concurrency?.perJob === undefined
          ? { value: RECIPE_DEFAULTS.concurrency.perJob, source: 'recipe' }
          : { value: project.concurrency.perJob, source: 'project' },
    },
  };
}

// ---- Job API contracts ------------------------------------------------------

/** Why a Stage Run failed. Recorded on the Stage Run itself, not only in its event. */
export const StageFailureSchema = z.object({
  /**
   * `invalid_output`: the proposal failed validation, also after the one re-prompt.
   * `harness_failed`: the Harness Run did not end with exit code 0.
   * `factory_error`: the factory itself could not run the Stage (a bug or a broken setup).
   * `task_failed`: a Task of the Stage failed for a reason with no Rework route.
   */
  reason: z.enum(['invalid_output', 'harness_failed', 'factory_error', 'task_failed']),
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

export const JobSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  repositoryId: z.string(),
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
});
export type Job = z.infer<typeof JobSchema>;

/** `POST /v1/jobs`. */
export const CreateJobInputSchema = z.object({
  repositoryId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
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
  key: z.string(),
  title: z.string(),
  repositoryId: z.string(),
  state: TaskStateSchema,
  maxAttempts: z.number().int().positive(),
  /** Retries allowed after interrupted Attempts (not counted toward `maxAttempts`). */
  maxRetries: z.number().int().nonnegative(),
  /** Why a `blocked` Task can't go on, and what would clear it. */
  blocker: BlockerSchema.nullable(),
  /** The Plan Artifact it was taken from. */
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
