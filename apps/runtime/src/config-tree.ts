/**
 * The narrowing rule over every stored level (ADR-0049, ADR-0057): a change to
 * the Factory Level, a Project or a Repository is refused when it would leave
 * any level's permission value wider than its parent's. Checked inside the
 * change's own transaction.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  configTreeViolation,
  FactoryLevelConfigSchema,
  MergePolicySchema,
  ProjectConfigSchema,
  type ConfigTree,
  type FactoryLevelConfig,
  type MergePolicy,
  type ProjectConfig,
} from '@factory/domain';
import { eq, sql } from 'drizzle-orm';
import { ApiFailure } from './errors.js';

/** A proposed change, applied over the stored levels before the check. */
export interface ConfigChange {
  factory?: FactoryLevelConfig;
  project?: { id: string; config: ProjectConfig };
  /** A Repository being registered (it has no row yet). */
  repository?: { projectId: string; name: string; mergePolicy: MergePolicy };
}

/** Throws `409 config_widens_parent`, naming the parent's value, when `change` widens a level. */
export function assertNarrowing(db: FactoryDb | Tx, change: ConfigChange): void {
  const factoryRow = db
    .select({ configJson: schema.factoryLevel.configJson })
    .from(schema.factoryLevel)
    .where(eq(schema.factoryLevel.id, 'factory'))
    .get();
  const factory =
    change.factory ??
    (factoryRow === undefined
      ? {}
      : FactoryLevelConfigSchema.parse(JSON.parse(factoryRow.configJson)));
  const repositories = db
    .select({
      projectId: schema.repositories.projectId,
      name: schema.repositories.name,
      mergePolicy: schema.repositories.mergePolicy,
    })
    .from(schema.repositories)
    .all()
    .map((r) => ({ ...r, mergePolicy: MergePolicySchema.parse(r.mergePolicy) }));
  if (change.repository !== undefined) repositories.push(change.repository);
  const tree: ConfigTree = {
    factory,
    projects: db
      .select()
      .from(schema.projects)
      .all()
      .map((p) => ({
        name: p.name,
        config:
          change.project?.id === p.id
            ? change.project.config
            : ProjectConfigSchema.parse(JSON.parse(p.configJson)),
        repositories: repositories.filter((r) => r.projectId === p.id),
      })),
  };
  const violation = configTreeViolation(tree);
  if (violation !== undefined) throw new ApiFailure(409, violation.code, violation.message);
}

/**
 * Bumps the configuration version (ADR-0073), in the transaction of a change
 * to the Factory Level, a Project or a Repository's configuration, so a
 * `config import --apply --expect-version` refuses a diff shown before it.
 */
export function bumpConfigVersion(tx: Tx): void {
  tx.update(schema.factoryLevel)
    .set({ configVersion: sql`${schema.factoryLevel.configVersion} + 1` })
    .where(eq(schema.factoryLevel.id, 'factory'))
    .run();
}

/** The configuration version; 1 before the Factory Level exists. */
export function configVersion(db: FactoryDb | Tx): number {
  const row = db
    .select({ configVersion: schema.factoryLevel.configVersion })
    .from(schema.factoryLevel)
    .where(eq(schema.factoryLevel.id, 'factory'))
    .get();
  return row?.configVersion ?? 1;
}
