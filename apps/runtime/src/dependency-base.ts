/**
 * Making the Dependency Base (ARCHITECTURE §10, ADR-0021) in the Factory
 * Clone: the commit a dependent Task's new Worktree starts from. One
 * dependency: its approved head. Several: their approved heads merged in Plan
 * order into a local commit (merge commits only; no ref, index or Worktree is
 * touched). It is local to the Job and is not the Integration Branch (§14).
 * A merge that conflicts blocks the Task with `base_merge_conflict`, a human
 * Blocker (§8.1, ADR-0028), never an automatic replan.
 */
import { schema, type FactoryDb } from '@factory/db';
import {
  planDependencyBase,
  TaskStateSchema,
  type Blocker,
  type DependencyFact,
} from '@factory/domain';
import { commitTree, mergeCommits } from '@factory/git';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { changeJob, stepTask } from './engine.js';
import { settleExecution } from './keep-going.js';
import { releaseAttemptTokens } from './worktree.js';

export type DependencyBase =
  /** The Task depends on nothing: start from the default branch. */
  | { kind: 'none' }
  | { kind: 'base'; sha: string; dependencies: string[] }
  /** Merging the heads conflicts; `paths` are the conflicting paths. */
  | { kind: 'conflict'; dependencies: string[]; paths: string[] };

/** The Task's dependencies in Plan order, with their state and approved head. */
function dependencyFacts(db: FactoryDb, taskId: string): DependencyFact[] {
  const deps = db
    .select({ id: schema.tasks.id, key: schema.tasks.key, state: schema.tasks.state })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.dependsOnTaskId))
    .where(eq(schema.taskDependencies.taskId, taskId))
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
  return deps.map((d) => {
    const passed = db
      .select({ headSha: schema.attempts.headSha })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, d.id), eq(schema.attempts.state, 'passed')))
      .orderBy(desc(schema.attempts.n))
      .get();
    return { key: d.key, state: TaskStateSchema.parse(d.state), headSha: passed?.headSha ?? null };
  });
}

/**
 * Makes the Dependency Base of `task` in `clone`. Throws when a dependency is
 * not approved: a Task is `ready` only once all of them are.
 */
export async function makeDependencyBase(
  db: FactoryDb,
  clone: string,
  task: { id: string; key: string },
): Promise<DependencyBase> {
  const facts = dependencyFacts(db, task.id);
  const dependencies = facts.map((f) => f.key);
  const plan = planDependencyBase(facts);
  switch (plan.kind) {
    case 'default_branch':
      return { kind: 'none' };
    case 'not_ready':
      throw new Error(
        `Task ${task.key} depends on ${plan.keys.join(', ')}, which ${plan.keys.length === 1 ? 'is' : 'are'} not approved`,
      );
    case 'head':
      return { kind: 'base', sha: plan.sha, dependencies };
    case 'merge': {
      const [first, ...rest] = plan.heads;
      if (first === undefined) throw new Error('a merge has heads');
      let base = first;
      for (const head of rest) {
        const merged = await mergeCommits(clone, base, head);
        if (merged.kind === 'conflict') {
          return { kind: 'conflict', dependencies, paths: merged.paths };
        }
        base = await commitTree(
          clone,
          merged.tree,
          [base, head],
          `Dependency Base of ${task.key}: ${dependencies.join(', ')}\n\nFactory-Dependency-Base: true`,
        );
      }
      return { kind: 'base', sha: base, dependencies };
    }
  }
}

/**
 * Blocks the `claimed` Task whose Dependency Base conflicts, in one
 * transaction: the `base_merge_conflict` Blocker (with its Blocker Approval,
 * opened by `stepTask`), its lease and capacity tokens released, and
 * `execution` settled. No Attempt or Worktree was made. The Blocker names the
 * Task itself as its subject, since no Attempt raised it.
 */
export function blockOnBaseConflict(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  conflict: { dependencies: string[]; paths: string[] },
): void {
  changeJob(
    db,
    { jobId: op.jobId, expectedVersion: 'current', actor: op.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'claimed')
        throw new Error(`Task ${taskId} is ${String(task?.state)}, not claimed`);
      const where = conflict.paths.length === 0 ? 'the merge' : conflict.paths.join(', ');
      const blocker: Blocker = {
        kind: 'human',
        reason: 'base_merge_conflict',
        detail: `merging the approved heads of ${conflict.dependencies.join(', ')} into the Dependency Base of ${task.key} conflicts in ${where}`,
        requiredAction:
          'look at the conflicting Task Branches in the Factory Clone, then decide the Blocker Approval in the Inbox: cancel the Job (a replan option is not built yet)',
        taskId,
        attemptId: taskId,
        createdAt: new Date().toISOString(),
      };
      stepTask(tx, op, task, 'blocked', {
        reason: blocker.reason,
        payload: { dependencies: conflict.dependencies, paths: conflict.paths },
        blocker,
      });
      releaseAttemptTokens(tx, taskId, undefined);
      settleExecution(tx, state, step);
    },
  );
}
