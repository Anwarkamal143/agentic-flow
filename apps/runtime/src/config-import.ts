/**
 * `factory config export | import` (#113, ADR-0049, ADR-0073). The export is
 * the Factory Level, every Project and every Repository's configuration, keyed
 * by name. An import is validated by the same schemas, diffed by the pure
 * `configImportDiff`, and applied only with `apply` and the configuration
 * version the diff was shown at: one transaction, one `config.imported` event
 * and one audit row holding the diff.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AuditEntrySchema,
  CONFIG_DOCUMENT_FORMAT,
  ConfigDocumentSchema,
  configImportDiff,
  CreateProjectInputSchema,
  repositoryConfigEntry,
  RepositoryProfileSchema,
  type AuditEntry,
  type ConfigDiffEntry,
  type ConfigDocument,
  type ConfigExport,
  type ConfigImportResult,
  type ImportConfigInput,
  type ProjectConfigEntry,
  type RepositoryConfigEntry,
} from '@factory/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { bumpConfigVersion, configVersion } from './config-tree.js';
import { ApiFailure } from './errors.js';
import { read as readFactoryLevel } from './factory-level.js';
import { newId } from './ids.js';
import { cancelOpenOffers } from './issue-intake.js';
import { toProject } from './projects.js';
import { toRepository } from './repositories.js';

const ACTOR = 'user:local';
const TARGET = 'config';

export class ConfigImportService {
  constructor(
    private readonly db: FactoryDb,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  /** `GET /v1/config/export`: the stored configuration as a document, and its version. */
  export(): ConfigExport {
    return this.db.transaction((tx) => ({
      configVersion: configVersion(tx),
      document: exportDocument(tx),
    }));
  }

  /**
   * `POST /v1/config/import`: the diff of `input.document` against what is
   * stored; applied only with `apply`, which needs the version the diff was
   * shown at. Refusals change nothing.
   */
  import(input: ImportConfigInput): ConfigImportResult {
    const document = parseDocument(input.document);
    if (!input.apply) {
      return this.db.transaction((tx) => ({
        configVersion: configVersion(tx),
        applied: false,
        changes: diffOf(tx, document),
      }));
    }
    if (input.expectedVersion === undefined) {
      throw new ApiFailure(
        400,
        'expected_version_required',
        'an import is applied only with the configuration version its diff was shown at (--expect-version <n>)',
      );
    }
    const expected = input.expectedVersion;
    const result = this.db.transaction(
      (tx): ConfigImportResult => {
        const version = configVersion(tx);
        if (version !== expected) {
          throw new ApiFailure(
            409,
            'version_conflict',
            `the configuration is at version ${String(version)}, not ${String(expected)}: it changed since the diff was shown. Run factory config import <file> again to see the diff now`,
          );
        }
        const changes = diffOf(tx, document);
        if (changes.length === 0) return { configVersion: version, applied: false, changes };
        apply(tx, document, changes);
        bumpConfigVersion(tx);
        record(tx, version, version + 1, changes);
        return { configVersion: version + 1, applied: true, changes };
      },
      { behavior: 'immediate' },
    );
    if (result.applied) this.onCommit();
    return result;
  }

  /** Every applied import, oldest first. */
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

/** The stored configuration, Projects and Repositories by name. Holds no token. */
export function exportDocument(db: FactoryDb | Tx): ConfigDocument {
  const level = readFactoryLevel(db);
  const repositories = db
    .select()
    .from(schema.repositories)
    .orderBy(asc(schema.repositories.name))
    .all()
    .map(toRepository);
  const projects: Record<string, ProjectConfigEntry> = {};
  for (const row of db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all()) {
    const project = toProject(row);
    const repos: Record<string, RepositoryConfigEntry> = {};
    for (const repo of repositories.filter((r) => r.projectId === project.id)) {
      repos[repo.name] = repositoryConfigEntry(repo);
    }
    projects[project.name] = { config: project.config, repositories: repos };
  }
  return { format: CONFIG_DOCUMENT_FORMAT, factory: level?.config ?? {}, projects };
}

function parseDocument(value: unknown): ConfigDocument {
  const parsed = ConfigDocumentSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(document)'}: ${i.message}`)
      .join('; ');
    throw new ApiFailure(400, 'invalid_config_document', message);
  }
  for (const name of Object.keys(parsed.data.projects)) {
    const valid = CreateProjectInputSchema.shape.name.safeParse(name);
    if (!valid.success) {
      throw new ApiFailure(
        400,
        'invalid_config_document',
        `projects.${name}: a Project name must be letters, digits, ".", "_" or "-"`,
      );
    }
  }
  return parsed.data;
}

/** The diff against what is stored; a refusal is `409`. */
function diffOf(tx: Tx, document: ConfigDocument): ConfigDiffEntry[] {
  const diff = configImportDiff(exportDocument(tx), document);
  if (!diff.ok) throw new ApiFailure(409, diff.code, diff.message);
  assertIntakeCoordinates(tx, document);
  return diff.changes;
}

/** An intake label needs GitHub Coordinates (ADR-0072), which an import never sets. */
function assertIntakeCoordinates(tx: Tx, document: ConfigDocument): void {
  for (const { project, name, entry } of repositoryEntries(document)) {
    if (entry.intakeLabel === null) continue;
    const row = repositoryRow(tx, project, name);
    if (row.githubOwner === null || row.githubName === null) {
      throw new ApiFailure(
        409,
        'no_github_coordinates',
        `Repository ${name} has no GitHub coordinates, so it has no issues to take in: its intakeLabel must be null`,
      );
    }
  }
}

function apply(tx: Tx, document: ConfigDocument, changes: ConfigDiffEntry[]): void {
  const now = new Date().toISOString();
  const changed = (level: string, project: string | null, repository: string | null) =>
    changes.some(
      (c) =>
        c.kind === 'set' &&
        c.level === level &&
        c.project === project &&
        c.repository === repository,
    );

  if (changed('factory', null, null)) {
    tx.update(schema.factoryLevel)
      .set({
        configJson: JSON.stringify(document.factory),
        version: sql`${schema.factoryLevel.version} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.factoryLevel.id, 'factory'))
      .run();
  }
  for (const [name, project] of Object.entries(document.projects)) {
    const created = changes.some((c) => c.kind === 'create_project' && c.project === name);
    if (created) {
      tx.insert(schema.projects)
        .values({
          id: newId('prj'),
          name,
          configJson: JSON.stringify(project.config),
          createdAt: now,
        })
        .run();
    } else if (changed('project', name, null)) {
      tx.update(schema.projects)
        .set({ configJson: JSON.stringify(project.config) })
        .where(eq(schema.projects.name, name))
        .run();
    }
  }
  for (const { project, name, entry } of repositoryEntries(document)) {
    if (!changed('repository', project, name)) continue;
    const row = repositoryRow(tx, project, name);
    const current = toRepository(row);
    // The document gives the profile's settable fields in full: one it leaves out is unset.
    const kept = Object.fromEntries(
      Object.entries(current.profile).filter(([k]) => k !== 'requiredChecks' && k !== 'setup'),
    );
    const profile = RepositoryProfileSchema.parse({
      ...kept,
      ...entry.profile,
      confirmedBy: ACTOR,
      confirmedAt: now,
    });
    const profileChanged = changes.some(
      (c) =>
        c.kind === 'set' &&
        c.repository === name &&
        c.project === project &&
        c.key.startsWith('profile.'),
    );
    tx.update(schema.repositories)
      .set({
        mergePolicy: entry.mergePolicy,
        mergeMethod: entry.mergeMethod,
        intakeLabel: entry.intakeLabel,
        ...(profileChanged ? { profileJson: JSON.stringify(profile) } : {}),
      })
      .where(eq(schema.repositories.id, row.id))
      .run();
    if (current.intakeLabel !== null && entry.intakeLabel === null) {
      cancelOpenOffers(tx, row.id, ACTOR);
    }
  }
}

/** The one audit row and the one `config.imported` event of an applied import. */
function record(tx: Tx, before: number, after: number, changes: ConfigDiffEntry[]): void {
  const auditId = newId('aud');
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: new Date().toISOString(),
      actor: ACTOR,
      action: 'config.imported',
      target: TARGET,
      jobId: null,
      beforeJson: JSON.stringify({ configVersion: before }),
      afterJson: JSON.stringify({ configVersion: after, changes }),
      policyRef: null,
      correlationId: null,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'factory',
    entityId: 'factory',
    type: 'config.imported',
    actor: ACTOR,
    payload: { auditId, configVersion: after, changes },
  });
}

function repositoryEntries(
  document: ConfigDocument,
): { project: string; name: string; entry: RepositoryConfigEntry }[] {
  return Object.entries(document.projects).flatMap(([project, p]) =>
    Object.entries(p.repositories).map(([name, entry]) => ({ project, name, entry })),
  );
}

/** A Repository the diff has found registered in `project`. */
function repositoryRow(
  tx: Tx,
  project: string,
  name: string,
): typeof schema.repositories.$inferSelect {
  const row = tx
    .select({ repository: schema.repositories })
    .from(schema.repositories)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.repositories.projectId))
    .where(sql`${schema.projects.name} = ${project} and ${schema.repositories.name} = ${name}`)
    .get();
  if (row === undefined) throw new Error(`Repository ${project}/${name} vanished`);
  return row.repository;
}
