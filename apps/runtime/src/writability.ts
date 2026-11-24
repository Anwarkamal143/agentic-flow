/**
 * The `repository_not_writable` Blocker (#108, ADR-0052, ADR-0068). Before a
 * Task's first Attempt (its Worktree, or the Integration Task's merge), the
 * factory checks that it can deliver to the Task's Repository: the Factory
 * Clone is writable and, with GitHub Coordinates, the token has push
 * permission (the GitHub port's read). A failure blocks the claimed Task with
 * the exact reason; no Attempt or Worktree is made. Dependent Tasks wait;
 * once every other Repository is approved, they are delivered without it
 * (`partialDelivery`), and closure ends `blocked` on the held Repository: a
 * Partial Completion, never a terminal status.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  BlockerSchema,
  NOT_WRITABLE_ACTION,
  repositoryWritability,
  type Blocker,
  type PushPermissionRead,
  type Writability,
} from '@factory/domain';
import type { GitHubPort } from '@factory/github';
import { and, asc, eq, sql } from 'drizzle-orm';
import { changeJob, stepTask } from './engine.js';
import { settleExecution } from './keep-going.js';
import { latestArtifact } from './plan-approval.js';
import { releaseAttemptTokens } from './worktree.js';

type RepositoryRow = typeof schema.repositories.$inferSelect;

/**
 * The preflight: the Factory Clone (its directory and its `.git`) writable by
 * this process, then GitHub's push permission when the Repository has GitHub
 * Coordinates and the runtime has a GitHub port. Without a port (only tests
 * leave it out) GitHub is not asked.
 */
export async function checkWritable(
  repo: RepositoryRow,
  github: GitHubPort | undefined,
): Promise<Writability> {
  let clone: { writable: true } | { writable: false; problem: string } = { writable: true };
  for (const path of [repo.clonePath, `${repo.clonePath}/.git`]) {
    try {
      await access(path, constants.W_OK);
    } catch (err) {
      clone = { writable: false, problem: `${path}: ${errorCode(err)}` };
      break;
    }
  }
  const coordinates =
    repo.githubOwner === null || repo.githubName === null
      ? null
      : { owner: repo.githubOwner, name: repo.githubName };
  let read: PushPermissionRead | undefined;
  if (coordinates !== null && github !== undefined && clone.writable) {
    const res = await github.getPushPermission(coordinates);
    read = res.ok
      ? { ok: true, push: res.value.push }
      : {
          ok: false,
          kind: res.failure.kind,
          status: res.failure.status,
          reason:
            res.failure.kind === 'rate_limited'
              ? `rate limited until ${res.failure.resetAt}`
              : res.failure.reason,
        };
  }
  return repositoryWritability({
    repository: { name: repo.name, clonePath: repo.clonePath },
    clone,
    github:
      coordinates === null || read === undefined
        ? null
        : { label: `${coordinates.owner}/${coordinates.name}`, read },
  });
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

/**
 * Blocks the `claimed` Task whose Repository is not writable, in one
 * transaction: the `repository_not_writable` Blocker (its Blocker Approval
 * opened by `stepTask`), its lease and capacity tokens released, and its
 * Stage settled. No Attempt or Worktree was made, so the Blocker names the
 * Task itself as its subject.
 */
export function blockNotWritable(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  detail: string,
): void {
  changeJob(
    db,
    { jobId: op.jobId, expectedVersion: 'current', actor: op.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'claimed')
        throw new Error(`Task ${taskId} is ${String(task?.state)}, not claimed`);
      const blocker: Blocker = {
        kind: 'infrastructure',
        reason: 'repository_not_writable',
        detail,
        requiredAction: NOT_WRITABLE_ACTION,
        taskId,
        attemptId: taskId,
        createdAt: new Date().toISOString(),
      };
      stepTask(tx, op, task, 'blocked', {
        reason: blocker.reason,
        payload: { detail },
        blocker,
      });
      releaseAttemptTokens(tx, taskId, undefined);
      settleExecution(tx, state, step);
    },
  );
}

/** Records that the push permission could not be read: the Task goes on, and the push checks it. */
export function recordUnchecked(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  detail: string,
): void {
  db.transaction((tx) => {
    appendEvent(tx, {
      entityKind: 'task',
      entityId: taskId,
      jobId: op.jobId,
      type: 'task.writability_unchecked',
      actor: op.actor,
      payload: { detail },
    });
  });
}

/**
 * The Blocker of the first Plan Task of the Job's newest Plan, in Plan order,
 * that is blocked `repository_not_writable`: what holds a Partial Completion
 * at closure. `undefined` when none is.
 */
export function heldRepositoryBlocker(tx: Tx, jobId: string): Blocker | undefined {
  const plan = latestArtifact(tx, jobId, 'plan');
  if (plan === undefined) return undefined;
  const blocked = tx
    .select({ blockerJson: schema.tasks.blockerJson })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        eq(schema.tasks.kind, 'plan'),
        eq(schema.tasks.planArtifactId, plan.id),
        eq(schema.tasks.state, 'blocked'),
      ),
    )
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
  for (const row of blocked) {
    if (row.blockerJson === null) continue;
    const blocker = BlockerSchema.parse(JSON.parse(row.blockerJson));
    if (blocker.reason === 'repository_not_writable') return blocker;
  }
  return undefined;
}
