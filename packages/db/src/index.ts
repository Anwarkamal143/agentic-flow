import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export { schema };

export type FactoryDb = BetterSQLite3Database<typeof schema>;

/** The handle passed to a `FactoryDb.transaction` callback. */
export type Tx = Parameters<Parameters<FactoryDb['transaction']>[0]>[0];

export interface DatabaseHandle {
  readonly db: FactoryDb;
  readonly journalMode: string;
  /** Number of migrations recorded as applied. */
  readonly appliedMigrations: number;
  close(): void;
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface OpenOptions {
  /**
   * Applied to every string bound to a statement, so no write can store a
   * secret value (ADR-0011): the single choke point for the database.
   */
  redact?: (text: string) => string;
}

/**
 * Opens (creating if needed) the factory database in WAL mode and applies every
 * pending migration. Only the runtime calls this: it is the single writer.
 */
export function openDatabase(path: string, opts: OpenOptions = {}): DatabaseHandle {
  const sqlite = new Database(path);
  if (opts.redact !== undefined) redactBindings(sqlite, opts.redact);
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
export function appendEvent(db: FactoryDb | Tx, event: NewEvent): number {
  const row = db
    .insert(schema.events)
    .values({
      ts: new Date().toISOString(),
      entityKind: event.entityKind,
      entityId: event.entityId,
      jobId: event.jobId ?? null,
      type: event.type,
      actor: event.actor,
      payloadJson: JSON.stringify({ ...event.payload, v: 1 }),
    })
    .returning({ seq: schema.events.seq })
    .get();
  return row.seq;
}

/** Methods of a better-sqlite3 Statement that bind parameters and execute. */
const EXECUTING = new Set<string | symbol>(['run', 'get', 'all', 'iterate']);

/**
 * Wraps `sqlite.prepare` so every statement redacts the strings bound to it
 * (positional or named) before it executes. Mode setters such as `raw()`
 * return the statement itself, so they return the wrapper.
 */
function redactBindings(sqlite: Database.Database, redact: (text: string) => string): void {
  const param = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, param(v)]));
    }
    return value;
  };
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((source: string) => {
    const stmt = prepare(source);
    const wrapper: typeof stmt = new Proxy(stmt, {
      get(target, prop) {
        const member: unknown = Reflect.get(target, prop, target);
        if (typeof member !== 'function') return member;
        const fn = member as (...args: unknown[]) => unknown;
        if (EXECUTING.has(prop)) return (...args: unknown[]) => fn.apply(target, args.map(param));
        return (...args: unknown[]) => {
          const out = fn.apply(target, args);
          return out === target ? wrapper : out;
        };
      },
    });
    return wrapper;
  }) as typeof sqlite.prepare;
}
