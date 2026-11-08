import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Append-only event log (outbox). Written in the same transaction as the state
 * change it describes. Not event sourcing: state tables stay authoritative.
 * ARCHITECTURE §4.1 / §5.
 */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    ts: text('ts').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    jobId: text('job_id'),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    payloadJson: text('payload_json').notNull(),
    publishedAt: text('published_at'),
  },
  (t) => [index('events_job_seq').on(t.jobId, t.seq)],
);
