import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Append-only event log (outbox). Written in the same transaction as the state
 * change it describes. Not event sourcing: state tables stay authoritative.
 * ARCHITECTURE §4.1 / §5.
 */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    jobId: text('job_id'),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    payloadJson: text('payload_json').notNull(),
    publishedAt: text('published_at'),
  },
  (t) => [index('events_job_seq').on(t.jobId, t.seq)],
);

/** A product or initiative that owns Repositories and Jobs. ARCHITECTURE §5. */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    configJson: text('config_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('projects_name').on(t.name)],
);

/**
 * A registered git repository and its Factory Clone (ADR-0001). `source` is the
 * path given at registration; the factory never writes to it.
 */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    source: text('source').notNull(),
    remoteUrl: text('remote_url'),
    clonePath: text('clone_path').notNull(),
    defaultBranch: text('default_branch').notNull(),
    profileJson: text('profile_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('repositories_source').on(t.source),
    uniqueIndex('repositories_project_name').on(t.projectId, t.name),
  ],
);

/**
 * One requested outcome. `status` is derived from its Stage Runs and stored
 * denormalized; `version` is bumped by every state change of the Job or any of
 * its Stage Runs (optimistic concurrency, ARCHITECTURE §4.5).
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    type: text('type').notNull(),
    priority: text('priority').notNull(),
    status: text('status').notNull(),
    workflowSnapshotJson: text('workflow_snapshot_json').notNull(),
    configSnapshotJson: text('config_snapshot_json').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [index('jobs_project').on(t.projectId), index('jobs_status').on(t.status)],
);

/** The Repositories a Job may touch (one per Job in Phase A). */
export const jobRepositories = sqliteTable(
  'job_repositories',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.repositoryId] })],
);

/** One execution of a Stage for a Job. `position` is its index in the Workflow Snapshot. */
export const stageRuns = sqliteTable(
  'stage_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    stageId: text('stage_id').notNull(),
    position: integer('position').notNull(),
    state: text('state').notNull(),
    attempt: integer('attempt').notNull(),
    resumeStageId: text('resume_stage_id'),
    blockerJson: text('blocker_json'),
    /** Why the Stage Run failed (`StageFailure`), when it did. */
    failureJson: text('failure_json'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    version: integer('version').notNull(),
  },
  (t) => [uniqueIndex('stage_runs_job_stage_attempt').on(t.jobId, t.stageId, t.attempt)],
);

/**
 * An immutable stored output (ARCHITECTURE §5). The content lives in the
 * factory home at `path`, named by `content_hash` (`sha256:<hex>` of its bytes).
 * Rows are only ever inserted.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    /** The Stage Run whose proposal it is, for proposal Artifacts. */
    stageRunId: text('stage_run_id').references(() => stageRuns.id),
    kind: text('kind').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Relative to the factory home. */
    path: text('path').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('artifacts_job').on(t.jobId), uniqueIndex('artifacts_stage_run').on(t.stageRunId)],
);

/** The numbered Acceptance Criteria of a Job's Specification. */
export const acceptanceCriteria = sqliteTable(
  'acceptance_criteria',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    code: text('code').notNull(),
    text: text('text').notNull(),
    mandatory: integer('mandatory', { mode: 'boolean' }).notNull(),
    verification: text('verification').notNull(),
  },
  (t) => [uniqueIndex('acceptance_criteria_job_code').on(t.jobId, t.code)],
);

/**
 * A unit of work in a Job's Plan. `definition_json` is the validated Plan entry
 * (objective, role, risk, scope, covered criteria, verification commands).
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    planArtifactId: text('plan_artifact_id')
      .notNull()
      .references(() => artifacts.id),
    key: text('key').notNull(),
    title: text('title').notNull(),
    definitionJson: text('definition_json').notNull(),
    state: text('state').notNull(),
    priority: integer('priority').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [uniqueIndex('tasks_job_key').on(t.jobId, t.key), index('tasks_state').on(t.state)],
);

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);
