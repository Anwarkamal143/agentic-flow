import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

/** A product or initiative that owns Repositories and Jobs. ARCHITECTURE §5. */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    configJson: text('config_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('projects_name').on(t.name)],
);

/**
 * A registered git repository and its Factory Clone (ADR-0001). `source` is the
 * path given at registration; the factory never writes to it.
 */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    source: text('source').notNull(),
    remoteUrl: text('remote_url'),
    clonePath: text('clone_path').notNull(),
    defaultBranch: text('default_branch').notNull(),
    profileJson: text('profile_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('repositories_source').on(t.source),
    uniqueIndex('repositories_project_name').on(t.projectId, t.name),
  ],
);
