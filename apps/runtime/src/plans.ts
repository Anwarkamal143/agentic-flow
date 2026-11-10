/**
 * A Job's Plans, whoever wrote them (ADR-0019): the context a Plan is
 * validated against, the Task rows a stored Plan defines, and the Replan
 * request a planning Stage Run answers. The planner's Plan (scheduler.ts) and a
 * human's Plan Edit (inbox.ts) go through the same code.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  EffectiveConfigSchema,
  InboxDecisionSchema,
  initialTaskState,
  TASK_PRIORITY_WEIGHT,
  TaskDefinitionSchema,
  type PlanContext,
  type PlanProposal,
  type TaskDefinition,
} from '@factory/domain';
import { git, resolveCommit } from '@factory/git';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { stepTask } from './engine.js';
import { newId } from './ids.js';

export interface JobRepository {
  id: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
}

export function repositoriesOf(db: FactoryDb | Tx, jobId: string): JobRepository[] {
  return db
    .select({
      id: schema.repositories.id,
      name: schema.repositories.name,
      clonePath: schema.repositories.clonePath,
      defaultBranch: schema.repositories.defaultBranch,
    })
    .from(schema.jobRepositories)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.jobRepositories.repositoryId))
    .where(eq(schema.jobRepositories.jobId, jobId))
    .all();
}

/**
 * What a Plan is validated against: the Specification's criteria, the
 * Effective Configuration's `maxAttempts`, and (unless `trackedFiles` is
 * false) the tracked files at the planning base of each Repository.
 */
export async function planContextOf(
  db: FactoryDb,
  jobId: string,
  repositories: readonly JobRepository[],
  opts: { trackedFiles: boolean } = { trackedFiles: true },
): Promise<PlanContext> {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new Error(`no Job ${jobId}`);
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const trackedFiles = new Map<string, readonly string[]>();
  if (opts.trackedFiles) {
    for (const repo of repositories) trackedFiles.set(repo.id, await planningBaseFiles(repo));
  }
  return {
    repositories,
    criteria: db
      .select()
      .from(schema.acceptanceCriteria)
      .where(eq(schema.acceptanceCriteria.jobId, jobId))
      .all(),
    maxAttempts: config.maxAttempts.value,
    trackedFiles,
  };
}

/**
 * The tracked files at the planning base: the commit a Task's Worktree would
 * start from (the default branch, as fetched, in the Factory Clone; never the
 * user's checkout). Empty when the clone has no such branch.
 */
export async function planningBaseFiles(repo: JobRepository): Promise<string[]> {
  const base =
    (await resolveCommit(repo.clonePath, `refs/remotes/origin/${repo.defaultBranch}`)) ??
    (await resolveCommit(repo.clonePath, `refs/heads/${repo.defaultBranch}`));
  if (base === undefined) return [];
  const out = await git(['ls-tree', '-r', '-z', '--name-only', base], { cwd: repo.clonePath });
  return out.split('\0').filter((p) => p !== '');
}

/** Writes the Task rows (and their dependencies) a validated, stored Plan defines. */
export function persistPlanTasks(
  tx: Tx,
  plan: PlanProposal,
  ctx: { jobId: string; artifactId: string; actor: string },
): void {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, ctx.jobId)).get();
  if (job === undefined) throw new Error(`no Job ${ctx.jobId}`);
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const repositories = repositoriesOf(tx, ctx.jobId);
  const ids = new Map(plan.tasks.map((t) => [t.key, newId('tsk')]));
  for (const task of plan.tasks) {
    const repo = repositories.find((r) => r.id === task.repository || r.name === task.repository);
    if (repo === undefined) throw new Error(`validated Task ${task.key} has no Repository`);
    const id = taskId(ids, task.key);
    const state = initialTaskState(task.dependsOn);
    tx.insert(schema.tasks)
      .values({
        id,
        jobId: ctx.jobId,
        repositoryId: repo.id,
        planArtifactId: ctx.artifactId,
        key: task.key,
        title: task.title,
        definitionJson: JSON.stringify(
          TaskDefinitionSchema.parse({
            objective: task.objective,
            role: task.role,
            risk: task.risk,
            scope: task.scope,
            dependsOn: task.dependsOn,
            acceptance: task.acceptance,
            verification: task.verification,
          } satisfies TaskDefinition),
        ),
        state,
        priority: TASK_PRIORITY_WEIGHT[task.priority],
        maxAttempts: task.maxAttempts ?? config.maxAttempts.value,
        maxRetries: config.maxRetries.value,
        maxQuestions: config.maxQuestions.value,
        version: 0,
      })
      .run();
    appendEvent(tx, {
      entityKind: 'task',
      entityId: id,
      jobId: ctx.jobId,
      type: 'task.created',
      actor: ctx.actor,
      payload: { key: task.key, state, repositoryId: repo.id, planArtifactId: ctx.artifactId },
    });
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      tx.insert(schema.taskDependencies)
        .values({ taskId: taskId(ids, task.key), dependsOnTaskId: taskId(ids, dep) })
        .run();
    }
  }
}

/**
 * Cancels the Tasks of a Plan that is replaced before it ran (an edit or a
 * Replan at `plan_approval`), with `reason`. Only `pending` and `ready` Tasks
 * exist then: nothing is dispatched before the Plan is approved.
 */
export function cancelPlanTasks(
  tx: Tx,
  op: { jobId: string; actor: string },
  planArtifactId: string,
  reason: string,
): void {
  const open = tx
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, op.jobId),
        eq(schema.tasks.planArtifactId, planArtifactId),
        inArray(schema.tasks.state, ['pending', 'ready']),
      ),
    )
    .all();
  for (const task of open) stepTask(tx, op, task, 'cancelled', { reason });
}

/** What a planning Stage Run re-plans from: the Plan it replaces and the human's feedback. */
export interface ReplanRequest {
  planArtifactId: string;
  feedback: string;
}

/**
 * The Replan a planning Stage Run answers, read from what is stored: the Job's
 * newest plan Inbox Item, when a human decided it `request_changes`. A first
 * planning Stage Run has none. Read again on every Harness Run, so a restarted
 * runtime re-plans from the same request and never regenerates it.
 */
export function replanRequestOf(db: FactoryDb | Tx, jobId: string): ReplanRequest | undefined {
  const item = db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, 'plan')))
    .orderBy(desc(sql`"approvals"."rowid"`))
    .limit(1)
    .get();
  if (item?.state !== 'decided' || item.decisionJson === null) return undefined;
  const decision = InboxDecisionSchema.parse(JSON.parse(item.decisionJson));
  if (decision.option !== 'request_changes' || decision.comment === null) return undefined;
  return { planArtifactId: item.subjectRef, feedback: decision.comment };
}

/** The id given to a validated Plan's Task key (the validator guarantees it exists). */
function taskId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`the validated Plan has no Task ${key}`);
  return id;
}
