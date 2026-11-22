/**
 * The Factory Level (ADR-0049, ADR-0056): factory-wide configuration, one row in
 * the database above every Project, with a version for optimistic concurrency.
 * `config.json` is bootstrap-only; the one key it used to hold here,
 * `concurrency.global`, is copied in once on the first start and is stale after.
 * Pure rules, shared by the runtime and the CLI.
 */
import { z } from 'zod';
import { DEFAULT_GLOBAL_CONCURRENCY } from './capacity.js';
import { configLeafKeys, setConfigKey, type ConfigKeyChange } from './projects.js';

/** Operator-set Factory Level configuration. Every field is optional: unset means the default. */
export const FactoryLevelConfigSchema = z
  .object({
    concurrency: z
      .object({
        /** Tasks in flight at once, over every Job and Repository (ARCHITECTURE §12, ADR-0020). */
        global: z.number().int().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FactoryLevelConfig = z.infer<typeof FactoryLevelConfigSchema>;

/** `GET /v1/factory/config`. */
export const FactoryLevelSchema = z.object({
  config: FactoryLevelConfigSchema,
  /** Starts at 1; each change adds one. */
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type FactoryLevel = z.infer<typeof FactoryLevelSchema>;

/** `POST /v1/factory/config/set` (`factory config set`): one key, dotted when nested. */
export const SetFactoryConfigInputSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  /** When given, the change is refused unless the Factory Level is at this version. */
  expectedVersion: z.number().int().min(1).optional(),
});
export type SetFactoryConfigInput = z.infer<typeof SetFactoryConfigInputSchema>;

/** The settable Factory Level keys, dotted (`concurrency.global`). */
export function factoryConfigKeys(): string[] {
  return configLeafKeys(FactoryLevelConfigSchema);
}

/** `config` with one key set (`factory config set`), validated; `config` is not changed. */
export function setFactoryConfigKey(
  config: FactoryLevelConfig,
  key: string,
  value: unknown,
): ConfigKeyChange<FactoryLevelConfig> {
  return setConfigKey(FactoryLevelConfigSchema, 'Factory Level', config, key, value);
}

/** The global Task limit the Factory Level sets, or the default (3). */
export function factoryGlobalConcurrency(config: FactoryLevelConfig): number {
  return config.concurrency?.global ?? DEFAULT_GLOBAL_CONCURRENCY;
}

/** What `config.json` may still hold of the Factory Level's keys (read before Phase D). */
export interface BootstrapFactoryKeys {
  concurrency?: { global?: number | undefined } | undefined;
}

/** The Factory Level keys `config.json` sets: copied once on the first start, stale after. */
export function staleBootstrapKeys(file: BootstrapFactoryKeys | undefined): string[] {
  return file?.concurrency?.global === undefined ? [] : ['concurrency.global'];
}

/** The Factory Level the first start creates: `config.json`'s keys copied in, or nothing set. */
export function bootstrapFactoryLevel(file: BootstrapFactoryKeys | undefined): FactoryLevelConfig {
  const global = file?.concurrency?.global;
  return global === undefined ? {} : { concurrency: { global } };
}
