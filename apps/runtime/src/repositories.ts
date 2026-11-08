/**
 * Repository registration (PRODUCT_SPEC §13, ARCHITECTURE §10, ADR-0001).
 *
 * The source checkout is only ever read: its `origin` URL, and `package.json`
 * plus lockfile names for command detection. Every Worktree later comes from the
 * Factory Clone made here, under `<workspace_root>/clones/<repo-id>`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { appendEvent, schema, type FactoryDb } from '@factory/db';
import {
  RepositoryProfileSchema,
  type PackageManager,
  type Project,
  type RegisterRepositoryInput,
  type RegisterRepositoryResult,
  type Repository,
  type RepositoryCommands,
  type RepositoryInspection,
} from '@factory/domain';
import {
  clone,
  currentBranch,
  GitError,
  hasEmbeddedCredentials,
  originUrl,
  workTreeRoot,
} from '@factory/git';
import { and, eq, or } from 'drizzle-orm';
import { ApiFailure } from './errors.js';

const ACTOR = 'user:local';

export class RepositoryService {
  constructor(
    private readonly db: FactoryDb,
    private readonly workspaceRoot: string,
  ) {}

  /** A read-only look at `path`: where its repository is, its origin, and proposed commands. */
  async inspect(path: string): Promise<RepositoryInspection> {
    const source = await workTreeRoot(path);
    if (source === undefined) {
      throw new ApiFailure(400, 'not_a_repository', `${path} is not inside a git working tree`);
    }
    const origin = await originUrl(source);
    if (origin !== undefined && hasEmbeddedCredentials(origin)) {
      // The value is never stored, returned or logged (CLAUDE.md §2).
      throw new ApiFailure(
        400,
        'credentials_in_url',
        `the origin URL of ${source} has embedded credentials. Use a credential helper or SSH, then retry`,
      );
    }
    // A relative origin (e.g. `../upstream.git`) is relative to the source repository.
    const remoteUrl = origin === undefined ? null : resolveRemote(source, origin);
    return { source, name: basename(source), remoteUrl, ...detectCommands(source) };
  }

  async register(input: RegisterRepositoryInput): Promise<RegisterRepositoryResult> {
    const inspection = await this.inspect(input.path);
    const { source, name, remoteUrl } = inspection;
    // Checked again inside the transaction; this early check avoids a needless clone.
    const already = this.db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(eq(schema.repositories.source, source))
      .get();
    if (already !== undefined) {
      throw new ApiFailure(
        409,
        'already_registered',
        `${source} is already registered (${already.id})`,
      );
    }

    const id = newId('repo');
    const clonesDir = join(this.workspaceRoot, 'clones');
    const clonePath = join(clonesDir, id);
    mkdirSync(clonesDir, { recursive: true });
    const cloneMethod: RegisterRepositoryResult['cloneMethod'] =
      remoteUrl === null ? 'path' : 'origin_with_reference';
    try {
      if (remoteUrl === null) await clone({ from: source, dest: clonePath });
      else await clone({ from: remoteUrl, dest: clonePath, reference: source });
      const defaultBranch = await currentBranch(clonePath).catch((err: unknown) => {
        throw new ApiFailure(
          422,
          'no_default_branch',
          `the Factory Clone has no checked-out branch (is the source's HEAD detached?): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      const now = new Date().toISOString();
      const profile = RepositoryProfileSchema.parse({
        version: 1,
        packageManager: inspection.packageManager,
        commands: input.commands,
        confirmedBy: ACTOR,
        confirmedAt: now,
      });
      const project = this.db.transaction((tx) => {
        const proj = findOrCreateProject(tx, input.project, now);
        const clash = tx
          .select({ id: schema.repositories.id })
          .from(schema.repositories)
          .where(
            or(
              eq(schema.repositories.source, source),
              and(eq(schema.repositories.projectId, proj.id), eq(schema.repositories.name, name)),
            ),
          )
          .get();
        if (clash !== undefined) {
          throw new ApiFailure(
            409,
            'already_registered',
            `${source} is already registered, or Project '${proj.name}' already has a Repository named '${name}' (${clash.id})`,
          );
        }
        tx.insert(schema.repositories)
          .values({
            id,
            projectId: proj.id,
            name,
            source,
            remoteUrl,
            clonePath,
            defaultBranch,
            profileJson: JSON.stringify(profile),
            createdAt: now,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'repository',
          entityId: id,
          type: 'repository.registered',
          actor: ACTOR,
          payload: { projectId: proj.id, name, cloneMethod, defaultBranch },
        });
        return proj;
      });
      const repository: Repository = {
        id,
        projectId: project.id,
        name,
        source,
        remoteUrl,
        clonePath,
        defaultBranch,
        profile,
        createdAt: now,
      };
      return { project, repository, cloneMethod };
    } catch (err) {
      // The clone was made by this call and holds no work yet: safe to remove.
      rmSync(clonePath, { recursive: true, force: true });
      if (err instanceof GitError) {
        throw new ApiFailure(
          422,
          'clone_failed',
          `could not create the Factory Clone: ${err.message}`,
        );
      }
      throw err;
    }
  }

  listProjects(): Project[] {
    return this.db.select().from(schema.projects).all().map(toProject);
  }

  listRepositories(): Repository[] {
    return this.db.select().from(schema.repositories).all().map(toRepository);
  }
}

type Tx = Parameters<Parameters<FactoryDb['transaction']>[0]>[0];

function findOrCreateProject(tx: Tx, name: string, now: string): Project {
  const existing = tx.select().from(schema.projects).where(eq(schema.projects.name, name)).get();
  if (existing !== undefined) return toProject(existing);
  const project: Project = { id: newId('prj'), name, createdAt: now };
  tx.insert(schema.projects)
    .values({ id: project.id, name, configJson: '{}', createdAt: now })
    .run();
  appendEvent(tx, {
    entityKind: 'project',
    entityId: project.id,
    type: 'project.created',
    actor: ACTOR,
    payload: { name },
  });
  return project;
}

function toProject(row: typeof schema.projects.$inferSelect): Project {
  return { id: row.id, name: row.name, createdAt: row.createdAt };
}

function toRepository(row: typeof schema.repositories.$inferSelect): Repository {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    source: row.source,
    remoteUrl: row.remoteUrl,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    profile: RepositoryProfileSchema.parse(JSON.parse(row.profileJson)),
    createdAt: row.createdAt,
  };
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function resolveRemote(source: string, url: string): string {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^/:]+:/.test(url);
  return isUrl || isAbsolute(url) ? url : resolve(source, url);
}

/**
 * Proposes test and typecheck commands from `package.json`. The result is a
 * proposal only: the operator confirms or replaces it before it is saved.
 * Repository content is untrusted, so a malformed file just means "nothing detected".
 */
function detectCommands(
  source: string,
): Pick<RepositoryInspection, 'packageManager' | 'detectedCommands'> {
  const none = { packageManager: null, detectedCommands: { test: null, typecheck: null } };
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  } catch {
    return none;
  }
  if (typeof pkg !== 'object' || pkg === null) return none;
  const manifest = pkg as { scripts?: unknown; packageManager?: unknown };
  const scripts =
    typeof manifest.scripts === 'object' && manifest.scripts !== null
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const pm = packageManagerOf(source, manifest.packageManager);
  const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);

  const testScript = scripts['test'];
  const isNpmPlaceholder =
    typeof testScript === 'string' && testScript.includes('no test specified');
  const test =
    typeof testScript === 'string' && !isNpmPlaceholder
      ? pm === 'bun'
        ? run('test')
        : `${pm} test`
      : null;

  const typecheckScript = ['typecheck', 'type-check', 'tsc'].find(
    (s) => typeof scripts[s] === 'string',
  );
  const commands: RepositoryCommands = {
    test,
    typecheck: typecheckScript === undefined ? null : run(typecheckScript),
  };
  return { packageManager: pm, detectedCommands: commands };
}

function packageManagerOf(source: string, declared: unknown): PackageManager {
  if (typeof declared === 'string') {
    const name = declared.split('@', 1)[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  if (existsSync(join(source, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(source, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(source, 'bun.lock')) || existsSync(join(source, 'bun.lockb'))) return 'bun';
  return 'npm';
}
