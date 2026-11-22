/**
 * Cross-repo context for a dependent Task (ADR-0052, ADR-0065): for each Task
 * in another Repository that it depends on, the approved Attempt's Task
 * Result summary and its diff `base..head`, read from that Repository's
 * Factory Clone. Read-only context in the Task Packet, never code in the
 * dependent Task's Worktree (its Dependency Base takes same-Repository
 * dependencies only). Built from the factory's own records and git; nothing
 * is regenerated.
 */
import { schema, type FactoryDb } from '@factory/db';
import { TaskResultSchema, type UpstreamContextItem } from '@factory/domain';
import { diffBetween } from '@factory/git';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';

/** The diff of one upstream Task a packet carries, at most. */
const MAX_UPSTREAM_DIFF_BYTES = 128 * 1024;

/**
 * The upstream context items of `task`, in Plan order. Throws when an
 * upstream Task has no approved Attempt: the Task is `ready` only once every
 * Task it depends on is approved.
 */
export async function upstreamContext(
  db: FactoryDb,
  artifacts: ArtifactStore,
  task: { id: string; key: string; repositoryId: string },
): Promise<UpstreamContextItem[]> {
  const upstream = db
    .select({
      id: schema.tasks.id,
      key: schema.tasks.key,
      title: schema.tasks.title,
      repositoryId: schema.repositories.id,
      name: schema.repositories.name,
      clonePath: schema.repositories.clonePath,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.dependsOnTaskId))
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
    .where(
      and(
        eq(schema.taskDependencies.taskId, task.id),
        ne(schema.tasks.repositoryId, task.repositoryId),
      ),
    )
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
  const items: UpstreamContextItem[] = [];
  for (const dep of upstream) {
    const passed = db
      .select({
        id: schema.attempts.id,
        baseSha: schema.attempts.baseSha,
        headSha: schema.attempts.headSha,
      })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, dep.id), eq(schema.attempts.state, 'passed')))
      .orderBy(desc(schema.attempts.n))
      .get();
    if (passed?.headSha == null) {
      throw new Error(`Task ${task.key} depends on ${dep.key}, which has no approved head`);
    }
    const result = db
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .where(
        and(eq(schema.artifacts.attemptId, passed.id), eq(schema.artifacts.kind, 'task_result')),
      )
      .get();
    const parsed =
      result === undefined ? undefined : TaskResultSchema.safeParse(artifacts.readJson(result.id));
    items.push({
      task: { id: dep.id, key: dep.key, title: dep.title },
      repository: { id: dep.repositoryId, name: dep.name },
      baseSha: passed.baseSha,
      headSha: passed.headSha,
      summary: parsed?.success === true ? parsed.data.summary : null,
      diff: await diffBetween(
        dep.clonePath,
        passed.baseSha,
        passed.headSha,
        MAX_UPSTREAM_DIFF_BYTES,
      ),
    });
  }
  return items;
}
