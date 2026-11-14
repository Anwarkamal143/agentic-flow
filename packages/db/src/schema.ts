import {
  index,
  type AnySQLiteColumn,
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
    /** Replans used, against `maxReplans` (ARCHITECTURE §4.7). A Plan Edit is not one (ADR-0019). */
    replansUsed: integer('replans_used').notNull().default(0),
    /**
     * A Replan was requested and waits for in-flight Attempts to settle (ARCHITECTURE §4.7).
     * State, not only an event, so the UI shows persisted state (spec #33 story 79).
     */
    replanRequested: integer('replan_requested', { mode: 'boolean' }).notNull().default(false),
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
    /** The Task and Attempt it belongs to, for an Attempt's Artifacts. */
    taskId: text('task_id'),
    attemptId: text('attempt_id'),
    kind: text('kind').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Relative to the factory home. */
    path: text('path').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('artifacts_job').on(t.jobId), uniqueIndex('artifacts_stage_run').on(t.stageRunId)],
);

/**
 * The numbered Acceptance Criteria of each of a Job's Specifications: a
 * re-specification adds a new spec Artifact with its own criteria, and the
 * old ones stay (ADR-0031), so codes are unique per Artifact.
 */
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
  (t) => [
    uniqueIndex('acceptance_criteria_artifact_code').on(t.artifactId, t.code),
    index('acceptance_criteria_job').on(t.jobId),
  ],
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
    /** Retries after interrupted Attempts; they don't count toward `max_attempts`. */
    maxRetries: integer('max_retries').notNull().default(2),
    /** Answer Attempts after Questions (ADR-0023); they count toward neither cap above. */
    maxQuestions: integer('max_questions').notNull().default(3),
    /** Why a `blocked` Task can't go on (`Blocker`), while it is blocked. */
    blockerJson: text('blocker_json'),
    /** Why a `cancelled` Task was cancelled (`TaskCancelReason`); null in every other state. */
    cancelReason: text('cancel_reason'),
    version: integer('version').notNull(),
  },
  // A key is unique within its Plan: a replaced Plan's Task may share a key with the new one (ADR-0019).
  (t) => [
    uniqueIndex('tasks_plan_key').on(t.planArtifactId, t.key),
    index('tasks_job').on(t.jobId),
    index('tasks_state').on(t.state),
  ],
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

/**
 * One try at a Task (ARCHITECTURE §5). The Task Packet, the template hash and
 * the Harness version are recorded when it starts; the head commit, the
 * commits, the WIP commit and the usage are read by the factory after the Run.
 */
export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    n: integer('n').notNull(),
    /** `initial`, `rework`, `retry` or `answer` (`AttemptCause`). */
    cause: text('cause').notNull().default('initial'),
    state: text('state').notNull(),
    harnessId: text('harness_id').notNull(),
    harnessVersion: text('harness_version'),
    /** The security tier the Attempt ran under (`SecurityTier`); `local` is the Tier 0 guardrail. */
    tier: text('tier').notNull().default('local'),
    sessionRef: text('session_ref'),
    promptTemplateId: text('prompt_template_id').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    packetJson: text('packet_json').notNull(),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id),
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha'),
    /** JSON array of the commits `base_sha..head_sha`, read from git. */
    commitsJson: text('commits_json').notNull(),
    wipCommit: text('wip_commit'),
    /** JSON array of `RuleIssue`: where the Task Result disagreed with git. */
    protocolViolationsJson: text('protocol_violations_json').notNull(),
    /** JSON array of `AttemptFinding`: what the factory's Gates found (the review's are in `review_findings`). */
    gateFindingsJson: text('gate_findings_json').notNull().default('[]'),
    /**
     * JSON array of `InboxQuestion`: the questions its Task Result asked (agent
     * output, redacted on write like every binding, ADR-0011).
     */
    questionsJson: text('questions_json').notNull().default('[]'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    exitReason: text('exit_reason'),
    exitDetail: text('exit_detail'),
    usageJson: text('usage_json'),
    /**
     * The process the Attempt is waiting on (`AttemptProcess`): a Harness Run
     * or a verification command, with the spool directory that outlives the
     * runtime. Set before the process starts, cleared once its end is recorded.
     * Recovery reads it (ADR-0012).
     */
    processJson: text('process_json'),
    /** How the last developer Harness Run ended (`HarnessExit`), set on `verifying`, for a resumed verification. */
    developerExitJson: text('developer_exit_json'),
    version: integer('version').notNull(),
  },
  (t) => [uniqueIndex('attempts_task_n').on(t.taskId, t.n)],
);

/**
 * Exclusive claims on a resource: a Task (held by the dispatcher) or a block
 * of ports (held by a Worktree). One row per resource; releasing deletes it.
 */
export const leases = sqliteTable(
  'leases',
  {
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id').notNull(),
    holder: text('holder').notNull(),
    leaseId: text('lease_id').notNull(),
    acquiredAt: text('acquired_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    heartbeatAt: text('heartbeat_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.resourceKind, t.resourceId] })],
);

/** A Worktree of a Factory Clone, for one Task. */
export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    path: text('path').notNull(),
    branch: text('branch').notNull(),
    baseSha: text('base_sha').notNull(),
    state: text('state').notNull(),
    /** First port of the block leased to this Worktree (a `port_block` lease while held). */
    portBase: integer('port_base').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('worktrees_task').on(t.taskId), uniqueIndex('worktrees_path').on(t.path)],
);

/** One factory-run verification command, against one `(head_sha, base_sha)`. */
export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    commandKey: text('command_key').notNull(),
    command: text('command').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    exitCode: integer('exit_code'),
    timedOut: integer('timed_out', { mode: 'boolean' }).notNull(),
    startedAt: text('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    outputArtifactId: text('output_artifact_id')
      .notNull()
      .references(() => artifacts.id),
  },
  (t) => [index('verification_runs_attempt').on(t.attemptId)],
);

/** A recorded verdict, valid only for its `(head_sha, base_sha)`. */
export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    kind: text('kind').notNull(),
    verificationRunId: text('verification_run_id').references(() => verificationRuns.id),
    criterionId: text('criterion_id').references(() => acceptanceCriteria.id),
    verdict: text('verdict').notNull(),
    detail: text('detail').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    artifactId: text('artifact_id').references(() => artifacts.id),
    /** Set when the verdict is the review's (kind `criterion`); else it came from the commands. */
    reviewId: text('review_id').references((): AnySQLiteColumn => reviews.id),
  },
  (t) => [index('evidence_attempt').on(t.attemptId)],
);

/**
 * An independent review of one Attempt (ARCHITECTURE §9), valid only for its
 * `(head_sha, base_sha)`. Written once, when the reviewer's proposal is
 * valid; never regenerated. The packet is what the reviewer was sent.
 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    reviewerHarnessId: text('reviewer_harness_id').notNull(),
    reviewerHarnessVersion: text('reviewer_harness_version'),
    sessionRef: text('session_ref'),
    promptTemplateId: text('prompt_template_id').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    packetJson: text('packet_json').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    outcome: text('outcome').notNull(),
    summary: text('summary').notNull(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('reviews_job').on(t.jobId),
    uniqueIndex('reviews_attempt_shas').on(t.attemptId, t.headSha, t.baseSha),
  ],
);

/** One Finding of a review. */
export const reviewFindings = sqliteTable(
  'review_findings',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id),
    position: integer('position').notNull(),
    severity: text('severity').notNull(),
    faultOrigin: text('fault_origin').notNull(),
    location: text('location').notNull(),
    problem: text('problem').notNull(),
    why: text('why').notNull(),
    recommendation: text('recommendation').notNull(),
    blocking: integer('blocking', { mode: 'boolean' }).notNull(),
  },
  (t) => [uniqueIndex('review_findings_review_position').on(t.reviewId, t.position)],
);

/**
 * An Inbox Item (ARCHITECTURE §5, ADR-0016): a decision only a human makes.
 * `subject_ref` is what is decided on (for `plan`, the plan Artifact id);
 * `version` is bumped by every change, and a decision names both. Items stay
 * pending (`expires_policy: remain_pending`) and never auto-approve.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    taskId: text('task_id').references(() => tasks.id),
    /** The Stage Run it holds, when it holds one (`plan_approval` for a plan). */
    stageRunId: text('stage_run_id').references(() => stageRuns.id),
    /** `question | plan | spec_change | blocker | cleanup`. */
    kind: text('kind').notNull(),
    subjectRef: text('subject_ref').notNull(),
    question: text('question').notNull(),
    why: text('why').notNull(),
    /** A `question` item's JSON array of `InboxQuestion` (agent-proposed, redacted); null otherwise. */
    questionsJson: text('questions_json'),
    /** JSON array of `ApprovalOption`. */
    optionsJson: text('options_json').notNull(),
    recommended: text('recommended'),
    /** JSON array of the Artifact ids that back it. */
    evidenceJson: text('evidence_json').notNull(),
    /** `open | decided | cancelled | superseded`. */
    state: text('state').notNull(),
    deferred: integer('deferred', { mode: 'boolean' }).notNull(),
    requestedBy: text('requested_by').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    /** `InboxDecision` once decided. */
    decisionJson: text('decision_json'),
    expiresPolicy: text('expires_policy').notNull(),
    createdAt: text('created_at').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [index('approvals_job').on(t.jobId), index('approvals_state').on(t.state)],
);

/**
 * The audit log (ARCHITECTURE §5): a human's change to what the factory may
 * do, such as a cap raised by an Inbox grant (ADR-0026). Append-only, never
 * deleted. `job_id` (beside §5's columns) lets a Job's audit be read.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: text('ts').notNull(),
    /** Who decided it: `user:<name>`. */
    actor: text('actor').notNull(),
    /** What changed, such as `cap.raised`. */
    action: text('action').notNull(),
    /** What it changed: `task:<id>`. */
    target: text('target').notNull(),
    jobId: text('job_id').references(() => jobs.id),
    beforeJson: text('before_json').notNull(),
    afterJson: text('after_json').notNull(),
    /** The rule or decision that allowed it: `inbox:<approval id>/<option>`. */
    policyRef: text('policy_ref'),
    /** Ties it to the decision that made it (the Inbox Item's id). */
    correlationId: text('correlation_id'),
  },
  (t) => [index('audit_log_job').on(t.jobId), index('audit_log_target').on(t.target)],
);
