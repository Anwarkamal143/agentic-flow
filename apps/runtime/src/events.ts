/**
 * Reading the event log (ARCHITECTURE §4.1). Events are appended only by the
 * transaction of the state change they describe; this module never writes them.
 */
import { schema, type FactoryDb } from '@factory/db';
import type { FactoryEvent } from '@factory/domain';
import { and, asc, eq, gt, isNotNull, type SQL } from 'drizzle-orm';

export const MAX_EVENT_PAGE = 1000;

export interface EventQuery {
  /** Only events with `seq` greater than this. */
  after?: number | undefined;
  /** Only this Job's events. */
  jobId?: string | undefined;
  limit?: number | undefined;
  /** Only events the outbox publisher has released (what SSE delivers). */
  publishedOnly?: boolean | undefined;
}

/** Events in `seq` order. */
export function readEvents(db: FactoryDb, q: EventQuery = {}): FactoryEvent[] {
  const where: SQL[] = [gt(schema.events.seq, q.after ?? 0)];
  if (q.jobId !== undefined) where.push(eq(schema.events.jobId, q.jobId));
  if (q.publishedOnly === true) where.push(isNotNull(schema.events.publishedAt));
  return db
    .select()
    .from(schema.events)
    .where(and(...where))
    .orderBy(asc(schema.events.seq))
    .limit(Math.min(q.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE))
    .all()
    .map(toEvent);
}

function toEvent(row: typeof schema.events.$inferSelect): FactoryEvent {
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  return {
    seq: row.seq,
    ts: row.ts,
    entityKind: row.entityKind,
    entityId: row.entityId,
    jobId: row.jobId,
    type: row.type,
    actor: row.actor,
    payload,
  };
}
