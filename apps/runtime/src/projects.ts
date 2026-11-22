/**
 * Projects (PRODUCT_SPEC §5, ADR-0055): created only by `project create`, listed
 * with their Repositories and active Jobs, and configured one key at a time.
 * Every change is one transaction with its event.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  chooseProject,
  ProjectConfigSchema,
  setProjectConfigKey,
  TERMINAL_JOB_STATUSES,
  type CreateProjectInput,
  type Project,
  type ProjectConfig,
  type ProjectDetail,
  type ProjectJob,
  type ProjectSummary,
  type SetProjectConfigInput,
} from '@factory/domain';
import { asc, eq } from 'drizzle-orm';
import { assertNarrowing } from './config-tree.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { toRepository } from './repositories.js';

const ACTOR = 'user:local';

export class ProjectService {
  constructor(
    private readonly db: FactoryDb,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
  ) {}

  create(input: CreateProjectInput): Project {
    const project = this.db.transaction(
      (tx) => {
        const existing = tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.name, input.name))
          .get();
        if (existing !== undefined) {
          throw new ApiFailure(
            409,
            'project_exists',
            `Project '${input.name}' already exists (${existing.id})`,
          );
        }
        const created: Project = {
          id: newId('prj'),
          name: input.name,
          config: {},
          createdAt: new Date().toISOString(),
        };
        tx.insert(schema.projects)
          .values({
            id: created.id,
            name: created.name,
            configJson: '{}',
            createdAt: created.createdAt,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'project',
          entityId: created.id,
          type: 'project.created',
          actor: ACTOR,
          payload: { name: created.name },
        });
        return created;
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return project;
  }

  /** Every Project by name, each with its Repositories and active Jobs. */
  list(): ProjectSummary[] {
    const repos = this.db
      .select({
        id: schema.repositories.id,
        name: schema.repositories.name,
        projectId: schema.repositories.projectId,
      })
      .from(schema.repositories)
      .orderBy(asc(schema.repositories.name))
      .all();
    const jobs = this.activeJobs();
    return this.db
      .select()
      .from(schema.projects)
      .orderBy(asc(schema.projects.name))
      .all()
      .map((row) => ({
        ...toProject(row),
        repositories: repos
          .filter((r) => r.projectId === row.id)
          .map((r) => ({ id: r.id, name: r.name })),
        activeJobs: jobs.get(row.id) ?? [],
      }));
  }

  /** One Project, by id or name: its config, its Repositories in full and its active Jobs. */
  show(ref: string): ProjectDetail {
    const project = this.find(this.db, ref);
    const repositories = this.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.projectId, project.id))
      .orderBy(asc(schema.repositories.name))
      .all()
      .map(toRepository);
    return { ...project, repositories, activeJobs: this.activeJobs().get(project.id) ?? [] };
  }

  /** `project config set`: one key, validated by the Project config schema. */
  setConfigKey(ref: string, input: SetProjectConfigInput): Project {
    const updated = this.db.transaction(
      (tx) => {
        const project = this.find(tx, ref);
        const change = setProjectConfigKey(project.config, input.key, input.value);
        if (!change.ok) throw new ApiFailure(400, change.code, change.message);
        assertNarrowing(tx, { project: { id: project.id, config: change.config } });
        return writeConfig(tx, project, change.config, { key: input.key });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return updated;
  }

  /**
   * Replaces a Project's config. Jobs already created keep the Effective
   * Configuration they froze at creation; only new Jobs see the change.
   */
  replaceConfig(id: string, config: ProjectConfig): Project {
    const updated = this.db.transaction(
      (tx) => {
        const row = tx.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
        if (row === undefined) throw new ApiFailure(404, 'project_not_found', `no Project ${id}`);
        assertNarrowing(tx, { project: { id, config } });
        return writeConfig(tx, toProject(row), config, {});
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return updated;
  }

  private find(db: FactoryDb | Tx, ref: string): Project {
    const rows = db.select().from(schema.projects).all();
    const choice = chooseProject(rows, ref);
    if (!choice.ok) throw new ApiFailure(404, choice.code, choice.message);
    return toProject(choice.project);
  }

  private activeJobs(): Map<string, ProjectJob[]> {
    const byProject = new Map<string, ProjectJob[]>();
    const rows = this.db
      .select({
        id: schema.jobs.id,
        title: schema.jobs.title,
        status: schema.jobs.status,
        projectId: schema.jobs.projectId,
      })
      .from(schema.jobs)
      .orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.id))
      .all();
    for (const row of rows) {
      if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(row.status)) continue;
      const list = byProject.get(row.projectId) ?? [];
      list.push({ id: row.id, title: row.title, status: row.status });
      byProject.set(row.projectId, list);
    }
    return byProject;
  }
}

function writeConfig(
  tx: Tx,
  project: Project,
  config: ProjectConfig,
  extra: { key?: string },
): Project {
  tx.update(schema.projects)
    .set({ configJson: JSON.stringify(config) })
    .where(eq(schema.projects.id, project.id))
    .run();
  appendEvent(tx, {
    entityKind: 'project',
    entityId: project.id,
    type: 'project.config_updated',
    actor: ACTOR,
    payload: { ...extra, before: project.config, after: config },
  });
  return { ...project, config };
}

export function toProject(row: typeof schema.projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    config: ProjectConfigSchema.parse(JSON.parse(row.configJson)),
    createdAt: row.createdAt,
  };
}
