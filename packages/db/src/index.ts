import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export { schema };

export type FactoryDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: FactoryDb;
  readonly journalMode: string;
  /** Number of migrations recorded as applied. */
  readonly appliedMigrations: number;
  close(): void;
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Number of migrations shipped with this build. */
export function shippedMigrationCount(): number {
  return readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql')).length;
}

/**
 * Opens (creating if needed) the factory database in WAL mode and applies every
 * pending migration. Only the runtime calls this: it is the single writer.
 */
export function openDatabase(path: string): DatabaseHandle {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  const journalMode = String(sqlite.pragma('journal_mode', { simple: true }));
  const row = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
    n: number;
  };
  return {
    db,
    journalMode,
    appliedMigrations: row.n,
    close: () => {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
    },
  };
}

export interface NewEvent {
  entityKind: string;
  entityId: string;
  jobId?: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
}

/** Appends one event. Callers run it inside the transaction of the state change. */
export function appendEvent(db: FactoryDb, event: NewEvent): number {
  const row = db
    .insert(schema.events)
    .values({
      ts: new Date().toISOString(),
      entityKind: event.entityKind,
      entityId: event.entityId,
      jobId: event.jobId ?? null,
      type: event.type,
      actor: event.actor,
      payloadJson: JSON.stringify({ v: 1, ...event.payload }),
    })
    .returning({ seq: schema.events.seq })
    .get();
  return row.seq;
}
