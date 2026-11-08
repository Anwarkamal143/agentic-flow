/**
 * Jobs: creation (intake), reads, and the explicit operations on them. The
 * API never exposes a generic "set state" (ARCHITECTURE §4.5).
 */
import { appendEvent, schema, type FactoryDb } from '@factory/db';
import {
  currentStageOf,
  EffectiveConfigSchema,
  FEATURE_RECIPE,
  JobStatusSchema,
  JobTypeSchema,
  ProjectConfigSchema,
  resolveEffectiveConfig,
  StageIdSchema,
  StageRunStateSchema,
  TERMINAL_JOB_STATUSES,
  WorkflowSnapshotSchema,
  type CancelJobInput,
  type CreateJobInput,
  type Job,
  type JobSummary,
  type StageRun,
  type WorkflowSnapshot,
} from '@factory/domain';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { changeJob, changeJobIn, readJobState, type JobState } from './engine.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';

const OPERATOR = 'user:local';

export class JobService {
  constructor(
    private readonly db: FactoryDb,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  /**
   * Intake: records the Job with its frozen Workflow Snapshot and Effective
   * Configuration, completes `intake`, and queues `triage`. One transaction.
   */
  create(input: CreateJobInput): Job {
    const id = this.db.transaction(
      (tx) => {
        const repo = tx
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, input.repositoryId))
          .get();
        if (repo === undefined) {
          throw new ApiFailure(404, 'repository_not_found', `no Repository ${input.repositoryId}`);
        }
        const project = tx
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, repo.projectId))
          .get();
        if (project === undefined) throw new Error(`Repository ${repo.id} has no Project`);

        // Copies, never references: later edits to the Recipe or config can't reach the Job.
        const snapshot: WorkflowSnapshot = WorkflowSnapshotSchema.parse(
          structuredClone(FEATURE_RECIPE),
        );
        const effectiveConfig = resolveEffectiveConfig({
          project: ProjectConfigSchema.parse(JSON.parse(project.configJson)),
        });
        const jobId = newId('job');
        const now = new Date().toISOString();
        tx.insert(schema.jobs)
          .values({
            id: jobId,
            projectId: project.id,
            title: input.title,
            description: input.description,
            type: JobTypeSchema.enum.feature,
            priority: 'normal',
            status: JobStatusSchema.enum.draft,
            workflowSnapshotJson: JSON.stringify(snapshot),
            configSnapshotJson: JSON.stringify(effectiveConfig),
            createdBy: OPERATOR,
            createdAt: now,
            version: 0,
          })
          .run();
        tx.insert(schema.jobRepositories).values({ jobId, repositoryId: repo.id }).run();
        tx.insert(schema.stageRuns)
          .values(
            snapshot.stages.map((stage, position) => {
              // Intake is this request itself: done once the Job record exists.
              const intake = stage.id === 'intake';
              return {
                id: newId('stg'),
                jobId,
                stageId: stage.id,
                position,
                state: intake ? 'succeeded' : 'pending',
                attempt: 1,
                startedAt: intake ? now : null,
                finishedAt: intake ? now : null,
                version: 0,
              };
            }),
          )
          .run();
        appendEvent(tx, {
          entityKind: 'job',
          entityId: jobId,
          jobId,
          type: 'job.created',
          actor: OPERATOR,
          payload: {
            projectId: project.id,
            repositoryId: repo.id,
            title: input.title,
            recipe: { id: snapshot.recipeId, version: snapshot.recipeVersion },
          },
        });
        changeJobIn(
          tx,
          { jobId, expectedVersion: 'current', actor: OPERATOR },
          (_, state, step) => {
            const next = state.stageRuns.find((r) => r.state === 'pending');
            if (next !== undefined) step(next, 'queued');
          },
        );
        return jobId;
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return this.get(id);
  }

  get(id: string): Job {
    const state = readJobState(this.db, id);
    return toJob(state, this.repositoryOf(id));
  }

  list(): JobSummary[] {
    const rows = this.db.select().from(schema.jobs).orderBy(desc(schema.jobs.createdAt)).all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const runs = this.db
      .select()
      .from(schema.stageRuns)
      .where(inArray(schema.stageRuns.jobId, ids))
      .orderBy(asc(schema.stageRuns.position), asc(schema.stageRuns.attempt))
      .all();
    const repos = this.db
      .select()
      .from(schema.jobRepositories)
      .where(inArray(schema.jobRepositories.jobId, ids))
      .all();
    return rows.map((job) =>
      toSummary(
        { job, stageRuns: runs.filter((r) => r.jobId === job.id) },
        repos.find((r) => r.jobId === job.id)?.repositoryId ?? '',
      ),
    );
  }

  /**
   * Cancels a Job that the caller saw at `expectedVersion`. Stage Runs that are
   * not running are cancelled; a running Stage Run needs its Harness process
   * stopped, which this operation can't do yet, so it is refused.
   */
  cancel(id: string, input: CancelJobInput): Job {
    changeJob(
      this.db,
      { jobId: id, expectedVersion: input.expectedVersion, actor: OPERATOR },
      (tx, state, step) => {
        const status = JobStatusSchema.parse(state.job.status);
        if (TERMINAL_JOB_STATUSES.includes(status)) {
          throw new ApiFailure(409, 'job_terminal', `Job ${id} is already ${status}`);
        }
        const running = state.stageRuns.find((r) => r.state === 'running');
        if (running !== undefined) {
          throw new ApiFailure(
            409,
            'stage_running',
            `Stage ${running.stageId} of Job ${id} is running; cancelling a running Stage is not supported yet`,
          );
        }
        for (const run of state.stageRuns) {
          if (['pending', 'queued', 'blocked', 'waiting_human'].includes(run.state)) {
            step(run, 'cancelled', input.reason);
          }
        }
        appendEvent(tx, {
          entityKind: 'job',
          entityId: id,
          jobId: id,
          type: 'job.cancelled',
          actor: OPERATOR,
          payload: input.reason === undefined ? {} : { reason: input.reason },
        });
      },
    );
    this.onCommit();
    return this.get(id);
  }

  private repositoryOf(jobId: string): string {
    const row = this.db
      .select()
      .from(schema.jobRepositories)
      .where(eq(schema.jobRepositories.jobId, jobId))
      .get();
    return row?.repositoryId ?? '';
  }
}

function toStageRun(row: JobState['stageRuns'][number]): StageRun {
  return {
    id: row.id,
    stageId: StageIdSchema.parse(row.stageId),
    state: StageRunStateSchema.parse(row.state),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    version: row.version,
  };
}

function toSummary(state: JobState, repositoryId: string): JobSummary {
  const { job } = state;
  return {
    id: job.id,
    projectId: job.projectId,
    repositoryId,
    title: job.title,
    type: JobTypeSchema.parse(job.type),
    status: JobStatusSchema.parse(job.status),
    currentStage: currentStageOf(state.stageRuns.map(toStageRun)),
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    version: job.version,
  };
}

function toJob(state: JobState, repositoryId: string): Job {
  return {
    ...toSummary(state, repositoryId),
    description: state.job.description,
    workflowSnapshot: WorkflowSnapshotSchema.parse(JSON.parse(state.job.workflowSnapshotJson)),
    effectiveConfig: EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson)),
    stageRuns: state.stageRuns.map(toStageRun),
  };
}
