import {
  projectConfigKeys,
  type CreateProjectInput,
  type Project,
  type ProjectConfig,
  type ProjectDetail,
  type ProjectSummary,
  type SetProjectConfigInput,
} from '@factory/domain';
import { EXIT_NOT_RUNNING } from './lifecycle.js';
import { client } from './job.js';

/** `factory project create <name>`: the only way a Project comes to exist (ADR-0055). */
export async function projectCreate(name: string, opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: CreateProjectInput = { name };
  const project = await api.json<Project>('POST', '/v1/projects', { body });
  process.stdout.write(
    opts.json
      ? JSON.stringify(project, null, 2) + '\n'
      : `Created Project ${project.name} (${project.id})\n`,
  );
  return 0;
}

/** `factory project list`: each Project with its Repositories and active Jobs. */
export async function projectList(opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const projects = await api.json<ProjectSummary[]>('GET', '/v1/projects');
  if (opts.json) {
    process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
    return 0;
  }
  if (projects.length === 0) {
    process.stdout.write('No Projects. Create one with: factory project create <name>\n');
    return 0;
  }
  for (const p of projects) {
    const repos = p.repositories.map((r) => r.name).join(', ') || 'none';
    process.stdout.write(
      `${p.name}  (${p.id})  repositories: ${repos}  active Jobs: ${String(p.activeJobs.length)}\n`,
    );
  }
  return 0;
}

/** `factory project show <project>`: its config (the keys set), Repositories and active Jobs. */
export async function projectShow(ref: string, opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const project = await api.json<ProjectDetail>('GET', `/v1/projects/${encodeURIComponent(ref)}`);
  if (opts.json) {
    process.stdout.write(JSON.stringify(project, null, 2) + '\n');
    return 0;
  }
  const out: string[] = [
    `Project ${project.name} (${project.id})`,
    `  created: ${project.createdAt}`,
  ];
  const set = configEntries(project.config);
  out.push(
    set.length === 0
      ? 'Config: nothing set (every value inherits)'
      : 'Config (set on this Project; the rest inherits):',
  );
  const width = Math.max(0, ...set.map(([key]) => key.length));
  for (const [key, value] of set) out.push(`  ${key.padEnd(width)}  ${shown(value)}`);
  out.push(`  settable keys: ${projectConfigKeys().join(', ')}`);
  out.push(project.repositories.length === 0 ? 'Repositories: none' : 'Repositories:');
  for (const r of project.repositories) {
    out.push(`  ${r.name} (${r.id})  ${r.source}  default branch ${r.defaultBranch}`);
  }
  out.push(project.activeJobs.length === 0 ? 'Active Jobs: none' : 'Active Jobs:');
  for (const j of project.activeJobs) out.push(`  ${j.id}  ${j.status.padEnd(13)} ${j.title}`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/**
 * `factory project config set <project> <key> <value>`. The value is read as JSON
 * when it parses (`5`, `true`), else as text (`skip`); the runtime validates it.
 */
export async function projectConfigSet(ref: string, key: string, raw: string): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: SetProjectConfigInput = { key, value: parseValue(raw) };
  const project = await api.json<Project>(
    'POST',
    `/v1/projects/${encodeURIComponent(ref)}/config/set`,
    { body },
  );
  const value = valueAt(project.config, key);
  process.stdout.write(
    `Project ${project.name}: ${key} = ${shown(value)}\n` +
      (key === 'concurrency.perProjectJobs'
        ? 'The schedulers use it from their next claim, for every Job of the Project.\n'
        : 'Jobs already created keep the configuration they froze; new Jobs use this value.\n'),
  );
  return 0;
}

export function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function configEntries(config: object, prefix = ''): [string, unknown][] {
  return Object.entries(config).flatMap(([key, value]: [string, unknown]): [string, unknown][] =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? configEntries(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]],
  );
}

function valueAt(config: ProjectConfig, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  return node;
}
