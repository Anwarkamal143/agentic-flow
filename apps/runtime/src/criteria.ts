import { schema, type FactoryDb, type Tx } from '@factory/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** The Job's Acceptance Criteria that a Task covers (its Plan entry's `acceptance` codes), by code. */
export function criteriaCoveredBy(
  db: FactoryDb | Tx,
  jobId: string,
  acceptance: readonly string[],
): (typeof schema.acceptanceCriteria.$inferSelect)[] {
  if (acceptance.length === 0) return [];
  return db
    .select()
    .from(schema.acceptanceCriteria)
    .where(
      and(
        eq(schema.acceptanceCriteria.jobId, jobId),
        inArray(schema.acceptanceCriteria.code, [...acceptance]),
      ),
    )
    .orderBy(asc(schema.acceptanceCriteria.code))
    .all();
}
