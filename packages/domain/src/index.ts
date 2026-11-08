/**
 * Entities and API contracts shared by the runtime and its clients. Zod schemas
 * only: no I/O (ARCHITECTURE §2).
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { TaskStateSchema } from './execution.js';
import {
  RiskSchema,
  RuleIssueSchema,
  TaskRoleSchema,
  TaskScopeSchema,
  VerificationCommandSchema,
} from './proposals.js';

export * from './proposals.js';
export * from './execution.js';
export * from './review.js';

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

/** Operator-set Project configuration. Every field is optional: unset means inherit. */
export const ProjectConfigSchema = z
  .object({
    /** Attempts per Task, Rework included (ARCHITECTURE §4.6). */
    maxAttempts: z.number().int().min(1).max(10).optional(),
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

/** The Stage IDs of the Phase A `feature` Recipe (PRODUCT_SPEC §4). */
export const StageIdSchema = z.enum([
  'intake',
  'triage',
  'discovery',
  'specification',
  'planning',
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
]);
export type StageRunState = z.infer<typeof StageRunStateSchema>;

/** Allowed Stage Run transitions. Everything else is refused by the engine. */
export const STAGE_RUN_TRANSITIONS: Readonly<Record<StageRunState, readonly StageRunState[]>> = {
  pending: ['queued', 'skipped', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'blocked', 'waiting_human', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  waiting_human: ['queued', 'cancelled'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

/** States a Stage Run never leaves. */
export const FINISHED_STAGE_RUN_STATES: readonly StageRunState[] = (
  Object.keys(STAGE_RUN_TRANSITIONS) as StageRunState[]
).filter((s) => STAGE_RUN_TRANSITIONS[s].length === 0);

/** Finished without a problem: the Job can move past it. */
const PASSED: readonly StageRunState[] = ['succeeded', 'skipped'];

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
 * The built-in `feature` Recipe, Phase A cut: without `plan_approval`,
 * `integration`, `integration_review` and the delivery Stages (ROADMAP Phase A).
 */
export const FEATURE_RECIPE: WorkflowSnapshot = {
  recipeId: 'feature',
  recipeVersion: 1,
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
});
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;

export const RECIPE_DEFAULTS: { readonly maxAttempts: number } = { maxAttempts: 3 };

/** Resolves the Effective Configuration. Pure; frozen onto the Job at creation. */
export function resolveEffectiveConfig(levels: { project: ProjectConfig }): EffectiveConfig {
  const { project } = levels;
  return {
    maxAttempts:
      project.maxAttempts === undefined
        ? { value: RECIPE_DEFAULTS.maxAttempts, source: 'recipe' }
        : { value: project.maxAttempts, source: 'project' },
  };
}

// ---- Job API contracts ------------------------------------------------------

/** Why a Stage Run failed. Recorded on the Stage Run itself, not only in its event. */
export const StageFailureSchema = z.object({
  /**
   * `invalid_output`: the proposal failed validation, also after the one re-prompt.
   * `harness_failed`: the Harness Run did not end with exit code 0.
   * `factory_error`: the factory itself could not run the Stage (a bug or a broken setup).
   * `task_failed`: a Task of the Stage failed, and no Rework route exists yet (#9).
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
