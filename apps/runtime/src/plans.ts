/**
 * A Job's Plans, whoever wrote them (ADR-0019): the context a Plan is
 * validated against, the Task rows a stored Plan defines, and the Replan
 * request a planning Stage Run answers. The planner's Plan (scheduler.ts) and a
 * human's Plan Edit (inbox.ts) go through the same code.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  approvalStillHolds,
  BlockerSchema,
  decideCarryOver,
  EffectiveConfigSchema,
  InboxDecisionSchema,
  PlanTaskProposalSchema,
  ReplanRequestContentSchema,
  TASK_PRIORITY_WEIGHT,
  TaskDefinitionSchema,
  TaskStateSchema,
  type PlanContext,
  type PlanProposal,
  type PlanTaskProposal,
  type TaskDefinition,
} from '@factory/domain';
import { git, resolveCommit } from '@factory/git';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { currentCriteria } from './criteria.js';
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
 * What a Plan is validated against: the current Specification's criteria, the
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
    criteria: currentCriteria(db, jobId),
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

/** Reads a stored Plan by its Artifact id (the planner's or a human's). */
export type PlanReader = (artifactId: string) => PlanProposal;

/**
 * Writes the Task rows (and their dependencies) a validated, stored Plan
 * defines, after the carry-over (ARCHITECTURE §4.7, ADR-0029): each of the
 * Job's Tasks the new Plan leaves unaffected is kept (its id, Task Branch,
 * Worktree, Attempts and cap counts) and moved onto the new Plan; every
 * other unfinished one is cancelled, with its open Inbox Items, its Worktree
 * left preserved; every entry nothing carries becomes a new Task.
 */
export function persistPlanTasks(
  tx: Tx,
  plan: PlanProposal,
  ctx: { jobId: string; artifactId: string; actor: string; readPlan: PlanReader },
): void {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, ctx.jobId)).get();
  if (job === undefined) throw new Error(`no Job ${ctx.jobId}`);
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const repositories = repositoriesOf(tx, ctx.jobId);
  const repoOf = (ref: string) => repositories.find((r) => r.id === ref || r.name === ref);
  const normalized = (entry: PlanTaskProposal): PlanTaskProposal =>
    PlanTaskProposalSchema.parse({
      ...entry,
      repository: repoOf(entry.repository)?.id ?? entry.repository,
    });
  const op = { jobId: ctx.jobId, actor: ctx.actor };

  const current = tx
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, ctx.jobId))
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
  const plans = new Map<string, PlanProposal>();
  const entryOf = (row: TaskRow): PlanTaskProposal => {
    let stored = plans.get(row.planArtifactId);
    if (stored === undefined) {
      stored = ctx.readPlan(row.planArtifactId);
      plans.set(row.planArtifactId, stored);
    }
    const entry = stored.tasks.find((t) => t.key === row.key);
    if (entry === undefined) throw new Error(`Plan ${row.planArtifactId} has no Task ${row.key}`);
    return normalized(entry);
  };
  const decision = decideCarryOver(
    current.map((row) => ({
      id: row.id,
      key: row.key,
      state: TaskStateSchema.parse(row.state),
      entry: entryOf(row),
      approvalHolds: row.state === 'approved' && approvalHolds(tx, row.id),
      resolvedByReplan: row.state === 'blocked' && resolvedByReplan(tx, row),
    })),
    plan.tasks.map(normalized),
  );
  const rowOf = (id: string) => {
    const row = current.find((t) => t.id === id);
    if (row === undefined) throw new Error(`no Task ${id}`);
    return row;
  };

  for (const c of decision.cancelled) {
    stepTask(tx, op, rowOf(c.taskId), 'cancelled', {
      reason: 'replan',
      cancelReason: 'replan',
      payload: { why: c.why, planArtifactId: ctx.artifactId },
    });
    cancelTaskItems(tx, op, c.taskId);
  }
  const ids = new Map<string, string>();
  for (const c of decision.carried) {
    ids.set(c.key, c.taskId);
    const row = rowOf(c.taskId);
    tx.update(schema.tasks)
      .set({ planArtifactId: ctx.artifactId, version: sql`${schema.tasks.version} + 1` })
      .where(and(eq(schema.tasks.id, row.id), eq(schema.tasks.version, row.version)))
      .run();
    appendEvent(tx, {
      entityKind: 'task',
      entityId: row.id,
      jobId: ctx.jobId,
      type: 'task.carried_over',
      actor: ctx.actor,
      payload: {
        key: row.key,
        from: c.from,
        to: c.to,
        planArtifactId: ctx.artifactId,
        replacedPlanArtifactId: row.planArtifactId,
      },
    });
    if (c.to !== c.from) {
      const moved = tx.select().from(schema.tasks).where(eq(schema.tasks.id, row.id)).get();
      if (moved === undefined) throw new Error(`no Task ${row.id}`);
      stepTask(tx, op, moved, c.to, { reason: 'dependencies_approved' });
    }
  }
  const created = new Map(decision.created.map((c) => [c.key, c] as const));
  for (const c of decision.created) ids.set(c.key, newId('tsk'));

  for (const task of plan.tasks) {
    const made = created.get(task.key);
    if (made === undefined) continue;
    const repo = repoOf(task.repository);
    if (repo === undefined) throw new Error(`validated Task ${task.key} has no Repository`);
    const id = taskId(ids, task.key);
    const state = made.state;
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
      payload: {
        key: task.key,
        state,
        repositoryId: repo.id,
        planArtifactId: ctx.artifactId,
        ...(made.replaces === null ? {} : { replaces: made.replaces }),
      },
    });
    for (const dep of task.dependsOn) {
      tx.insert(schema.taskDependencies)
        .values({ taskId: id, dependsOnTaskId: taskId(ids, dep) })
        .run();
    }
  }
}

type TaskRow = typeof schema.tasks.$inferSelect;

/** Whether an approved Task's approval still holds: its last Attempt's Evidence and review match its SHAs. */
function approvalHolds(tx: Tx, taskId: string): boolean {
  const attempt = tx
    .select()
    .from(schema.attempts)
    .where(eq(schema.attempts.taskId, taskId))
    .orderBy(desc(schema.attempts.n))
    .limit(1)
    .get();
  if (attempt === undefined) return false;
  return approvalStillHolds({
    attempt: { state: attempt.state, headSha: attempt.headSha, baseSha: attempt.baseSha },
    evidence: tx
      .select({ headSha: schema.evidence.headSha, baseSha: schema.evidence.baseSha })
      .from(schema.evidence)
      .where(eq(schema.evidence.attemptId, attempt.id))
      .all(),
    reviews: tx
      .select({ headSha: schema.reviews.headSha, baseSha: schema.reviews.baseSha })
      .from(schema.reviews)
      .where(eq(schema.reviews.attemptId, attempt.id))
      .all(),
  });
}

/**
 * Whether a blocked Task's Blocker was resolved by a Replan: the Inbox Item
 * its Blocker opened (a Blocker Approval or a Question, by the same Attempt)
 * was decided with "replan". Such a Task is affected, so never carried over.
 */
function resolvedByReplan(tx: Tx, row: TaskRow): boolean {
  if (row.blockerJson === null) return false;
  const blocker = BlockerSchema.parse(JSON.parse(row.blockerJson));
  return tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.taskId, row.id),
        eq(schema.approvals.subjectRef, blocker.attemptId),
        eq(schema.approvals.state, 'decided'),
      ),
    )
    .all()
    .some(
      (a) =>
        a.decisionJson !== null &&
        InboxDecisionSchema.parse(JSON.parse(a.decisionJson)).option === 'replan',
    );
}

/** Cancels a cancelled Task's open Inbox Items (its Question or Blocker Approval). */
export function cancelTaskItems(
  tx: Tx,
  op: { jobId: string; actor: string },
  taskId: string,
): void {
  const open = tx
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.state, 'open')))
    .all();
  for (const row of open) {
    tx.update(schema.approvals)
      .set({ state: 'cancelled', version: sql`${schema.approvals.version} + 1` })
      .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.version, row.version)))
      .run();
    appendEvent(tx, {
      entityKind: 'approval',
      entityId: row.id,
      jobId: op.jobId,
      type: 'approval.cancelled',
      actor: op.actor,
      payload: { kind: row.kind, reason: 'task_cancelled', taskId },
    });
  }
}

/**
 * Cancels the unfinished Tasks of a rejected Plan, with `reason`, and their
 * open Inbox Items. Nothing is in flight then: a Plan waiting at
 * `plan_approval` runs nothing, though it may hold Tasks carried over
 * `blocked` or `approved` from an earlier one (ADR-0029); approved ones keep
 * their record.
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
        inArray(schema.tasks.state, ['pending', 'ready', 'blocked', 'changes_requested']),
      ),
    )
    .all();
  for (const task of open) {
    // The human rejected the Plan its Tasks belong to.
    stepTask(tx, op, task, 'cancelled', { reason, cancelReason: 'human' });
    cancelTaskItems(tx, op, task.id);
  }
}

/** What a planning Stage Run re-plans from: the Plan it replaces and the feedback. */
export interface ReplanRequest {
  planArtifactId: string;
  feedback: string;
}

/**
 * The Replan a planning Stage Run answers, read from what is stored, never
 * regenerated: a `replan_request` Artifact naming the Job's newest Plan (a
 * Replan asked for during execution, ADR-0029), or else the Job's newest plan
 * Inbox Item, when a human decided it `request_changes` (ADR-0019). A first
 * planning Stage Run has none. Read again on every Harness Run, so a
 * restarted runtime re-plans from the same request.
 */
export function replanRequestOf(
  db: FactoryDb | Tx,
  jobId: string,
  readJson: (artifactId: string) => unknown,
): ReplanRequest | undefined {
  const plan = newestArtifact(db, jobId, 'plan');
  const asked = newestArtifact(db, jobId, 'replan_request');
  if (plan !== undefined && asked !== undefined) {
    const request = ReplanRequestContentSchema.parse(readJson(asked.id));
    if (request.planArtifactId === plan.id && pendingRequest(db, jobId, asked.id)) {
      return { planArtifactId: request.planArtifactId, feedback: request.feedback };
    }
  }
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

/** A replan request held by an open `replan_cap_reached` Approval has not started yet. */
function pendingRequest(db: FactoryDb | Tx, jobId: string, requestId: string): boolean {
  const held = db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.subjectRef, requestId),
        eq(schema.approvals.state, 'open'),
      ),
    )
    .get();
  return held === undefined;
}

function newestArtifact(db: FactoryDb | Tx, jobId: string, kind: string) {
  return db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.kind, kind)))
    .orderBy(desc(sql`"artifacts"."rowid"`))
    .limit(1)
    .get();
}

/** The id given to a validated Plan's Task key (the validator guarantees it exists). */
function taskId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`the validated Plan has no Task ${key}`);
  return id;
}
