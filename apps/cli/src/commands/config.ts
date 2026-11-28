import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  factoryConfigKeys,
  factoryGlobalConcurrency,
  FAIRNESS_DEFAULTS,
  RECIPE_DEFAULTS,
  type ConfigDiffEntry,
  type ConfigExport,
  type ConfigImportResult,
  type FactoryLevel,
  type ImportConfigInput,
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
    'concurrency.perProjectJobs': 'unlimited',
    'scheduling.agingStep': FAIRNESS_DEFAULTS.agingStep,
    'scheduling.agingIntervalSeconds': FAIRNESS_DEFAULTS.agingIntervalSeconds,
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

/** Keys read at each claim, never frozen into a Job (ADR-0056, ADR-0058). */
export const READ_AT_CLAIM = new Set([
  'concurrency.global',
  'concurrency.perProjectJobs',
  'scheduling.agingStep',
  'scheduling.agingIntervalSeconds',
]);

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
      (READ_AT_CLAIM.has(key)
        ? `The schedulers use the new ${key} from their next claim, for every Job.\n`
        : 'Jobs created from now on use it; existing Jobs keep the value they froze.\n'),
  );
  return 0;
}

/**
 * `factory config export` (ADR-0073): the Factory Level, the Projects and their
 * Repositories as YAML on stdout, keyed by name. No token value is in it: no
 * level stores one.
 */
export async function configExport(): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const exported = await api.json<ConfigExport>('GET', '/v1/config/export');
  const doc = new YAML.Document(exported.document);
  doc.commentBefore =
    ` factory config export, configuration version ${String(exported.configVersion)}.\n` +
    ' Re-apply with: factory config import <file>. Holds no token values.';
  process.stdout.write(doc.toString());
  return 0;
}

/**
 * `factory config import <file> [--apply --expect-version <n>]` (ADR-0073):
 * prints the diff; applies it only with `--apply` at the version the diff was
 * shown at.
 */
export async function configImport(
  file: string,
  opts: { apply: boolean; expectVersion?: number; json: boolean },
): Promise<number> {
  let document: unknown;
  try {
    document = YAML.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `factory: cannot read ${file} as YAML: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: ImportConfigInput = {
    document,
    apply: opts.apply,
    ...(opts.expectVersion === undefined ? {} : { expectedVersion: opts.expectVersion }),
  };
  const result = await api.json<ConfigImportResult>('POST', '/v1/config/import', { body });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  const version = String(result.configVersion);
  if (result.changes.length === 0) {
    process.stdout.write(`No changes: ${file} matches the configuration (version ${version}).\n`);
    return 0;
  }
  const out = [
    result.applied
      ? `Applied ${String(result.changes.length)} change(s) in one transaction (configuration version ${version}):`
      : `${String(result.changes.length)} change(s) against configuration version ${version}:`,
    ...result.changes.map(diffLine),
  ];
  if (result.applied) {
    out.push('Jobs created from now on use it; existing Jobs keep the value they froze.');
  } else {
    out.push(
      'Nothing was applied. To apply exactly this diff:',
      `  factory config import ${file} --apply --expect-version ${version}`,
    );
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function diffLine(change: ConfigDiffEntry): string {
  if (change.kind === 'create_project') return `  + Project ${change.project} (created)`;
  const where =
    change.level === 'factory'
      ? 'Factory Level'
      : change.level === 'project'
        ? `Project ${change.project ?? ''}`
        : `Repository ${change.project ?? ''}/${change.repository ?? ''}`;
  const value = (v: unknown) => (v === null ? '(unset)' : JSON.stringify(v));
  return (
    `  ${where}: ${change.key}: ${value(change.from)} -> ${value(change.to)}` +
    (change.widens ? '  [widens a permission value at its own level]' : '')
  );
}
