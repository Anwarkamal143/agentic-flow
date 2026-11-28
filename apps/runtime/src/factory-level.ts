/**
 * The Factory Level (ADR-0049, ADR-0056): the factory-wide configuration row.
 * Created on the first start, with `config.json`'s `concurrency.global` copied
 * in once (audited as `system:migration`); changed one key at a time by
 * `factory config set` (audited as `user:local`). Each change is one
 * transaction with its audit row and its event.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AuditEntrySchema,
  bootstrapFactoryLevel,
  factoryGlobalConcurrency,
  FactoryLevelConfigSchema,
  type AuditEntry,
  type BootstrapFactoryKeys,
  type FactoryLevel,
  type FactoryLevelConfig,
  type SetFactoryConfigInput,
  setFactoryConfigKey,
} from '@factory/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { assertNarrowing, bumpConfigVersion } from './config-tree.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';

const ROW_ID = 'factory';
const TARGET = 'factory';

export class FactoryLevelService {
  constructor(
    private readonly db: FactoryDb,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  /**
   * Creates the Factory Level on the first start, copying `config.json`'s keys
   * in. Once it exists this does nothing, so a later edit to the file has no
   * effect. Runs before the outbox starts, which publishes its event then.
   */
  ensure(file: BootstrapFactoryKeys | undefined): void {
    this.db.transaction(
      (tx) => {
        if (read(tx) !== undefined) return;
        const config = bootstrapFactoryLevel(file);
        const level: FactoryLevel = { config, version: 1, updatedAt: new Date().toISOString() };
        tx.insert(schema.factoryLevel)
          .values({
            id: ROW_ID,
            configJson: JSON.stringify(config),
            version: 1,
            updatedAt: level.updatedAt,
          })
          .run();
        if (Object.keys(config).length > 0) {
          record(tx, {
            actor: 'system:migration',
            action: 'factory_config.migrated',
            before: {},
            level,
            payload: { source: 'config.json', key: 'concurrency.global' },
          });
        }
      },
      { behavior: 'immediate' },
    );
  }

  show(): FactoryLevel {
    const level = read(this.db);
    if (level === undefined) throw new Error('the Factory Level has not been created');
    return level;
  }

  /** The global Task limit, read at each claim so a `config set` applies at once. */
  globalConcurrency(): number {
    return factoryGlobalConcurrency(this.show().config);
  }

  /** `factory config set`: one key, validated, refused on a stale `expectedVersion`. */
  setKey(input: SetFactoryConfigInput, actor: string): FactoryLevel {
    const updated = this.db.transaction(
      (tx) => {
        const current = read(tx);
        if (current === undefined) throw new Error('the Factory Level has not been created');
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          throw new ApiFailure(
            409,
            'version_conflict',
            `the Factory Level is at version ${String(current.version)}, not ${String(input.expectedVersion)}`,
          );
        }
        const change = setFactoryConfigKey(current.config, input.key, input.value);
        if (!change.ok) throw new ApiFailure(400, change.code, change.message);
        assertNarrowing(tx, { factory: change.config });
        const level: FactoryLevel = {
          config: change.config,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        tx.update(schema.factoryLevel)
          .set({
            configJson: JSON.stringify(level.config),
            version: level.version,
            updatedAt: level.updatedAt,
          })
          .where(eq(schema.factoryLevel.id, ROW_ID))
          .run();
        bumpConfigVersion(tx);
        record(tx, {
          actor,
          action: 'factory_config.set',
          before: current.config,
          level,
          payload: { key: input.key },
        });
        return level;
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return updated;
  }

  /** Every change to the Factory Level, oldest first. */
  audit(): AuditEntry[] {
    return this.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, TARGET))
      .orderBy(asc(schema.auditLog.ts), asc(sql`"audit_log"."rowid"`))
      .all()
      .map((r) =>
        AuditEntrySchema.parse({
          id: r.id,
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          target: r.target,
          before: JSON.parse(r.beforeJson) as unknown,
          after: JSON.parse(r.afterJson) as unknown,
          policyRef: r.policyRef,
          correlationId: r.correlationId,
        }),
      );
  }
}

/** The Factory Level row, or undefined before the first start created it. */
export function read(db: FactoryDb | Tx): FactoryLevel | undefined {
  const row = db.select().from(schema.factoryLevel).where(eq(schema.factoryLevel.id, ROW_ID)).get();
  if (row === undefined) return undefined;
  return {
    config: FactoryLevelConfigSchema.parse(JSON.parse(row.configJson)),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** The audit row and the `factory.config_updated` event of one change. */
function record(
  tx: Tx,
  change: {
    actor: string;
    action: string;
    before: FactoryLevelConfig;
    level: FactoryLevel;
    payload: Record<string, unknown>;
  },
): void {
  const auditId = newId('aud');
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: change.level.updatedAt,
      actor: change.actor,
      action: change.action,
      target: TARGET,
      jobId: null,
      beforeJson: JSON.stringify(change.before),
      afterJson: JSON.stringify(change.level.config),
      policyRef: null,
      correlationId: null,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'factory',
    entityId: ROW_ID,
    type: 'factory.config_updated',
    actor: change.actor,
    payload: {
      ...change.payload,
      auditId,
      version: change.level.version,
      before: change.before,
      after: change.level.config,
    },
  });
}
