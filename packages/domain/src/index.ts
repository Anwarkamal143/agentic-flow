/**
 * Entities and API contracts shared by the runtime and its clients. Zod schemas
 * only: no I/O (ARCHITECTURE §2).
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';

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
export function deriveJobStatus(
  stageRuns: readonly { stageId: StageId; state: StageRunState }[],
): JobStatus {
  const states = new Set(stageRuns.map((s) => s.state));
  if (states.has('running') || states.has('queued')) return 'active';
  if (states.has('blocked')) return 'blocked';
  if (states.has('waiting_human')) return 'waiting_human';
  if (states.has('failed')) return 'failed';
  if (states.has('cancelled')) return 'cancelled';
  if (stageRuns.length > 0 && stageRuns.every((s) => s.state === 'pending')) return 'draft';
  const last = stageRuns.at(-1);
  if (last?.state === 'succeeded') return 'completed';
  // Work remains but nothing is queued: only seen between two steps of the engine.
  return 'active';
}

/** The first Stage that has not finished, or the last Stage when all have. */
export function currentStageOf(
  stageRuns: readonly { stageId: StageId; state: StageRunState }[],
): StageId {
  const open = stageRuns.find((s) => s.state !== 'succeeded' && s.state !== 'skipped');
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

export const StageRunSchema = z.object({
  id: z.string(),
  stageId: StageIdSchema,
  state: StageRunStateSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
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
