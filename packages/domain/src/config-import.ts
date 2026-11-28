/**
 * Config export and import (#113, ADR-0049, ADR-0073): the YAML document of the
 * Factory Level, the Projects and their Repositories keyed by name, and the
 * pure diff an import shows before anything is applied. The document holds no
 * secret: no level stores a token (the Token Reference lives in `config.json`,
 * which is bootstrap-only and is not exported).
 */
import { z } from 'zod';
import { configTreeViolation, PERMISSION_ORDER, type ConfigTree } from './config-levels.js';
import { FactoryLevelConfigSchema } from './factory-level.js';
import { IntakeLabelSchema } from './issue-intake.js';
import { MergeMethodSchema, MergePolicySchema } from './merge-gate.js';
import { PackageManagerSchema, ProfileCommandsSchema } from './profile.js';
import { SetupCommandSchema } from './setup.js';
import { ProjectConfigSchema, type Repository } from './index.js';

/** The `format` line every document starts with; another value is refused. */
export const CONFIG_DOCUMENT_FORMAT = 'factory-config@1';

const pathList = z.array(z.string().trim().min(1).max(500)).max(200);

/**
 * A Repository's human-set configuration: its Merge Policy and merge method, its
 * intake label, and the settable fields of its Repository Profile. Registration
 * facts (source, Factory Clone, GitHub Coordinates) and what detection alone
 * writes (detection status, CI files, the confirmation stamp) are not in it.
 */
export const RepositoryConfigEntrySchema = z
  .object({
    mergePolicy: MergePolicySchema,
    mergeMethod: MergeMethodSchema,
    /** `null`: no GitHub Issues intake (ADR-0072). */
    intakeLabel: IntakeLabelSchema.nullable(),
    profile: z
      .object({
        packageManager: PackageManagerSchema.nullable(),
        commands: ProfileCommandsSchema,
        instructionFiles: pathList,
        sensitivePaths: pathList,
        requiredChecks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        setup: SetupCommandSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type RepositoryConfigEntry = z.infer<typeof RepositoryConfigEntrySchema>;

/** A Project's own config and its Repositories by name. */
export const ProjectConfigEntrySchema = z
  .object({
    // Lazy: `ProjectConfigSchema` is defined in `index.ts`, which re-exports this module.
    config: z.lazy(() => ProjectConfigSchema).default({}),
    repositories: z.record(z.string().min(1).max(255), RepositoryConfigEntrySchema).default({}),
  })
  .strict();
export type ProjectConfigEntry = z.infer<typeof ProjectConfigEntrySchema>;

/**
 * The document `config export` writes and `config import` reads. Each entity it
 * names is given in full (a key left out is unset); Projects and Repositories
 * it leaves out are unchanged, since an import never deletes.
 */
export const ConfigDocumentSchema = z
  .object({
    format: z.literal(CONFIG_DOCUMENT_FORMAT),
    factory: FactoryLevelConfigSchema,
    projects: z.record(z.string().min(1).max(100), ProjectConfigEntrySchema).default({}),
  })
  .strict();
export type ConfigDocument = z.infer<typeof ConfigDocumentSchema>;

/** `POST /v1/config/import`: the document, and whether to apply it. */
export const ImportConfigInputSchema = z.object({
  document: z.unknown(),
  apply: z.boolean().default(false),
  /** Required with `apply`: the configuration version the diff was shown at. */
  expectedVersion: z.number().int().min(1).optional(),
});
export type ImportConfigInput = z.infer<typeof ImportConfigInputSchema>;

export const ConfigLevelSchema = z.enum(['factory', 'project', 'repository']);
export type ConfigLevel = z.infer<typeof ConfigLevelSchema>;

/** One change an import makes. `from`/`to` `null`: unset. */
export const ConfigDiffEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_project'), project: z.string() }),
  z.object({
    kind: z.literal('set'),
    level: ConfigLevelSchema,
    project: z.string().nullable(),
    repository: z.string().nullable(),
    /** The dotted leaf key (`concurrency.global`, `profile.commands.test.run`). */
    key: z.string(),
    from: z.unknown(),
    to: z.unknown(),
    /** A permission value made wider at its own level: allowed, but flagged. */
    widens: z.boolean(),
  }),
]);
export type ConfigDiffEntry = z.infer<typeof ConfigDiffEntrySchema>;

/** `GET /v1/config/export`. */
export const ConfigExportSchema = z.object({
  /** Bumped by every configuration change; what `--expect-version` names. */
  configVersion: z.number().int().min(1),
  document: ConfigDocumentSchema,
});
export type ConfigExport = z.infer<typeof ConfigExportSchema>;

/** `POST /v1/config/import`: the diff, and whether it was applied. */
export const ConfigImportResultSchema = z.object({
  /** The configuration version after the call (bumped by one when applied). */
  configVersion: z.number().int().min(1),
  applied: z.boolean(),
  changes: z.array(ConfigDiffEntrySchema),
});
export type ConfigImportResult = z.infer<typeof ConfigImportResultSchema>;

export type ConfigDiffResult =
  | { ok: true; changes: ConfigDiffEntry[] }
  | {
      ok: false;
      code: 'repository_not_registered' | 'config_widens_parent';
      message: string;
    };

/** A Repository's entry in the document, from the stored Repository. */
export function repositoryConfigEntry(repository: Repository): RepositoryConfigEntry {
  const { profile } = repository;
  return {
    mergePolicy: repository.mergePolicy,
    mergeMethod: repository.mergeMethod,
    intakeLabel: repository.intakeLabel,
    profile: {
      packageManager: profile.packageManager,
      commands: profile.commands,
      instructionFiles: profile.instructionFiles,
      sensitivePaths: profile.sensitivePaths,
      ...(profile.requiredChecks === undefined ? {} : { requiredChecks: profile.requiredChecks }),
      ...(profile.setup === undefined ? {} : { setup: profile.setup }),
    },
  };
}

/**
 * What importing `incoming` over `current` (the export of what is stored)
 * changes, leaf by leaf, ordered Factory Level, then each Project by name with
 * its Repositories by name. Refused when `incoming` names a Repository not
 * registered in that Project, or when the result leaves any level wider than
 * its parent (the whole tree is checked, so Projects left out are too).
 */
export function configImportDiff(
  current: ConfigDocument,
  incoming: ConfigDocument,
): ConfigDiffResult {
  for (const [projectName, project] of sortedEntries(incoming.projects)) {
    for (const repoName of Object.keys(project.repositories).sort()) {
      if (current.projects[projectName]?.repositories[repoName] !== undefined) continue;
      const home = Object.entries(current.projects).find(
        ([, p]) => p.repositories[repoName] !== undefined,
      )?.[0];
      return {
        ok: false,
        code: 'repository_not_registered',
        message:
          `Repository '${repoName}' is not registered in Project '${projectName}'` +
          (home === undefined ? '' : ` (it is registered in Project '${home}')`) +
          `. An import never registers a Repository: run factory repo add <path> --project ${projectName} first.`,
      };
    }
  }

  const merged = mergedDocument(current, incoming);
  const violation = configTreeViolation(treeOf(merged));
  if (violation !== undefined) return { ok: false, ...violation };

  const changes: ConfigDiffEntry[] = leafChanges(current.factory, incoming.factory).map((c) => ({
    kind: 'set',
    level: 'factory',
    project: null,
    repository: null,
    ...c,
    widens: widens('factory', c.key, c.from, c.to),
  }));
  for (const [projectName, project] of sortedEntries(incoming.projects)) {
    const before = current.projects[projectName];
    if (before === undefined) changes.push({ kind: 'create_project', project: projectName });
    for (const c of leafChanges(before?.config ?? {}, project.config)) {
      changes.push({
        kind: 'set',
        level: 'project',
        project: projectName,
        repository: null,
        ...c,
        widens: widens('project', c.key, c.from, c.to),
      });
    }
    for (const [repoName, repo] of sortedEntries(project.repositories)) {
      for (const c of leafChanges(before?.repositories[repoName] ?? {}, repo)) {
        changes.push({
          kind: 'set',
          level: 'repository',
          project: projectName,
          repository: repoName,
          ...c,
          widens: widens('repository', c.key, c.from, c.to),
        });
      }
    }
  }
  return { ok: true, changes };
}

/** `current` with what `incoming` names replaced; what it leaves out kept. */
function mergedDocument(current: ConfigDocument, incoming: ConfigDocument): ConfigDocument {
  const projects: Record<string, ProjectConfigEntry> = { ...current.projects };
  for (const [name, project] of Object.entries(incoming.projects)) {
    projects[name] = {
      config: project.config,
      repositories: { ...current.projects[name]?.repositories, ...project.repositories },
    };
  }
  return { format: CONFIG_DOCUMENT_FORMAT, factory: incoming.factory, projects };
}

function treeOf(document: ConfigDocument): ConfigTree {
  return {
    factory: document.factory,
    projects: sortedEntries(document.projects).map(([name, project]) => ({
      name,
      config: project.config,
      repositories: sortedEntries(project.repositories).map(([repoName, repo]) => ({
        name: repoName,
        mergePolicy: repo.mergePolicy,
      })),
    })),
  };
}

/**
 * Whether a change makes a permission value wider at its own level. An unset
 * `planApproval` reads as the recipe default `required`; an unset Factory or
 * Project `mergePolicy` is no ceiling, wider than any value.
 */
function widens(level: ConfigLevel, key: string, from: unknown, to: unknown): boolean {
  if (key !== 'mergePolicy' && key !== 'planApproval') return false;
  const order: readonly string[] = PERMISSION_ORDER[key];
  const unset = key === 'planApproval' ? 0 : order.length;
  const rank = (value: unknown): number => {
    if (value === null) return level === 'repository' ? 0 : unset;
    return typeof value === 'string' ? order.indexOf(value) : -1;
  };
  return rank(to) > rank(from);
}

interface LeafChange {
  key: string;
  from: unknown;
  to: unknown;
}

/** The dotted leaves that differ between two objects; lists compare whole, key order never counts. */
function leafChanges(before: object, after: object): LeafChange[] {
  const a = leaves(before);
  const b = leaves(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys
    .filter((k) => canonical(a.get(k)) !== canonical(b.get(k)))
    .map((key) => ({ key, from: a.get(key) ?? null, to: b.get(key) ?? null }));
}

function leaves(
  value: object,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      leaves(inner as object, `${prefix}${key}.`, out);
    } else {
      out.set(`${prefix}${key}`, inner);
    }
  }
  return out;
}

function canonical(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
