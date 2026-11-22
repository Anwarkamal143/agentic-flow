import {
  factoryConfigKeys,
  factoryGlobalConcurrency,
  RECIPE_DEFAULTS,
  type FactoryLevel,
  type SetFactoryConfigInput,
} from '@factory/domain';
import { EXIT_NOT_RUNNING } from './lifecycle.js';
import { client } from './job.js';
import { configEntries, parseValue, shown } from './project.js';

/**
 * `factory config show`: the Factory Level (ADR-0056), its version, and each
 * settable key's value with where it comes from (`factory` when set, else `default`).
 */
export async function configShow(opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const level = await api.json<FactoryLevel>('GET', '/v1/factory/config');
  if (opts.json) {
    process.stdout.write(JSON.stringify(level, null, 2) + '\n');
    return 0;
  }
  const set = new Map(configEntries(level.config));
  // What applies when the key is unset: the recipe default (`mergePolicy`: each Repository's own).
  const defaults: Record<string, unknown> = {
    maxAttempts: RECIPE_DEFAULTS.maxAttempts,
    maxRetries: RECIPE_DEFAULTS.maxRetries,
    maxQuestions: RECIPE_DEFAULTS.maxQuestions,
    planApproval: RECIPE_DEFAULTS.planApproval,
    maxReplans: RECIPE_DEFAULTS.maxReplans,
    'review.rerunOnBaseChange': RECIPE_DEFAULTS.reviewRerunOnBaseChange,
    mergePolicy: "each Repository's own",
    'concurrency.global': factoryGlobalConcurrency(level.config),
    'concurrency.perRepository': RECIPE_DEFAULTS.concurrency.perRepository,
    'concurrency.perJob': RECIPE_DEFAULTS.concurrency.perJob,
  };
  const keys = factoryConfigKeys();
  const width = Math.max(...keys.map((k) => k.length));
  const out = [`Factory Level (version ${String(level.version)})`, `  updated: ${level.updatedAt}`];
  for (const key of keys) {
    const source = set.has(key) ? 'factory' : 'default';
    out.push(`  ${key.padEnd(width)}  ${shown(set.get(key) ?? defaults[key])}  (${source})`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/**
 * `factory config set <key> <value> [--expect-version <n>]`. The value is read as
 * JSON when it parses (`5`), else as text; the runtime validates it.
 */
export async function configSet(
  key: string,
  raw: string,
  opts: { expectVersion?: number },
): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: SetFactoryConfigInput = {
    key,
    value: parseValue(raw),
    ...(opts.expectVersion === undefined ? {} : { expectedVersion: opts.expectVersion }),
  };
  const level = await api.json<FactoryLevel>('POST', '/v1/factory/config/set', { body });
  const value = new Map(configEntries(level.config)).get(key);
  process.stdout.write(
    `Factory Level: ${key} = ${shown(value)} (version ${String(level.version)})\n` +
      (key === 'concurrency.global'
        ? 'The Task scheduler uses a new concurrency.global from its next claim.\n'
        : 'Jobs created from now on use it; existing Jobs keep the value they froze.\n'),
  );
  return 0;
}
