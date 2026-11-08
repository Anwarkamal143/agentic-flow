/**
 * Jobs: creation (intake), reads, and the explicit operations on them. The
 * API never exposes a generic "set state" (ARCHITECTURE §4.5).
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AttemptSchema,
  evidenceSource,
  ReviewSchema,
  type Review,
  WorktreeSchema,
  type Attempt,
  type Worktree,
  canTransitionStageRun,
  currentStageOf,
  EffectiveConfigSchema,
  FEATURE_RECIPE,
  JobStatusSchema,
  JobTypeSchema,
  ProjectConfigSchema,
  resolveEffectiveConfig,
  StageFailureSchema,
  StageIdSchema,
  StageRunStateSchema,
  TaskDefinitionSchema,
  TaskStateSchema,
  TERMINAL_JOB_STATUSES,
  WorkflowSnapshotSchema,
  type AcceptanceCriterion,
  type CancelJobInput,
  type CreateJobInput,
  type Job,
  type JobSummary,
  type StageRun,
  type Task,
  type WorkflowSnapshot,
} from '@factory/domain';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { changeJob, changeJobIn, readJobState, stepTask, type JobState } from './engine.js';
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
    return rows.map((job) => {
      const link = repos.find((r) => r.jobId === job.id);
      if (link === undefined) throw new Error(`Job ${job.id} has no Repository`);
      return toSummary(
        { job, stageRuns: runs.filter((r) => r.jobId === job.id) },
        link.repositoryId,
      );
    });
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
          if (canTransitionStageRun(StageRunStateSchema.parse(run.state), 'cancelled')) {
            step(run, 'cancelled', { reason: input.reason });
          }
        }
        cancelOpenTasks(tx, id, input.reason);
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

  acceptanceCriteria(jobId: string): AcceptanceCriterion[] {
    this.get(jobId); // 404 for an unknown Job
    return this.db
      .select()
      .from(schema.acceptanceCriteria)
      .where(eq(schema.acceptanceCriteria.jobId, jobId))
      .orderBy(asc(sql`rowid`))
      .all();
  }

  tasks(jobId: string): Task[] {
    this.get(jobId); // 404 for an unknown Job
    return this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.jobId, jobId))
      .orderBy(asc(sql`rowid`))
      .all()
      .map(toTask);
  }

  /** Every Attempt of the Job's Tasks, oldest first, with its verification runs and Evidence. */
  attempts(jobId: string): Attempt[] {
    this.get(jobId); // 404 for an unknown Job
    const rows = this.db
      .select({ attempt: schema.attempts })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .where(eq(schema.tasks.jobId, jobId))
      .orderBy(asc(schema.attempts.startedAt), asc(schema.attempts.n))
      .all()
      .map((r) => r.attempt);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const runs = this.db
      .select()
      .from(schema.verificationRuns)
      .where(inArray(schema.verificationRuns.attemptId, ids))
      .orderBy(asc(sql`rowid`))
      .all();
    const evidence = this.db
      .select({ e: schema.evidence, code: schema.acceptanceCriteria.code })
      .from(schema.evidence)
      .leftJoin(
        schema.acceptanceCriteria,
        eq(schema.acceptanceCriteria.id, schema.evidence.criterionId),
      )
      .where(inArray(schema.evidence.attemptId, ids))
      .orderBy(asc(sql`"evidence"."rowid"`))
      .all();
    return rows.map((a) => {
      const own = runs.filter((r) => r.attemptId === a.id);
      return AttemptSchema.parse({
        id: a.id,
        taskId: a.taskId,
        n: a.n,
        state: a.state,
        exitReason: a.exitReason,
        exitDetail: a.exitDetail,
        harness: { id: a.harnessId, version: a.harnessVersion },
        sessionRef: a.sessionRef,
        promptTemplate: { id: a.promptTemplateId, hash: a.promptTemplateHash },
        packet: JSON.parse(a.packetJson) as unknown,
        worktreeId: a.worktreeId,
        baseSha: a.baseSha,
        headSha: a.headSha,
        commits: JSON.parse(a.commitsJson) as unknown,
        wipCommit: a.wipCommit,
        protocolViolations: JSON.parse(a.protocolViolationsJson) as unknown,
        usage: a.usageJson === null ? null : (JSON.parse(a.usageJson) as unknown),
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        verificationRuns: own.map((r) => ({
          id: r.id,
          attemptId: r.attemptId,
          key: r.commandKey,
          command: r.command,
          required: r.required,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          headSha: r.headSha,
          baseSha: r.baseSha,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          outputArtifactId: r.outputArtifactId,
        })),
        evidence: evidence
          .filter((x) => x.e.attemptId === a.id)
          .map(({ e, code }) => ({
            id: e.id,
            attemptId: e.attemptId,
            kind: e.kind,
            source: evidenceSource(e),
            reviewId: e.reviewId,
            verificationKey: own.find((r) => r.id === e.verificationRunId)?.commandKey ?? null,
            verificationRunId: e.verificationRunId,
            criterionId: e.criterionId,
            criterionCode: code,
            verdict: e.verdict,
            detail: e.detail,
            headSha: e.headSha,
            baseSha: e.baseSha,
          })),
      } satisfies Record<keyof Attempt, unknown>);
    });
  }

  /** Every recorded review of the Job's Attempts, oldest first, with its packet and Findings. */
  reviews(jobId: string): Review[] {
    this.get(jobId); // 404 for an unknown Job
    const rows = this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.jobId, jobId))
      .orderBy(asc(schema.reviews.createdAt), asc(sql`rowid`))
      .all();
    if (rows.length === 0) return [];
    const findings = this.db
      .select()
      .from(schema.reviewFindings)
      .where(
        inArray(
          schema.reviewFindings.reviewId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(schema.reviewFindings.position))
      .all();
    return rows.map((r) =>
      ReviewSchema.parse({
        id: r.id,
        jobId: r.jobId,
        taskId: r.taskId,
        attemptId: r.attemptId,
        reviewer: { harnessId: r.reviewerHarnessId, version: r.reviewerHarnessVersion },
        sessionRef: r.sessionRef,
        promptTemplate: { id: r.promptTemplateId, hash: r.promptTemplateHash },
        headSha: r.headSha,
        baseSha: r.baseSha,
        outcome: r.outcome,
        summary: r.summary,
        artifactId: r.artifactId,
        packet: JSON.parse(r.packetJson) as unknown,
        findings: findings
          .filter((f) => f.reviewId === r.id)
          .map((f) => ({
            id: f.id,
            severity: f.severity,
            faultOrigin: f.faultOrigin,
            location: f.location,
            problem: f.problem,
            why: f.why,
            recommendation: f.recommendation,
            blocking: f.blocking,
          })),
        createdAt: r.createdAt,
      } satisfies Record<keyof Review, unknown>),
    );
  }

  worktrees(jobId: string): Worktree[] {
    this.get(jobId); // 404 for an unknown Job
    return this.db
      .select()
      .from(schema.worktrees)
      .where(eq(schema.worktrees.jobId, jobId))
      .orderBy(asc(schema.worktrees.createdAt))
      .all()
      .map((w) =>
        WorktreeSchema.parse({
          id: w.id,
          jobId: w.jobId,
          taskId: w.taskId,
          repositoryId: w.repositoryId,
          path: w.path,
          branch: w.branch,
          baseSha: w.baseSha,
          state: w.state,
          portBase: w.portBase,
          createdAt: w.createdAt,
        } satisfies Record<keyof Worktree, unknown>),
      );
  }

  private repositoryOf(jobId: string): string {
    const row = this.db
      .select()
      .from(schema.jobRepositories)
      .where(eq(schema.jobRepositories.jobId, jobId))
      .get();
    if (row === undefined) throw new Error(`Job ${jobId} has no Repository`);
    return row.repositoryId;
  }
}

/**
 * Tasks that have not started are cancelled with their Job, so the Task
 * scheduler can never pick up work of a cancelled Job. Running Tasks don't
 * exist before #7; stopping them is #12.
 */
function cancelOpenTasks(tx: Tx, jobId: string, reason: string | undefined): void {
  const open = tx
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.jobId, jobId), inArray(schema.tasks.state, ['pending', 'ready'])))
    .all();
  for (const task of open) {
    stepTask(tx, { jobId, actor: OPERATOR }, task, 'cancelled', { reason });
  }
}

function toTask(row: typeof schema.tasks.$inferSelect): Task {
  const definition = TaskDefinitionSchema.parse(JSON.parse(row.definitionJson));
  return {
    id: row.id,
    jobId: row.jobId,
    key: row.key,
    title: row.title,
    repositoryId: row.repositoryId,
    state: TaskStateSchema.parse(row.state),
    ...definition,
    maxAttempts: row.maxAttempts,
    planArtifactId: row.planArtifactId,
    version: row.version,
  };
}

function toStageRun(row: JobState['stageRuns'][number]): StageRun {
  return {
    id: row.id,
    stageId: StageIdSchema.parse(row.stageId),
    state: StageRunStateSchema.parse(row.state),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    failure:
      row.failureJson === null ? null : StageFailureSchema.parse(JSON.parse(row.failureJson)),
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
