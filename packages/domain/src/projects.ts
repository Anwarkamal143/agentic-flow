/**
 * Projects are first-class (PRODUCT_SPEC §5, ADR-0055). A Project is created
 * only by `project create`; everything else names one, and one is inferred only
 * when exactly one exists. Pure rules, shared by the runtime and the CLI.
 */
import { z } from 'zod';
import { ProjectConfigSchema, type ProjectConfig } from './index.js';

export type ProjectChoice<P> =
  | { ok: true; project: P }
  | { ok: false; code: 'project_not_found' | 'no_projects' | 'project_required'; message: string };

/**
 * The Project `ref` (an id or a name) names, or the only Project when `ref` is
 * undefined. Never creates one: an unknown name is an error listing the Projects.
 */
export function chooseProject<P extends { id: string; name: string }>(
  projects: readonly P[],
  ref: string | undefined,
): ProjectChoice<P> {
  const names = projects
    .map((p) => p.name)
    .sort()
    .join(', ');
  if (ref !== undefined) {
    const found = projects.find((p) => p.id === ref || p.name === ref);
    if (found !== undefined) return { ok: true, project: found };
    return {
      ok: false,
      code: 'project_not_found',
      message: `no Project '${ref}'. Projects: ${names === '' ? 'none' : names}. Create one with: factory project create ${ref}`,
    };
  }
  const [only, ...others] = projects;
  if (only === undefined) {
    return {
      ok: false,
      code: 'no_projects',
      message: 'no Projects yet. Create one with: factory project create <name>',
    };
  }
  if (others.length > 0) {
    return {
      ok: false,
      code: 'project_required',
      message: `there are several Projects (${names}); name one with --project`,
    };
  }
  return { ok: true, project: only };
}

/** The settable Project config keys, dotted for nested ones (`concurrency.perJob`). */
export function projectConfigKeys(): string[] {
  return configLeafKeys(ProjectConfigSchema);
}

/** The leaf keys of a config schema, dotted for nested ones. */
export function configLeafKeys(schema: z.ZodObject, prefix = ''): string[] {
  return Object.entries(schema.shape).flatMap(([key, field]) => {
    const inner: unknown = field instanceof z.ZodOptional ? field.unwrap() : field;
    return inner instanceof z.ZodObject
      ? configLeafKeys(inner, `${prefix}${key}.`)
      : [`${prefix}${key}`];
  });
}

export type ConfigKeyChange<C> =
  | { ok: true; config: C }
  | { ok: false; code: 'unknown_config_key' | 'invalid_config_value'; message: string };

export type ProjectConfigChange = ConfigKeyChange<ProjectConfig>;

/**
 * `config` with one key set (`project config set`). The key must be a leaf of the
 * Project config schema and the result must validate; `config` is not changed.
 */
export function setProjectConfigKey(
  config: ProjectConfig,
  key: string,
  value: unknown,
): ProjectConfigChange {
  return setConfigKey(ProjectConfigSchema, 'Project', config, key, value);
}

/**
 * `config` with one dotted leaf `key` of `schema` set to `value`, validated by
 * `schema`; `config` is not changed. `level` names the level in messages.
 */
export function setConfigKey<S extends z.ZodObject>(
  schema: S,
  level: string,
  config: z.infer<S>,
  key: string,
  value: unknown,
): ConfigKeyChange<z.infer<S>> {
  const known = configLeafKeys(schema);
  if (!known.includes(key)) {
    return {
      ok: false,
      code: 'unknown_config_key',
      message: `unknown ${level} config key '${key}'. Known keys: ${known.join(', ')}`,
    };
  }
  const next = structuredClone(config) as Record<string, unknown>;
  const path = key.split('.');
  const leaf = path.pop() as string;
  let node = next;
  for (const part of path) {
    const child = node[part];
    const object =
      typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {};
    node[part] = object;
    node = object;
  }
  node[leaf] = value;
  const parsed = schema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: 'invalid_config_value',
      message: `${key}: ${issue?.message ?? 'invalid value'}`,
    };
  }
  return { ok: true, config: parsed.data };
}
