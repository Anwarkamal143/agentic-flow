/**
 * The Effective Configuration of a Project as stored now (ADR-0049, ADR-0057):
 * what `job create` freezes, and what the effective-config preview shows
 * (ADR-0059). One reader, so the preview can't drift from what a Job gets.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  ProjectConfigSchema,
  resolveEffectiveConfig,
  type EffectiveConfigLevels,
  type EffectiveConfigResolution,
} from '@factory/domain';
import { asc, eq } from 'drizzle-orm';
import { read as readFactoryLevel } from './factory-level.js';
import { toRepository } from './repositories.js';

/** Resolves recipe < Factory < Project < every Repository of the Project < `job`. Pure read. */
export function resolveProjectConfig(
  db: FactoryDb | Tx,
  project: typeof schema.projects.$inferSelect,
  job?: EffectiveConfigLevels['job'],
): EffectiveConfigResolution {
  return resolveEffectiveConfig({
    factory: readFactoryLevel(db)?.config,
    project: ProjectConfigSchema.parse(JSON.parse(project.configJson)),
    repositories: db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.projectId, project.id))
      .orderBy(asc(schema.repositories.name))
      .all()
      .map(toRepository),
    job,
  });
}
