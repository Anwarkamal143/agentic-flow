/**
 * The only way Job and Stage Run state changes (ARCHITECTURE §4.5). Each
 * operation is one `BEGIN IMMEDIATE` transaction: an optimistic version check,
 * then the guards, then the state updates, then the events (the outbox).
 *
 * Lives in the runtime until the Stage handlers arrive; then it moves to
 * `packages/engine` (ADR-0005).
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  canTransitionStageRun,
  canTransitionTask,
  dependentsToCancel,
  TaskStateSchema,
  type TaskCancelReason,
  type TaskState,
  type AttemptState,
  type WorktreeState,
  deriveJobStatus,
  FINISHED_STAGE_RUN_STATES,
  StageIdSchema,
  StageRunStateSchema,
  type JobStatus,
  type Blocker,
  type StageFailure,
  type StageRunState,
} from '@factory/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { openBlockerItem } from './blocker-approvals.js';
import { ApiFailure } from './errors.js';

/** A Job's row and its Stage Runs, as read inside a transaction. */
export interface JobState {
  readonly job: typeof schema.jobs.$inferSelect;
  readonly stageRuns: (typeof schema.stageRuns.$inferSelect)[];
}

export interface JobOperation {
  jobId: string;
  /** The Job version the caller saw, or `current` for the factory's own decisions. */
  expectedVersion: number | 'current';
  actor: string;
}

/**
 * Runs `body` as one versioned change to a Job. The Job's version is checked
 * and bumped first; a stale version fails with 409 `version_conflict` and
 * nothing is written. Afterwards the Job status is re-derived from its Stage
 * Runs and stored, with a `job.status_changed` event when it changed.
 */
export function changeJob<T>(
  db: FactoryDb,
  op: JobOperation,
  body: (tx: Tx, state: JobState, step: StageRunStepper) => T,
): T {
  return db.transaction((tx) => changeJobIn(tx, op, body), { behavior: 'immediate' });
}

/** {@link changeJob} inside a transaction the caller already holds. */
export function changeJobIn<T>(
  tx: Tx,
  op: JobOperation,
  body: (tx: Tx, state: JobState, step: StageRunStepper) => T,
): T {
  const current = tx.select().from(schema.jobs).where(eq(schema.jobs.id, op.jobId)).get();
  if (current === undefined) {
    throw new ApiFailure(404, 'job_not_found', `no Job ${op.jobId}`);
  }
  const expected = op.expectedVersion === 'current' ? current.version : op.expectedVersion;
  const bumped = tx
    .update(schema.jobs)
    .set({ version: sql`${schema.jobs.version} + 1` })
    .where(and(eq(schema.jobs.id, op.jobId), eq(schema.jobs.version, expected)))
    .run();
  if (bumped.changes !== 1) {
    throw new ApiFailure(
      409,
      'version_conflict',
      `Job ${op.jobId} is at version ${String(current.version)}, not ${String(expected)}. Re-read it and decide again`,
    );
  }
  const state = readJobState(tx, op.jobId);
  const step = stageRunStepper(tx, op.jobId, op.actor);
  const result = body(tx, state, step);

  const runs = readJobState(tx, op.jobId).stageRuns;
  const status = deriveJobStatus(
    runs.map((r) => ({
      stageId: StageIdSchema.parse(r.stageId),
      state: StageRunStateSchema.parse(r.state),
    })),
  );
  if (status !== current.status) {
    tx.update(schema.jobs).set({ status }).where(eq(schema.jobs.id, op.jobId)).run();
    appendEvent(tx, {
      entityKind: 'job',
      entityId: op.jobId,
      jobId: op.jobId,
      type: 'job.status_changed',
      actor: op.actor,
      payload: { from: current.status, to: status satisfies JobStatus },
    });
  }
  return result;
}

export function readJobState(tx: Tx | FactoryDb, jobId: string): JobState {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new ApiFailure(404, 'job_not_found', `no Job ${jobId}`);
  const stageRuns = tx
    .select()
    .from(schema.stageRuns)
    .where(eq(schema.stageRuns.jobId, jobId))
    .orderBy(asc(schema.stageRuns.position), asc(schema.stageRuns.attempt))
    .all();
  return { job, stageRuns };
}

/**
 * Moves one Stage Run of the Job being changed, writing its event. A `failure`
 * is stored on the Stage Run (only with `to: failed`); a `blocker` (only with
 * `to: blocked | waiting_human`) is stored with the Stage Run itself as the
 * Stage to resume once it is cleared.
 */
export type StageRunStepper = (
  run: typeof schema.stageRuns.$inferSelect,
  to: StageRunState,
  opts?: { reason?: string | undefined; failure?: StageFailure; blocker?: Blocker },
) => void;

function stageRunStepper(tx: Tx, jobId: string, actor: string): StageRunStepper {
  return (run, to, opts = {}) => {
    const { failure, blocker } = opts;
    const reason = opts.reason ?? failure?.reason ?? blocker?.reason;
    if (failure !== undefined && to !== 'failed') {
      throw new Error(`a failure is recorded only when a Stage Run fails (${run.id} → ${to})`);
    }
    if (blocker !== undefined && to !== 'blocked' && to !== 'waiting_human') {
      throw new Error(`a Blocker is recorded only when a Stage Run stops (${run.id} → ${to})`);
    }
    const from = StageRunStateSchema.parse(run.state);
    if (!canTransitionStageRun(from, to)) {
      throw new Error(`illegal Stage Run transition ${from} → ${to} (${run.id})`);
    }
    const now = new Date().toISOString();
    const updated = tx
      .update(schema.stageRuns)
      .set({
        state: to,
        version: sql`${schema.stageRuns.version} + 1`,
        ...(to === 'running' ? { startedAt: now } : {}),
        ...(isFinished(to) ? { finishedAt: now } : {}),
        ...(failure === undefined ? {} : { failureJson: JSON.stringify(failure) }),
        ...(blocker === undefined
          ? {}
          : { blockerJson: JSON.stringify(blocker), resumeStageId: run.stageId }),
      })
      .where(
        and(
          eq(schema.stageRuns.id, run.id),
          eq(schema.stageRuns.state, from),
          eq(schema.stageRuns.version, run.version),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      // The Job version check above makes this unreachable unless a writer bypassed it.
      throw new Error(`Stage Run ${run.id} changed under a versioned Job operation`);
    }
    appendEvent(tx, {
      entityKind: 'stage_run',
      entityId: run.id,
      jobId,
      type: `stage_run.${to}`,
      actor,
      payload: {
        stageId: run.stageId,
        from,
        to,
        ...(reason === undefined ? {} : { reason }),
        ...(failure === undefined ? {} : { failure }),
        ...(blocker === undefined ? {} : { blocker }),
      },
    });
  };
}

function isFinished(state: StageRunState): boolean {
  return FINISHED_STAGE_RUN_STATES.includes(state);
}

type TaskRow = typeof schema.tasks.$inferSelect;

/**
 * Moves one Task of the Job being changed (call inside {@link changeJob}, which
 * has already bumped the Job version), writing its `task.<to>` event. The
 * update is guarded by the Task's state and version; zero rows is a conflict.
 * A Task goes `blocked` with its `blocker`, which is cleared when it leaves;
 * a human Blocker with options opens its Blocker Approval in the same
 * transaction (ADR-0026). A Task going `cancelled` records its `cancelReason`.
 * A Task going `failed` cancels its unfinished dependents, transitively, with
 * reason `dependency_failed` in the same transaction, one event each (ADR-0028).
 */
export function stepTask(
  tx: Tx,
  op: { jobId: string; actor: string },
  task: TaskRow,
  to: TaskState,
  opts: {
    reason?: string | undefined;
    payload?: Record<string, unknown>;
    blocker?: Blocker;
    cancelReason?: TaskCancelReason;
  } = {},
): TaskRow {
  const from = TaskStateSchema.parse(task.state);
  if (!canTransitionTask(from, to)) {
    throw new Error(`illegal Task transition ${from} → ${to} (${task.id})`);
  }
  if ((opts.blocker === undefined) !== (to !== 'blocked')) {
    throw new Error(`a Task is blocked with a Blocker, and only then (${task.id} → ${to})`);
  }
  if (opts.cancelReason !== undefined && to !== 'cancelled') {
    throw new Error(
      `a cancel reason is recorded only when a Task is cancelled (${task.id} → ${to})`,
    );
  }
  const blockerJson = opts.blocker === undefined ? null : JSON.stringify(opts.blocker);
  const cancelReason = opts.cancelReason ?? null;
  const updated = tx
    .update(schema.tasks)
    .set({
      state: to,
      blockerJson,
      ...(to === 'cancelled' ? { cancelReason } : {}),
      version: sql`${schema.tasks.version} + 1`,
    })
    .where(
      and(
        eq(schema.tasks.id, task.id),
        eq(schema.tasks.state, from),
        eq(schema.tasks.version, task.version),
      ),
    )
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Task ${task.id} changed under a versioned Job operation`);
  }
  appendEvent(tx, {
    entityKind: 'task',
    entityId: task.id,
    jobId: op.jobId,
    type: `task.${to}`,
    actor: op.actor,
    payload: {
      key: task.key,
      from,
      to,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
      ...(opts.blocker === undefined ? {} : { blocker: opts.blocker }),
      ...(opts.cancelReason === undefined ? {} : { cancelReason: opts.cancelReason }),
      ...opts.payload,
    },
  });
  if (opts.blocker !== undefined) openBlockerItem(tx, op, task, opts.blocker);
  if (to === 'failed') cancelDependents(tx, op, task);
  return {
    ...task,
    state: to,
    blockerJson,
    ...(to === 'cancelled' ? { cancelReason } : {}),
    version: task.version + 1,
  };
}

/**
 * Cancels every unfinished Task that depends on the just-failed `failed`,
 * directly or transitively (`dependency_failed`, ARCHITECTURE §4.4): they can
 * never start. Only `pending` Tasks can be found here, since a dependent is
 * `ready` only once all it depends on is approved.
 */
function cancelDependents(tx: Tx, op: { jobId: string; actor: string }, failed: TaskRow): void {
  const tasks = tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, op.jobId))
    .orderBy(asc(sql`rowid`))
    .all();
  const edges = tx
    .select({ taskId: schema.taskDependencies.taskId, on: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.jobId, op.jobId))
    .all();
  const doomed = dependentsToCancel(
    failed.id,
    tasks.map((t) => ({
      id: t.id,
      state: TaskStateSchema.parse(t.state),
      dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.on),
    })),
  );
  for (const id of doomed) {
    const row = tasks.find((t) => t.id === id);
    if (row === undefined) continue;
    stepTask(tx, op, row, 'cancelled', {
      reason: 'dependency_failed',
      cancelReason: 'dependency_failed',
      payload: { failedTask: failed.key, failedTaskId: failed.id },
    });
  }
}

/**
 * Moves one Attempt of the Job being changed (inside {@link changeJob}),
 * guarded by its state and version, with its `attempt.<state>` event.
 */
export function stepAttempt(
  tx: Tx,
  op: { jobId: string; actor: string },
  id: string,
  from: AttemptState,
  values: Partial<typeof schema.attempts.$inferInsert> & { state: AttemptState },
  payload: Record<string, unknown> = {},
): void {
  const row = tx.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (row?.state !== from) throw new Error(`Attempt ${id} is ${String(row?.state)}, not ${from}`);
  const updated = tx
    .update(schema.attempts)
    .set({ ...values, version: sql`${schema.attempts.version} + 1` })
    .where(and(eq(schema.attempts.id, id), eq(schema.attempts.version, row.version)))
    .run();
  if (updated.changes !== 1)
    throw new Error(`Attempt ${id} changed under a versioned Job operation`);
  appendEvent(tx, {
    entityKind: 'attempt',
    entityId: id,
    jobId: op.jobId,
    type: `attempt.${values.state}`,
    actor: op.actor,
    payload: { taskId: row.taskId, n: row.n, from, to: values.state, ...payload },
  });
}

/** Moves one Worktree of the Job being changed, guarded by its state, with its `worktree.<to>` event. */
export function stepWorktree(
  tx: Tx,
  op: { jobId: string; actor: string },
  row: typeof schema.worktrees.$inferSelect,
  from: WorktreeState,
  to: WorktreeState,
  extra: Record<string, unknown> = {},
): void {
  const updated = tx
    .update(schema.worktrees)
    .set({ state: to })
    .where(and(eq(schema.worktrees.id, row.id), eq(schema.worktrees.state, from)))
    .run();
  if (updated.changes !== 1) throw new Error(`Worktree ${row.id} is ${row.state}, not ${from}`);
  appendEvent(tx, {
    entityKind: 'worktree',
    entityId: row.id,
    jobId: op.jobId,
    type: `worktree.${to}`,
    actor: op.actor,
    payload: { taskId: row.taskId, from, to, path: row.path, branch: row.branch, ...extra },
  });
}
