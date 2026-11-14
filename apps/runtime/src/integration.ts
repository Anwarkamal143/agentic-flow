/**
 * The `integration` Stage (ARCHITECTURE §14, ADR-0034). Once every Plan Task
 * is approved, the factory creates one Integration Task per Repository (kind
 * `integration`, not part of the Plan) and queues the Stage. The Task
 * scheduler claims it like any Task; its first Attempt (cause `merge`) runs no
 * Harness: in the Factory Clone, under the clone's setup lock, the default
 * branch is fetched and the approved Task Branches are merged into it `--no-ff`
 * (one two-parent merge commit each, in {@link integrationOrder}), the result
 * becoming `factory/<job-id>/integration`. Then the factory verifies it like
 * any Attempt. A conflict is the human Blocker `base_merge_conflict` (replan,
 * cancel the Job); the automatic integration agent is an interface only
 * ({@link IntegrationConflictRoute}).
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  BlockerSchema,
  EffectiveConfigSchema,
  executionOutcome,
  INTEGRATION_TASK_KEY,
  integrationDefinition,
  integrationOrder,
  TaskDefinitionSchema,
  TaskStateSchema,
  type Blocker,
  type TaskDefinition,
} from '@factory/domain';
import { commitTree, mergeCommits } from '@factory/git';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  changeJob,
  readJobState,
  stepTask,
  type JobState,
  type StageRunStepper,
} from './engine.js';
import { newId } from './ids.js';
import { latestArtifact } from './plan-approval.js';
import { latestStageRun } from './replan.js';
import { releaseAttemptTokens } from './worktree.js';

type TaskRow = typeof schema.tasks.$inferSelect;

/**
 * How an integration conflict goes on. Phase C builds the human route only
 * (the `base_merge_conflict` Blocker); an integration agent that resolves the
 * conflict in a Harness Run is a later implementation of this interface
 * (ARCHITECTURE §14). Nothing implements it yet.
 */
export interface IntegrationConflictRoute {
  readonly kind: 'human' | 'integration_agent';
}

/** The Plan Tasks of `repositoryId` in the Job's newest Plan, in Plan order. */
function planTasksOf(tx: Tx | FactoryDb, jobId: string, repositoryId: string): TaskRow[] {
  const plan = latestArtifact(tx, jobId, 'plan');
  return tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        eq(schema.tasks.kind, 'plan'),
        eq(schema.tasks.planArtifactId, plan?.id ?? ''),
        eq(schema.tasks.repositoryId, repositoryId),
      ),
    )
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
}

/**
 * `execution` succeeded: queues the Job's pending `integration` Stage Run and
 * creates one Integration Task (`ready`) per Repository its newest Plan has
 * Tasks in, with the definition the domain derives from them. In the
 * transaction that ends `execution`. `false` when the Workflow Snapshot has no
 * `integration` Stage (a Job created at `feature` v2): closure follows instead.
 */
export function startIntegration(
  tx: Tx,
  jobId: string,
  step: StageRunStepper,
  actor: string,
): boolean {
  const state = readJobState(tx, jobId);
  const integration = latestStageRun(state, 'integration');
  if (integration?.state !== 'pending') return false;
  const plan = latestArtifact(tx, jobId, 'plan');
  if (plan === undefined) throw new Error(`Job ${jobId} integrates without a Plan`);
  const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
  const repositories = tx
    .select({ id: schema.jobRepositories.repositoryId })
    .from(schema.jobRepositories)
    .where(eq(schema.jobRepositories.jobId, jobId))
    .all();
  step(integration, 'queued', { reason: 'every Plan Task is approved' });
  for (const repo of repositories) {
    const planTasks = planTasksOf(tx, jobId, repo.id);
    if (planTasks.length === 0) continue;
    const definition: TaskDefinition = integrationDefinition(
      planTasks.map((t) => ({
        key: t.key,
        definition: TaskDefinitionSchema.parse(JSON.parse(t.definitionJson)),
      })),
    );
    const id = newId('tsk');
    tx.insert(schema.tasks)
      .values({
        id,
        jobId,
        repositoryId: repo.id,
        planArtifactId: plan.id,
        kind: 'integration',
        key: INTEGRATION_TASK_KEY,
        title: `Integrate ${String(planTasks.length)} Task Branch${planTasks.length === 1 ? '' : 'es'} into the Integration Branch`,
        definitionJson: JSON.stringify(TaskDefinitionSchema.parse(definition)),
        state: 'ready',
        priority: 0,
        maxAttempts: config.maxAttempts.value,
        maxRetries: config.maxRetries.value,
        maxQuestions: config.maxQuestions.value,
        version: 0,
      })
      .run();
    appendEvent(tx, {
      entityKind: 'task',
      entityId: id,
      jobId,
      type: 'task.created',
      actor,
      payload: {
        key: INTEGRATION_TASK_KEY,
        kind: 'integration',
        state: 'ready',
        repositoryId: repo.id,
        planArtifactId: plan.id,
        integrates: planTasks.map((t) => t.key),
      },
    });
  }
  return true;
}

/**
 * Ends the `integration` Stage once no Integration Task is in progress, by the
 * keep-going rule `execution` uses (`executionOutcome`): `succeeded` (closure
 * queued) when every one is approved, `waiting_human` or `blocked` on the first
 * Blocker, else `failed` (closure queued for the partial results). Only the
 * Integration Tasks of the newest Plan count.
 */
export function settleIntegration(tx: Tx, state: JobState, step: StageRunStepper): void {
  const integration = latestStageRun(state, 'integration');
  if (integration?.state !== 'running') return;
  const plan = latestArtifact(tx, state.job.id, 'plan');
  const tasks = tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, state.job.id),
        eq(schema.tasks.kind, 'integration'),
        eq(schema.tasks.planArtifactId, plan?.id ?? ''),
      ),
    )
    .orderBy(asc(sql`rowid`))
    .all();
  const outcome = executionOutcome(
    tasks.map((t) => ({
      key: t.key,
      state: TaskStateSchema.parse(t.state),
      blocker: t.blockerJson === null ? null : BlockerSchema.parse(JSON.parse(t.blockerJson)),
    })),
  );
  const queueClosure = () => {
    const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
    if (closure !== undefined) step(closure, 'queued');
  };
  switch (outcome.kind) {
    case 'running':
    case 'unchanged':
      return;
    case 'waiting_human':
    case 'blocked':
      step(integration, outcome.kind, { blocker: outcome.blocker });
      return;
    case 'failed':
      step(integration, 'failed', {
        failure: {
          reason: 'task_failed',
          message: `the Integration Task failed, with no Rework route`,
          issues: [],
        },
      });
      queueClosure();
      return;
    case 'succeeded':
      step(integration, 'succeeded');
      queueClosure();
      return;
  }
}

/** One approved Task Branch to merge: the Plan Task and the head its passing Attempt was approved on. */
export interface IntegrationSource {
  key: string;
  taskId: string;
  branch: string;
  headSha: string;
}

/**
 * The approved Task Branches of the Integration Task's Repository, in merge
 * order (topological, ties by key). Throws when a Plan Task is not approved:
 * `integration` starts only once all of them are.
 */
export function integrationSources(db: FactoryDb, task: TaskRow): IntegrationSource[] {
  const planTasks = planTasksOf(db, task.jobId, task.repositoryId);
  const edges = db
    .select({ taskId: schema.taskDependencies.taskId, on: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.jobId, task.jobId))
    .all();
  const keyOf = (id: string) => planTasks.find((t) => t.id === id)?.key;
  const order = integrationOrder(
    planTasks.map((t) => ({
      key: t.key,
      dependsOn: edges
        .filter((e) => e.taskId === t.id)
        .flatMap((e) => {
          const key = keyOf(e.on);
          return key === undefined ? [] : [key];
        }),
    })),
  );
  return order.map((key) => {
    const t = planTasks.find((p) => p.key === key);
    if (t === undefined) throw new Error(`no Plan Task ${key}`);
    if (t.state !== 'approved' && t.state !== 'integrated') {
      throw new Error(`Task ${t.key} is ${t.state}, not approved: it can't be integrated`);
    }
    const passed = db
      .select({ headSha: schema.attempts.headSha, worktreeId: schema.attempts.worktreeId })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, t.id), eq(schema.attempts.state, 'passed')))
      .orderBy(desc(schema.attempts.n))
      .get();
    if (passed?.headSha == null) throw new Error(`approved Task ${t.key} has no passed Attempt`);
    const worktree = db
      .select({ branch: schema.worktrees.branch })
      .from(schema.worktrees)
      .where(eq(schema.worktrees.id, passed.worktreeId))
      .get();
    if (worktree === undefined) throw new Error(`approved Task ${t.key} has no Worktree`);
    return { key: t.key, taskId: t.id, branch: worktree.branch, headSha: passed.headSha };
  });
}

export type IntegrationMerge =
  | { kind: 'merged'; headSha: string; merged: string[] }
  | {
      kind: 'conflict';
      /** The Task Branches already merged cleanly before the conflict. */
      merged: string[];
      /** The Task Branch whose merge conflicts. */
      conflicting: IntegrationSource;
      paths: string[];
    };

/**
 * Merges `sources`, in order, onto `baseSha` in `clone`: one merge commit per
 * Task Branch with parents (the result so far, its approved head), even where
 * a fast-forward was possible (`--no-ff`). Only objects are written: no ref,
 * index or Worktree is touched. Call under the clone's setup lock.
 */
export async function mergeTaskBranches(
  clone: string,
  input: { baseSha: string; integrationBranch: string; sources: readonly IntegrationSource[] },
): Promise<IntegrationMerge> {
  let head = input.baseSha;
  const merged: string[] = [];
  for (const source of input.sources) {
    const result = await mergeCommits(clone, head, source.headSha);
    if (result.kind === 'conflict') {
      return { kind: 'conflict', merged, conflicting: source, paths: result.paths };
    }
    head = await commitTree(
      clone,
      result.tree,
      [head, source.headSha],
      `Merge ${source.branch} (Task ${source.key}) into ${input.integrationBranch}\n\nFactory-Integration: ${source.key}`,
    );
    merged.push(source.key);
  }
  return { kind: 'merged', headSha: head, merged };
}

/**
 * Blocks the `claimed` Integration Task whose merge conflicts, in one
 * transaction: the `base_merge_conflict` Blocker (its Blocker Approval opened
 * by `stepTask`, with the conflict in its text, so a Replan from it carries
 * the conflict as feedback), its lease and capacity tokens released, and
 * `integration` settled. No Attempt or Worktree was made: the Blocker names the
 * Task itself as its subject.
 */
export function blockOnIntegrationConflict(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  conflict: Extract<IntegrationMerge, { kind: 'conflict' }> & {
    baseSha: string;
    integrationBranch: string;
  },
  settle: (tx: Tx, state: JobState, step: StageRunStepper) => void,
): void {
  changeJob(
    db,
    { jobId: op.jobId, expectedVersion: 'current', actor: op.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'claimed')
        throw new Error(`Task ${taskId} is ${String(task?.state)}, not claimed`);
      const where = conflict.paths.length === 0 ? 'the merge' : conflict.paths.join(', ');
      const before =
        conflict.merged.length === 0
          ? 'onto the freshly fetched base'
          : `after ${conflict.merged.join(', ')} merged cleanly`;
      const blocker: Blocker = {
        kind: 'human',
        reason: 'base_merge_conflict',
        detail: `merging Task Branch ${conflict.conflicting.branch} (Task ${conflict.conflicting.key}, head ${conflict.conflicting.headSha}) into ${conflict.integrationBranch} from base ${conflict.baseSha} ${before} conflicts in ${where}`,
        requiredAction:
          'decide the Blocker Approval in the Inbox: replan (the conflict becomes the feedback) or cancel the Job',
        taskId,
        attemptId: taskId,
        createdAt: new Date().toISOString(),
      };
      stepTask(tx, op, task, 'blocked', {
        reason: blocker.reason,
        payload: {
          conflicting: conflict.conflicting.key,
          merged: conflict.merged,
          paths: conflict.paths,
          baseSha: conflict.baseSha,
        },
        blocker,
      });
      releaseAttemptTokens(tx, taskId, undefined);
      settle(tx, state, step);
    },
  );
}

/**
 * Cancels the Job's unfinished Integration Tasks (reason `replan`) when a new
 * Plan is stored: the Integration Task is never carried over; a new one
 * rebuilds the branch once the new Plan's Tasks are approved (Phase C grilling
 * Q25). Its Worktree stays preserved, its branch and Attempt heads kept.
 */
export function cancelIntegrationTasks(
  tx: Tx,
  op: { jobId: string; actor: string },
  cancelItems: (taskId: string) => void,
): void {
  const open = tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, op.jobId),
        eq(schema.tasks.kind, 'integration'),
        inArray(schema.tasks.state, [
          'pending',
          'ready',
          'blocked',
          'changes_requested',
          'approved',
        ]),
      ),
    )
    .all();
  for (const task of open) {
    stepTask(tx, op, task, 'cancelled', {
      reason: 'replan',
      cancelReason: 'replan',
      payload: { why: 'the Integration Task is never carried over; a new one rebuilds the branch' },
    });
    cancelItems(task.id);
  }
}
