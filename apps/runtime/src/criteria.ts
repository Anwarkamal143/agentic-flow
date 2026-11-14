import { schema, type FactoryDb, type Tx } from '@factory/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

type ArtifactRow = typeof schema.artifacts.$inferSelect;
type CriterionRow = typeof schema.acceptanceCriteria.$inferSelect;

/**
 * The Job's current Specification: the newest spec Artifact whose
 * `specification` Stage Run `succeeded`. A re-specification's spec waiting
 * on its `spec_change` Approval, or one a human sent back or rejected, never
 * is (ADR-0031); every spec Artifact is kept.
 */
export function currentSpec(db: FactoryDb | Tx, jobId: string): ArtifactRow | undefined {
  return db
    .select({ artifact: schema.artifacts })
    .from(schema.artifacts)
    .innerJoin(schema.stageRuns, eq(schema.stageRuns.id, schema.artifacts.stageRunId))
    .where(
      and(
        eq(schema.artifacts.jobId, jobId),
        eq(schema.artifacts.kind, 'spec'),
        eq(schema.stageRuns.state, 'succeeded'),
      ),
    )
    .orderBy(desc(sql`"artifacts"."rowid"`))
    .limit(1)
    .get()?.artifact;
}

/** The current Specification's Acceptance Criteria, in the order it lists them. */
export function currentCriteria(db: FactoryDb | Tx, jobId: string): CriterionRow[] {
  const spec = currentSpec(db, jobId);
  if (spec === undefined) return [];
  return db
    .select()
    .from(schema.acceptanceCriteria)
    .where(eq(schema.acceptanceCriteria.artifactId, spec.id))
    .orderBy(asc(sql`rowid`))
    .all();
}

/** The current Specification's Acceptance Criteria that a Task covers (its Plan entry's `acceptance` codes), by code. */
export function criteriaCoveredBy(
  db: FactoryDb | Tx,
  jobId: string,
  acceptance: readonly string[],
): CriterionRow[] {
  const spec = currentSpec(db, jobId);
  if (acceptance.length === 0 || spec === undefined) return [];
  return db
    .select()
    .from(schema.acceptanceCriteria)
    .where(
      and(
        eq(schema.acceptanceCriteria.artifactId, spec.id),
        inArray(schema.acceptanceCriteria.code, [...acceptance]),
      ),
    )
    .orderBy(asc(schema.acceptanceCriteria.code))
    .all();
}
