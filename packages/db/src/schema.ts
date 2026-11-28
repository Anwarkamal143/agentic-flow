import {
  index,
  type AnySQLiteColumn,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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

/**
 * The Factory Level (ADR-0049, ADR-0056): factory-wide configuration, a single
 * row (`id` is always `factory`) created on the runtime's first start. `version`
 * starts at 1 and each change adds one (optimistic concurrency).
 */
export const factoryLevel = sqliteTable('factory_level', {
  id: text('id').primaryKey(),
  configJson: text('config_json').notNull(),
  version: integer('version').notNull(),
  updatedAt: text('updated_at').notNull(),
  /**
   * The configuration version (#113, ADR-0073): bumped by every change to the
   * Factory Level, a Project or a Repository's configuration, so a
   * `config import --apply --expect-version` sees any change since its diff.
   */
  configVersion: integer('config_version').notNull().default(1),
});

/**
 * The onboarding wizard (#114, ADR-0053, ADR-0074): one row, created on the
 * runtime's first start. Its only state is the last step completed (null
 * before the first); resume opens the step after it.
 */
export const onboarding = sqliteTable('onboarding', {
  id: text('id').primaryKey(),
  lastCompletedStep: text('last_completed_step'),
  version: integer('version').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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
    /** GitHub coordinates (ADR-0033); both null when the Repository has no GitHub remote. */
    githubOwner: text('github_owner'),
    githubName: text('github_name'),
    /** `never_auto | human_approval` (ADR-0038), set at `repo add`. */
    mergePolicy: text('merge_policy').notNull().default('never_auto'),
    /** `merge | squash | rebase`: how the factory merges under `human_approval` (ADR-0038). */
    mergeMethod: text('merge_method').notNull().default('merge'),
    /**
     * The GitHub label that opts the Repository into issue intake (#112,
     * ADR-0072); null: no intake. Only with GitHub coordinates.
     */
    intakeLabel: text('intake_label'),
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
    /**
     * JSON `DeliveryOrder` (ADR-0052, ADR-0065): the Repositories of the newest
     * persisted Plan, upstream first. `null` until a Plan's Tasks are written.
     */
    deliveryOrderJson: text('delivery_order_json'),
    /**
     * Who chose the Job's Repository set (ADR-0067): `operator` (named at
     * creation, or the Project's only one) or `triage` (written to
     * `job_repositories` when triage succeeds; none before).
     */
    repositorySetBy: text('repository_set_by').notNull().default('operator'),
    /**
     * JSON `SourceIssue` (#112, ADR-0072): the GitHub issue the Job came from,
     * by an approved intake item or `job create --from-issue`; null otherwise.
     */
    sourceIssueJson: text('source_issue_json'),
  },
  (t) => [index('jobs_project').on(t.projectId), index('jobs_status').on(t.status)],
);

/** The Repositories a Job may touch: one or more of its Project's (ADR-0052). */
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
    /**
     * `plan`, or `integration`: the factory's Integration Task (ADR-0034), whose
     * `plan_artifact_id` is the Plan whose Tasks it integrates.
     */
    kind: text('kind').notNull().default('plan'),
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
    /**
     * The approved Integration Task's next Attempt merges the moved default branch in
     * (cause `base_merge`, ADR-0041). Set when the move is seen, cleared once that
     * Attempt is recorded or its merge-in conflicts.
     */
    baseMergeRequested: integer('base_merge_requested', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * The PR head someone else pushed to the approved Integration Task's branch
     * (ADR-0042): its next Attempt (cause `foreign_push`) fetches and verifies
     * it. Set when the poller sees it, cleared once that Attempt is recorded.
     */
    foreignHeadSha: text('foreign_head_sha'),
    /**
     * The foreign rewrite of the Integration Branch a human approved
     * (`adopt_rewrite` on the `foreign_push_rewrite` Blocker, ADR-0042): a
     * fetched head that holds it is adopted though it drops approved commits.
     * Cleared once the `foreign_push` Attempt that adopts it is recorded.
     */
    foreignRewriteApprovedSha: text('foreign_rewrite_approved_sha'),
    version: integer('version').notNull(),
  },
  // A key is unique within its Plan: a replaced Plan's Task may share a key with the new one (ADR-0019).
  // One Integration Task per (Plan, Repository); its key may equal a Plan Task's (ADR-0034).
  (t) => [
    uniqueIndex('tasks_plan_key')
      .on(t.planArtifactId, t.key)
      .where(sql`"kind" = 'plan'`),
    uniqueIndex('tasks_plan_integration')
      .on(t.planArtifactId, t.repositoryId)
      .where(sql`"kind" = 'integration'`),
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
    /**
     * A `foreign_push` Attempt's commits that someone else pushed (`{ sha,
     * subject, author }[]`, newest first; ADR-0042); null for every other Attempt.
     */
    foreignCommitsJson: text('foreign_commits_json'),
    /**
     * The approved commits a foreign rewrite this `foreign_push` Attempt adopted
     * dropped (`{ sha, subject, author }[]`, newest first; ADR-0042); null otherwise.
     */
    droppedCommitsJson: text('dropped_commits_json'),
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
    /** The shell command that ran. */
    command: text('command').notNull(),
    /** The Repository Profile command the entry named (ADR-0051); `null`: free shell. */
    commandName: text('command_name'),
    /** That command's arguments (a JSON array); `null` with `command_name`. */
    commandArgsJson: text('command_args_json'),
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

/**
 * One run of the Repository's setup command in a Worktree (ADR-0047), tied to
 * the `(head_sha, base_sha)` it ran on and the dependency files' hash. A
 * Worktree's setup runs again only when the latest one failed or that hash
 * changed. Not Evidence: a setup that passes proves nothing about the work.
 */
export const setupRuns = sqliteTable(
  'setup_runs',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    worktreeId: text('worktree_id')
      .notNull()
      .references(() => worktrees.id),
    command: text('command').notNull(),
    /** `null`: it timed out or was killed by a signal. */
    exitCode: integer('exit_code'),
    timedOut: integer('timed_out', { mode: 'boolean' }).notNull(),
    /** Exited 0 and left the Worktree as it found it (ADR-0047). */
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    /** Why it did not pass; `null` when it passed. */
    failure: text('failure'),
    dependencyHash: text('dependency_hash').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    startedAt: text('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    diskBytes: integer('disk_bytes'),
    outputArtifactId: text('output_artifact_id')
      .notNull()
      .references(() => artifacts.id),
  },
  (t) => [
    index('setup_runs_attempt').on(t.attemptId),
    index('setup_runs_worktree').on(t.worktreeId),
  ],
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
    /**
     * The approving Review this row re-anchors to its `(head_sha, base_sha)` after a base
     * merge-in left the diff unchanged (ADR-0041); no reviewer ran for it. Null otherwise.
     */
    reanchoredFromReviewId: text('reanchored_from_review_id').references(
      (): AnySQLiteColumn => reviews.id,
    ),
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
    /** Null only for an `issue_job` item (#112): it comes before the Job its decision creates. */
    jobId: text('job_id').references(() => jobs.id),
    taskId: text('task_id').references(() => tasks.id),
    /** The Stage Run it holds, when it holds one (`plan_approval` for a plan). */
    stageRunId: text('stage_run_id').references(() => stageRuns.id),
    /** `question | plan | spec_change | blocker | cleanup | merge | contract_job | issue_job`. */
    kind: text('kind').notNull(),
    subjectRef: text('subject_ref').notNull(),
    question: text('question').notNull(),
    why: text('why').notNull(),
    /** JSON array of `InboxQuestion`: a `question` item's (agent-proposed, redacted) or a `cleanup` item's (the factory's, ADR-0043); null otherwise. */
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
 * GitHub Issues intake (#112, ADR-0072): what the factory did with each issue
 * of a Repository, at most one row per issue. An intake Repository's labeled
 * issue is `offered` (its `issue_job` item open), then `job_created`,
 * `declined` or `cancelled` (closed or unlabeled first; offered again if it is
 * listed again). `job create --from-issue` records `job_created` too, so an
 * issue starts at most one Job. The title, body and URL are the issue as it
 * was when offered (GitHub content, untrusted, redacted); later edits are
 * never picked up.
 */
export const issueIntakes = sqliteTable(
  'issue_intakes',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    url: text('url').notNull(),
    /** `offered | job_created | declined | cancelled`. */
    state: text('state').notNull(),
    /** The current `issue_job` item; null for a `--from-issue` Job. */
    approvalId: text('approval_id').references(() => approvals.id),
    jobId: text('job_id').references(() => jobs.id),
    createdAt: text('created_at').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [
    uniqueIndex('issue_intakes_issue').on(t.repositoryId, t.number),
    uniqueIndex('issue_intakes_job').on(t.jobId),
  ],
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

/**
 * A pull request the factory opened (ARCHITECTURE §5, Phase C; ADR-0036): one
 * per (Job, Repository), from the Integration Branch to the default branch.
 * Written only by the runtime, in the transaction that records it with its
 * event. `pushed_sha` is the last head the factory pushed; `adopted` marks a
 * PR recovery found on the head branch carrying the Job's marker.
 */
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
    /** The Integration Task whose branch is the head. */
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    /** `open | closed | merged`. */
    state: text('state').notNull(),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    pushedSha: text('pushed_sha').notNull(),
    adopted: integer('adopted', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    /** When the poller last read it from GitHub (#58); null until then. Written without an event. */
    lastPolledAt: text('last_polled_at'),
    /** The merge commit, once the poller saw the PR merged (#58). */
    mergeSha: text('merge_sha'),
    /**
     * JSON array of the earlier PRs in Delivery Order (`owner/name#n`, or the
     * Repository's name when it had none) that had not merged when this one
     * was seen merged (#106, ADR-0066): an out-of-order merge, flagged in the
     * Delivery Report. Null when it merged in order, or has not merged.
     */
    mergedBeforeJson: text('merged_before_json'),
    /** GitHub's `mergeable_state` as last read; null until the poller read it. */
    mergeableState: text('mergeable_state'),
    /** When the factory first saw `head_sha` as the head: the checks grace window starts here. */
    headSeenAt: text('head_seen_at'),
    /** JSON array of the GitHub users whose latest review is `CHANGES_REQUESTED`. */
    changesRequestedJson: text('changes_requested_json').notNull().default('[]'),
    /** The Merge Gate (`MergeGate`) the poller last evaluated, and when; null before the first poll. */
    gateJson: text('gate_json'),
    gateEvaluatedAt: text('gate_evaluated_at'),
    /** SHA-256 of the body the factory last sent; it is PATCHed when the rendering differs. */
    bodySha256: text('body_sha256'),
    /**
     * The files the pushed head changes against its base, counted when the
     * factory last pushed it; 0 flags an empty delivery (never refused). Null
     * for a PR recorded before it was counted.
     */
    changedFiles: integer('changed_files'),
    /**
     * The PR opened in its place (`new_pr` on an `integration_rewrite` Blocker,
     * #65): this one was closed by the factory, so it no longer counts as the
     * Job's PR (no `pr_closed`, no polling, no Merge Gate). Null while current.
     */
    replacedById: text('replaced_by_id'),
    version: integer('version').notNull(),
  },
  (t) => [
    uniqueIndex('pull_requests_job_head').on(t.jobId, t.repositoryId, t.headBranch),
    uniqueIndex('pull_requests_repo_number').on(t.owner, t.name, t.number),
  ],
);

/**
 * A check GitHub reported on a PR head (#58, ADR-0037): a check run (the
 * newest of its name) or a commit status (the newest of its context). Written
 * only by the poller, and only when what it observed changed, in the
 * transaction of its event. Rows of an earlier head stay as history.
 */
export const prChecks = sqliteTable(
  'pr_checks',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id),
    headSha: text('head_sha').notNull(),
    /** `check_run | status`. */
    source: text('source').notNull(),
    name: text('name').notNull(),
    /** GitHub's own status (check run) or state (commit status), as read. */
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    /** `pending | success | neutral | skipped | failure` (`CheckOutcome`). */
    outcome: text('outcome').notNull(),
    url: text('url'),
    /** A check run's output summary (or title), a status's description: CI text, redacted (#61). */
    summary: text('summary'),
    /** The slug of the app that made a check run (`github-actions`), or null (a status; a row before #77). */
    app: text('app'),
    /** When the poller recorded this value. */
    observedAt: text('observed_at').notNull(),
  },
  (t) => [uniqueIndex('pr_checks_identity').on(t.pullRequestId, t.headSha, t.source, t.name)],
);

/**
 * Feedback on a factory PR (#60, ADR-0039): each review or comment the poller
 * classified (`trigger` or `context`; ignored text is not kept), and the
 * operator's `request_changes` on a `merge` item (`source: inbox`). The body
 * is redacted and stays untrusted GitHub text. `attempt_id` is the Rework
 * Attempt that carried it in its packet; `null` until one does.
 */
export const prFeedback = sqliteTable(
  'pr_feedback',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id),
    /** `review | issue_comment | review_comment | inbox`. */
    source: text('source').notNull(),
    /** GitHub's id of the review or comment; the Inbox Item's id for `inbox`. */
    externalId: text('external_id').notNull(),
    author: text('author'),
    reviewState: text('review_state'),
    path: text('path'),
    url: text('url'),
    /** `trigger | context`. */
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    /** When GitHub says it was written (or the Inbox decision's time). */
    createdAt: text('created_at').notNull(),
    observedAt: text('observed_at').notNull(),
    attemptId: text('attempt_id').references(() => attempts.id),
  },
  (t) => [uniqueIndex('pr_feedback_identity').on(t.pullRequestId, t.source, t.externalId)],
);

/**
 * The GitHub-wide state (#66, ADR-0045): one row, `id = 'github'`. While
 * `paused_until` is set and in the future, the runtime makes no GitHub API
 * call (a rate limit is capacity, not failure). Written only by the runtime,
 * with `github.paused`, `github.pause_extended` or `github.resumed` in the
 * same transaction.
 */
export const githubState = sqliteTable('github_state', {
  id: text('id').primaryKey(),
  /** GitHub's reset time; null while calls are made. */
  pausedUntil: text('paused_until'),
  /** When the pause in force started; null with no pause. */
  pausedAt: text('paused_at'),
  /** The HTTP status of the rate-limit response that set the pause (429 or 403). */
  pauseStatus: integer('pause_status'),
  updatedAt: text('updated_at').notNull(),
});
