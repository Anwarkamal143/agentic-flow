/**
 * Repository registration (PRODUCT_SPEC §13, ARCHITECTURE §10, ADR-0001).
 *
 * The source checkout is only ever read: its `origin` URL, and for Profile
 * Detection (ADR-0060) the paths and a few files of its HEAD commit, through
 * git plumbing. Every Worktree later comes from the
 * Factory Clone made here, under `<workspace_root>/clones/<repo-id>`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  chooseProject,
  coordinatesFromRemoteUrl,
  detectProfile,
  type FileSnapshot,
  profileDetectionReads,
  EffectiveConfigSchema,
  type EffectiveConfigPreview,
  repositoryConfigOf,
  type RepositoryEffectiveConfig,
  formatCoordinates,
  MergeMethodSchema,
  MergePolicySchema,
  parseCoordinates,
  RepositoryProfileSchema,
  type Project,
  type RegisterRepositoryInput,
  type RegisterRepositoryResult,
  type Repository,
  type RepositoryInspection,
  type GitHubCoordinates,
  applyDetection,
  profileChanges,
  profileDiff,
  setProfileField,
  type ApplyProfileDetectionInput,
  type ProfileChange,
  type ProfileDetection,
  type ProfileUpdate,
  type RepositoryProfile,
  type SetProfileFieldInput,
  type SetIntakeLabelInput,
} from '@factory/domain';
import {
  clone,
  committedFile,
  committedPaths,
  currentBranch,
  GitError,
  hasEmbeddedCredentials,
  originUrl,
  workTreeRoot,
} from '@factory/git';
import { and, eq, or } from 'drizzle-orm';
import { assertNarrowing, bumpConfigVersion } from './config-tree.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { cancelOpenOffers } from './issue-intake.js';
import { previewOf, toProject } from './projects.js';

const ACTOR = 'user:local';

export class RepositoryService {
  constructor(
    private readonly db: FactoryDb,
    private readonly workspaceRoot: string,
    /** Called after every committed change, so the outbox publishes promptly. */
    private readonly onCommit: () => void = () => undefined,
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
    const github = remoteUrl === null ? null : coordinatesFromRemoteUrl(remoteUrl);
    const detected = detectProfile(await snapshotOf(source, 'HEAD'));
    return { source, name: basename(source), remoteUrl, github, detected };
  }

  async register(input: RegisterRepositoryInput): Promise<RegisterRepositoryResult> {
    const inspection = await this.inspect(input.path);
    const { source, name, remoteUrl } = inspection;
    const github = input.github === undefined ? inspection.github : parsedCoordinates(input.github);
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

    // Checked again inside the transaction; refused before the clone, so nothing is made.
    const target = findProject(this.db, input.project);
    const intakeLabel = input.intakeLabel ?? null;
    if (intakeLabel !== null && github === null) throw noCoordinatesForIntake(name);
    const mergePolicy = input.mergePolicy ?? 'never_auto';
    assertNarrowing(this.db, { repository: { projectId: target.id, name, mergePolicy } });

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
      const mergeMethod = input.mergeMethod ?? 'merge';
      const profile = RepositoryProfileSchema.parse({
        version: 2,
        detection: 'detected',
        ...input.profile,
        ...(input.requiredChecks === undefined || input.requiredChecks.length === 0
          ? {}
          : { requiredChecks: input.requiredChecks }),
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        confirmedBy: ACTOR,
        confirmedAt: now,
      });
      const project = this.db.transaction((tx) => {
        const proj = findProject(tx, input.project);
        assertNarrowing(tx, { repository: { projectId: proj.id, name, mergePolicy } });
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
            githubOwner: github?.owner ?? null,
            githubName: github?.name ?? null,
            mergePolicy,
            mergeMethod,
            intakeLabel,
            createdAt: now,
          })
          .run();
        bumpConfigVersion(tx);
        appendEvent(tx, {
          entityKind: 'repository',
          entityId: id,
          type: 'repository.registered',
          actor: ACTOR,
          payload: {
            projectId: proj.id,
            name,
            cloneMethod,
            defaultBranch,
            github: github === null ? null : formatCoordinates(github),
            mergePolicy,
            mergeMethod,
            intakeLabel,
            // The command itself: a human set it, and it is shown before confirming.
            setup: profile.setup ?? null,
          },
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
        github,
        mergePolicy,
        mergeMethod,
        intakeLabel,
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

  /** What a new Job would freeze now for this Repository (ADR-0059): the Job-wide values and its section. */
  effectiveConfig(id: string): EffectiveConfigPreview {
    const repo = this.db
      .select({ projectId: schema.repositories.projectId })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id))
      .get();
    if (repo === undefined)
      throw new ApiFailure(404, 'repository_not_found', `no Repository ${id}`);
    const project = this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, repo.projectId))
      .get();
    if (project === undefined) throw new Error(`Repository ${id} has no Project`);
    return previewOf(this.db, project, id);
  }

  /**
   * `repo profile detect` (ADR-0060): Profile Detection over the source's HEAD
   * again, as at registration, and the diff against the saved profile.
   * Read-only; nothing is saved until `applyDetection`.
   */
  async detectProfile(ref: string): Promise<ProfileDetection> {
    const repository = toRepository(findRepository(this.db, ref));
    if ((await workTreeRoot(repository.source)) === undefined) {
      throw new ApiFailure(
        422,
        'source_unreadable',
        `the source checkout ${repository.source} is not a git working tree any more, so there is nothing to detect from`,
      );
    }
    const detected = detectProfile(await snapshotOf(repository.source, 'HEAD'));
    return {
      repository: { id: repository.id, name: repository.name },
      current: repository.profile,
      detected,
      changes: profileChanges(repository.profile, detected),
    };
  }

  /** Saves the detected fields the human confirmed; refused when the profile changed since it was shown. */
  applyDetection(ref: string, input: ApplyProfileDetectionInput): ProfileUpdate {
    return this.changeProfile(ref, 'repository_profile.detected', (current) => {
      if (current.confirmedAt !== input.basis) {
        throw new ApiFailure(
          409,
          'profile_changed',
          'the profile changed since the detection was shown; run factory repo profile detect again',
        );
      }
      return applyDetection(current, input.detected, ACTOR, new Date().toISOString());
    });
  }

  /**
   * `repo intake set <repo> <label>` / `repo intake off <repo>` (#112,
   * ADR-0072): the label that opts the Repository into GitHub Issues intake.
   * Turning it off cancels the open intake items. Audited.
   */
  setIntakeLabel(ref: string, input: SetIntakeLabelInput): Repository {
    const repository = this.db.transaction(
      (tx) => {
        const row = findRepository(tx, ref);
        if (input.label !== null && (row.githubOwner === null || row.githubName === null)) {
          throw noCoordinatesForIntake(row.name);
        }
        if (row.intakeLabel === input.label) return toRepository(row);
        tx.update(schema.repositories)
          .set({ intakeLabel: input.label })
          .where(eq(schema.repositories.id, row.id))
          .run();
        bumpConfigVersion(tx);
        if (input.label === null) cancelOpenOffers(tx, row.id, ACTOR);
        tx.insert(schema.auditLog)
          .values({
            id: newId('aud'),
            ts: new Date().toISOString(),
            actor: ACTOR,
            action: 'repository.intake_label_set',
            target: `repository:${row.id}`,
            jobId: null,
            beforeJson: JSON.stringify({ intakeLabel: row.intakeLabel }),
            afterJson: JSON.stringify({ intakeLabel: input.label }),
            policyRef: null,
            correlationId: null,
          })
          .run();
        appendEvent(tx, {
          entityKind: 'repository',
          entityId: row.id,
          type: 'repository.intake_label_set',
          actor: ACTOR,
          payload: { before: row.intakeLabel, after: input.label },
        });
        return toRepository({ ...row, intakeLabel: input.label });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return repository;
  }

  /** `repo profile set`: one field, validated by the profile schema. */
  setProfileField(ref: string, input: SetProfileFieldInput): ProfileUpdate {
    return this.changeProfile(ref, 'repository_profile.set', (current) => {
      const result = setProfileField(current, input.key, input.value);
      if (!result.ok) throw new ApiFailure(400, result.code, result.message);
      return { ...result.profile, confirmedBy: ACTOR, confirmedAt: new Date().toISOString() };
    });
  }

  /**
   * Saves a human's profile change with its audit entry and event, in one
   * transaction. Jobs already created keep their frozen sections (ADR-0049).
   */
  private changeProfile(
    ref: string,
    action: 'repository_profile.detected' | 'repository_profile.set',
    change: (current: RepositoryProfile) => RepositoryProfile,
  ): ProfileUpdate {
    const result = this.db.transaction((tx) => {
      const row = findRepository(tx, ref);
      const before = toRepository(row).profile;
      const after = RepositoryProfileSchema.parse(change(before));
      const changes: ProfileChange[] = profileDiff(before, after);
      tx.update(schema.repositories)
        .set({ profileJson: JSON.stringify(after) })
        .where(eq(schema.repositories.id, row.id))
        .run();
      bumpConfigVersion(tx);
      tx.insert(schema.auditLog)
        .values({
          id: newId('aud'),
          ts: after.confirmedAt,
          actor: ACTOR,
          action,
          target: `repository:${row.id}`,
          jobId: null,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(after),
          policyRef: null,
          correlationId: null,
        })
        .run();
      appendEvent(tx, {
        entityKind: 'repository',
        entityId: row.id,
        type: 'repository.profile_updated',
        actor: ACTOR,
        payload: {
          via: action === 'repository_profile.detected' ? 'detect' : 'set',
          changes,
        },
      });
      return { repository: { id: row.id, name: row.name }, profile: after, changes };
    });
    this.onCommit();
    return result;
  }

  /** Repositories whose profile was never detected (upgraded from v1), for `factory doctor`. */
  undetectedProfiles(): { repositoryId: string; name: string; message: string }[] {
    const all = this.listRepositories();
    return all
      .filter((r) => r.profile.detection === 'not_detected')
      .map((r) => {
        const ref = all.filter((o) => o.name === r.name).length > 1 ? r.id : r.name;
        return {
          repositoryId: r.id,
          name: r.name,
          message:
            `Repository ${r.name} (${r.id}) has a profile from before Profile Detection: its ` +
            `CI files and instruction files are not detected, and only the default Sensitive Paths ` +
            `apply. Re-detect it with \`factory repo profile detect ${ref}\`.`,
        };
      });
  }

  listRepositories(): Repository[] {
    return this.db.select().from(schema.repositories).all().map(toRepository);
  }
}

/**
 * A Repository's section of a Job's frozen Effective Configuration (ADR-0049,
 * ADR-0057): what the Job uses for it, never the Repository as it is now
 * (except, for a Job from before Phase D, what that Job never froze).
 */
export function frozenRepositoryConfig(
  configSnapshotJson: string,
  row: typeof schema.repositories.$inferSelect,
): RepositoryEffectiveConfig {
  return repositoryConfigOf(
    EffectiveConfigSchema.parse(JSON.parse(configSnapshotJson)),
    toRepository(row),
  );
}

export function toRepository(row: typeof schema.repositories.$inferSelect): Repository {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    source: row.source,
    remoteUrl: row.remoteUrl,
    clonePath: row.clonePath,
    defaultBranch: row.defaultBranch,
    profile: RepositoryProfileSchema.parse(JSON.parse(row.profileJson)),
    github:
      row.githubOwner === null || row.githubName === null
        ? null
        : { owner: row.githubOwner, name: row.githubName },
    mergePolicy: MergePolicySchema.parse(row.mergePolicy),
    mergeMethod: MergeMethodSchema.parse(row.mergeMethod),
    intakeLabel: row.intakeLabel,
    createdAt: row.createdAt,
  };
}

function noCoordinatesForIntake(name: string): ApiFailure {
  return new ApiFailure(
    409,
    'no_github_coordinates',
    `Repository ${name} has no GitHub coordinates, so it has no issues to take in: register it with --github owner/name`,
  );
}

/** The named Project; an unknown one is refused, never created (ADR-0055). */
function findProject(db: FactoryDb | Tx, ref: string): Project {
  const choice = chooseProject(db.select().from(schema.projects).all(), ref);
  if (!choice.ok) throw new ApiFailure(404, choice.code, choice.message);
  return toProject(choice.project);
}

/** The Repository `ref` names: an id, or a name unique across Projects. */
function findRepository(db: FactoryDb | Tx, ref: string): typeof schema.repositories.$inferSelect {
  const rows = db
    .select()
    .from(schema.repositories)
    .where(or(eq(schema.repositories.id, ref), eq(schema.repositories.name, ref)))
    .all();
  const byId = rows.find((r) => r.id === ref);
  if (byId !== undefined) return byId;
  const [only, ...others] = rows;
  if (only === undefined) throw new ApiFailure(404, 'repository_not_found', `no Repository ${ref}`);
  if (others.length > 0) {
    throw new ApiFailure(
      409,
      'repository_ambiguous',
      `several Repositories are named ${ref} (${rows.map((r) => r.id).join(', ')}); name one by id`,
    );
  }
  return only;
}

/** `--github owner/name`; the API schema has checked it already. */
function parsedCoordinates(text: string): GitHubCoordinates {
  const parsed = parseCoordinates(text);
  if (!parsed.ok) throw new ApiFailure(400, 'invalid_github', parsed.error);
  return parsed.coordinates;
}

function resolveRemote(source: string, url: string): string {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^/:]+:/.test(url);
  return isUrl || isAbsolute(url) ? url : resolve(source, url);
}

/** Files detection reads larger than this are left out of the snapshot (nothing detected from them). */
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/**
 * The snapshot Profile Detection reads (ADR-0060): every path tracked at
 * `rev`, and the contents of the few files `profileDetectionReads` names.
 * Plumbing reads only: nothing is written to `repo`, its index or its tree.
 */
export async function snapshotOf(repo: string, rev: string): Promise<FileSnapshot> {
  const paths = await committedPaths(repo, rev);
  const files: Record<string, string> = {};
  for (const path of profileDetectionReads(paths)) {
    const text = await committedFile(repo, rev, path, MAX_SNAPSHOT_FILE_BYTES);
    if (text !== undefined) files[path] = text;
  }
  return { paths, files };
}
