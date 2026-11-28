/**
 * The config import diff (#113, ADR-0049, ADR-0073): what applying an imported
 * document would change, and the refusals (an unregistered Repository, a level
 * left wider than its parent). Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG_DOCUMENT_FORMAT,
  ConfigDocumentSchema,
  configImportDiff,
  type ConfigDocument,
  type RepositoryConfigEntry,
} from '@factory/domain';

const api: RepositoryConfigEntry = {
  mergePolicy: 'never_auto',
  mergeMethod: 'merge',
  intakeLabel: null,
  profile: {
    packageManager: 'pnpm',
    commands: { test: { run: 'pnpm test', acceptsArgs: false } },
    instructionFiles: [],
    sensitivePaths: ['.env*'],
  },
};

function doc(patch: Partial<ConfigDocument> = {}): ConfigDocument {
  return {
    format: CONFIG_DOCUMENT_FORMAT,
    factory: { concurrency: { global: 3 } },
    projects: { shop: { config: { maxAttempts: 2 }, repositories: { api } } },
    ...patch,
  };
}

describe('configImportDiff', () => {
  it('finds nothing to change in an unchanged document', () => {
    expect(configImportDiff(doc(), doc())).toEqual({ ok: true, changes: [] });
  });

  it('lists each changed leaf, set and unset, at its level', () => {
    const incoming = doc({
      factory: { maxRetries: 1 },
      projects: {
        shop: {
          config: { maxAttempts: 4 },
          repositories: {
            api: {
              ...api,
              mergeMethod: 'squash',
              profile: {
                ...api.profile,
                commands: { test: { run: 'pnpm test', acceptsArgs: true } },
                setup: 'pnpm install',
              },
            },
          },
        },
      },
    });

    const result = configImportDiff(doc(), incoming);

    expect(result).toEqual({
      ok: true,
      changes: [
        {
          kind: 'set',
          level: 'factory',
          project: null,
          repository: null,
          key: 'concurrency.global',
          from: 3,
          to: null,
          widens: false,
        },
        {
          kind: 'set',
          level: 'factory',
          project: null,
          repository: null,
          key: 'maxRetries',
          from: null,
          to: 1,
          widens: false,
        },
        {
          kind: 'set',
          level: 'project',
          project: 'shop',
          repository: null,
          key: 'maxAttempts',
          from: 2,
          to: 4,
          widens: false,
        },
        {
          kind: 'set',
          level: 'repository',
          project: 'shop',
          repository: 'api',
          key: 'mergeMethod',
          from: 'merge',
          to: 'squash',
          widens: false,
        },
        {
          kind: 'set',
          level: 'repository',
          project: 'shop',
          repository: 'api',
          key: 'profile.commands.test.acceptsArgs',
          from: false,
          to: true,
          widens: false,
        },
        {
          kind: 'set',
          level: 'repository',
          project: 'shop',
          repository: 'api',
          key: 'profile.setup',
          from: null,
          to: 'pnpm install',
          widens: false,
        },
      ],
    });
  });

  it('compares lists whole and ignores key order', () => {
    const reordered: RepositoryConfigEntry = {
      profile: { ...api.profile, sensitivePaths: ['.env*', 'infra/**'] },
      intakeLabel: null,
      mergeMethod: 'merge',
      mergePolicy: 'never_auto',
    };
    const result = configImportDiff(
      doc(),
      doc({ projects: { shop: { config: { maxAttempts: 2 }, repositories: { api: reordered } } } }),
    );
    expect(result.ok && result.changes.map((c) => [c.kind, 'key' in c ? c.key : '', c])).toEqual([
      [
        'set',
        'profile.sensitivePaths',
        expect.objectContaining({ from: ['.env*'], to: ['.env*', 'infra/**'] }),
      ],
    ]);
  });

  it('creates a Project the document names, with its config', () => {
    const result = configImportDiff(
      doc(),
      doc({
        projects: {
          shop: { config: { maxAttempts: 2 }, repositories: { api } },
          web: { config: { planApproval: 'skip' }, repositories: {} },
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      changes: [
        { kind: 'create_project', project: 'web' },
        {
          kind: 'set',
          level: 'project',
          project: 'web',
          repository: null,
          key: 'planApproval',
          from: null,
          to: 'skip',
          widens: true,
        },
      ],
    });
  });

  it('leaves Projects and Repositories the document does not name unchanged', () => {
    const current = doc({
      projects: {
        shop: { config: {}, repositories: { api, web: api } },
        other: { config: { maxAttempts: 1 }, repositories: {} },
      },
    });
    const incoming = doc({ projects: { shop: { config: {}, repositories: { api } } } });
    expect(configImportDiff(current, incoming)).toEqual({ ok: true, changes: [] });
  });

  it('refuses a Repository that is not registered in that Project', () => {
    const current = doc({
      projects: {
        shop: { config: {}, repositories: { api } },
        blog: { config: {}, repositories: {} },
      },
    });
    const elsewhere = configImportDiff(
      current,
      doc({ projects: { blog: { config: {}, repositories: { api } } } }),
    );
    expect(elsewhere).toMatchObject({ ok: false, code: 'repository_not_registered' });
    expect(!elsewhere.ok && elsewhere.message).toContain("Repository 'api'");
    expect(!elsewhere.ok && elsewhere.message).toContain("Project 'blog'");
    expect(!elsewhere.ok && elsewhere.message).toContain('factory repo add');

    const newProject = configImportDiff(
      current,
      doc({ projects: { fresh: { config: {}, repositories: { api } } } }),
    );
    expect(newProject).toMatchObject({ ok: false, code: 'repository_not_registered' });
  });

  it('refuses a lower level left wider than its parent, naming the parent value', () => {
    const current = doc({ factory: { mergePolicy: 'never_auto' } });
    const repoWider = configImportDiff(
      current,
      doc({
        factory: { mergePolicy: 'never_auto' },
        projects: {
          shop: {
            config: { maxAttempts: 2 },
            repositories: { api: { ...api, mergePolicy: 'human_approval' } },
          },
        },
      }),
    );
    expect(repoWider).toMatchObject({ ok: false, code: 'config_widens_parent' });
    expect(!repoWider.ok && repoWider.message).toContain(
      "Repository 'api' sets mergePolicy human_approval, wider than its parent: the Factory Level sets never_auto",
    );

    const projectWider = configImportDiff(
      doc(),
      doc({
        factory: { planApproval: 'required' },
        projects: {
          shop: { config: { maxAttempts: 2, planApproval: 'skip' }, repositories: { api } },
        },
      }),
    );
    expect(projectWider).toMatchObject({ ok: false, code: 'config_widens_parent' });

    // A Project the document leaves out is still checked against a narrowed parent.
    const childLeftOut = configImportDiff(
      doc({
        projects: {
          shop: { config: { planApproval: 'skip' }, repositories: { api } },
        },
      }),
      { format: CONFIG_DOCUMENT_FORMAT, factory: { planApproval: 'required' }, projects: {} },
    );
    expect(childLeftOut).toMatchObject({ ok: false, code: 'config_widens_parent' });
    expect(!childLeftOut.ok && childLeftOut.message).toContain("Project 'shop'");
  });

  it('flags a widening at its own level, which is allowed', () => {
    const current = doc({
      factory: { mergePolicy: 'never_auto', planApproval: 'required' },
    });
    const result = configImportDiff(
      current,
      doc({
        factory: { mergePolicy: 'human_approval', planApproval: 'skip' },
        projects: {
          shop: {
            config: { maxAttempts: 2 },
            repositories: { api: { ...api, mergePolicy: 'human_approval' } },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    const flags = result.ok
      ? result.changes.map((c) => ('key' in c ? [c.level, c.key, c.widens] : []))
      : [];
    expect(flags).toEqual([
      ['factory', 'mergePolicy', true],
      ['factory', 'planApproval', true],
      ['repository', 'mergePolicy', true],
    ]);

    // Removing a Merge Policy ceiling widens; setting one narrows.
    const removed = configImportDiff(doc({ factory: { mergePolicy: 'never_auto' } }), doc());
    expect(
      removed.ok && removed.changes.find((c) => 'key' in c && c.key === 'mergePolicy'),
    ).toEqual(expect.objectContaining({ from: 'never_auto', to: null, widens: true }));
    const ceiling = configImportDiff(doc(), doc({ factory: { mergePolicy: 'human_approval' } }));
    expect(
      ceiling.ok && ceiling.changes.find((c) => 'key' in c && c.key === 'mergePolicy'),
    ).toEqual(expect.objectContaining({ from: null, to: 'human_approval', widens: false }));
  });
});

describe('ConfigDocumentSchema', () => {
  it('reads a document by the same schemas as the levels and refuses unknown keys', () => {
    expect(ConfigDocumentSchema.safeParse(doc()).success).toBe(true);
    const unknown = ConfigDocumentSchema.safeParse({ ...doc(), factory: { colour: 'red' } });
    expect(unknown.success).toBe(false);
    const badValue = ConfigDocumentSchema.safeParse({
      ...doc(),
      projects: { shop: { config: { planApproval: 'sometimes' }, repositories: {} } },
    });
    expect(badValue.success).toBe(false);
    const wrongFormat = ConfigDocumentSchema.safeParse({ ...doc(), format: 'other@9' });
    expect(wrongFormat.success).toBe(false);
    const noFactory = ConfigDocumentSchema.safeParse({ format: CONFIG_DOCUMENT_FORMAT });
    expect(noFactory.success).toBe(false);
  });

  it('defaults absent projects and an absent Project config to empty', () => {
    expect(
      ConfigDocumentSchema.parse({
        format: CONFIG_DOCUMENT_FORMAT,
        factory: {},
        projects: { web: {} },
      }),
    ).toEqual({
      format: CONFIG_DOCUMENT_FORMAT,
      factory: {},
      projects: { web: { config: {}, repositories: {} } },
    });
  });
});
