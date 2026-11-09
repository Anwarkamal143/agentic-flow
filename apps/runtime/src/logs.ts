/**
 * The logs of a Job's Attempts (#11): every `log` Artifact of an Attempt, the
 * Harness Runs' and the verification commands' output, in the order stored.
 * The content was redacted when it was written (ADR-0011).
 */
import { schema, type FactoryDb } from '@factory/db';
import { LogContentSchema, type JobLogEntry } from '@factory/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';

export function jobLogs(db: FactoryDb, artifacts: ArtifactStore, jobId: string): JobLogEntry[] {
  return db
    .select({
      artifactId: schema.artifacts.id,
      createdAt: schema.artifacts.createdAt,
      taskId: schema.tasks.id,
      taskKey: schema.tasks.key,
      attemptId: schema.attempts.id,
      attemptN: schema.attempts.n,
    })
    .from(schema.artifacts)
    .innerJoin(schema.attempts, eq(schema.attempts.id, schema.artifacts.attemptId))
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
    .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.kind, 'log')))
    .orderBy(asc(sql`${schema.artifacts}.rowid`))
    .all()
    .map((row) => ({
      ...row,
      content: LogContentSchema.parse(artifacts.readJson(row.artifactId)),
    }));
}
