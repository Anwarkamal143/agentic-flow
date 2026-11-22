/**
 * The configuration hierarchy (ADR-0049, ADR-0057): recipe < Factory < Project <
 * Repository < Job < Task, each value with its source, permission values with
 * their narrowing chain, and a widening below the parent refused with the
 * parent's value. Pure; tested through `@factory/domain`.
 */
import {
  configTreeViolation,
  EffectiveConfigSchema,
  repositoryConfigOf,
  resolveEffectiveConfig,
  taskMaxAttempts,
  type EffectiveConfig,
  type EffectiveConfigLevels,
  DEFAULT_SENSITIVE_PATHS,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const api = {
  id: 'repo_api',
  name: 'api',
  mergePolicy: 'never_auto' as const,
  mergeMethod: 'squash' as const,
  profile: {
    commands: { test: { run: 'npm test', acceptsArgs: false } },
    sensitivePaths: ['infra/**'],
    requiredChecks: ['build'],
    setup: 'npm ci',
  },
};
const web = {
  id: 'repo_web',
  name: 'web',
  mergePolicy: 'human_approval' as const,
  mergeMethod: 'merge' as const,
  profile: { commands: {}, sensitivePaths: [] },
};

function resolved(levels: EffectiveConfigLevels): EffectiveConfig {
  const result = resolveEffectiveConfig(levels);
  if (!result.ok) throw new Error(result.message);
  return result.config;
}

describe('resolveEffectiveConfig: levels and sources', () => {
  it('takes the most specific level that sets a value: recipe < factory < project < job', () => {
    expect(resolved({ project: {} }).maxAttempts).toEqual({ value: 3, source: 'recipe' });
    expect(resolved({ factory: { maxAttempts: 4 }, project: {} }).maxAttempts).toEqual({
      value: 4,
      source: 'factory',
    });
    expect(
      resolved({ factory: { maxAttempts: 4 }, project: { maxAttempts: 6 } }).maxAttempts,
    ).toEqual({ value: 6, source: 'project' });
    const limits = resolved({
      factory: { concurrency: { perRepository: 5, perJob: 5, global: 9 } },
      project: { concurrency: { perJob: 4 } },
      job: { concurrency: { perJob: 1 } },
    }).concurrency;
    expect(limits).toEqual({
      perRepository: { value: 5, source: 'factory' },
      perJob: { value: 1, source: 'job' },
    });
  });

  it('resolves every Job-wide key from the Factory Level', () => {
    const config = resolved({
      factory: {
        maxRetries: 1,
        maxQuestions: 0,
        maxReplans: 4,
        planApproval: 'skip',
        review: { rerunOnBaseChange: 'always' },
      },
      project: {},
    });
    expect(config.maxRetries).toEqual({ value: 1, source: 'factory' });
    expect(config.maxQuestions).toEqual({ value: 0, source: 'factory' });
    expect(config.maxReplans).toEqual({ value: 4, source: 'factory' });
    expect(config.reviewRerunOnBaseChange).toEqual({ value: 'always', source: 'factory' });
    expect(config.planApproval).toEqual({
      value: 'skip',
      source: 'factory',
      chain: [{ source: 'factory', value: 'skip' }],
    });
  });

  it('gives a section for every Repository of the Project, ordered by name, with its values frozen', () => {
    const config = resolved({ project: {}, repositories: [web, api] });
    expect(config.repositories.map((r) => r.name)).toEqual(['api', 'web']);
    expect(config.repositories[0]).toEqual({
      repositoryId: 'repo_api',
      name: 'api',
      mergePolicy: {
        value: 'never_auto',
        source: 'repository',
        chain: [{ source: 'repository', value: 'never_auto' }],
      },
      mergeMethod: { value: 'squash', source: 'repository' },
      setup: { value: 'npm ci', source: 'repository' },
      commands: { value: { test: { run: 'npm test', acceptsArgs: false } }, source: 'repository' },
      sensitivePaths: { value: ['infra/**'], source: 'repository' },
      requiredChecks: { value: ['build'], source: 'repository' },
    });
    expect(config.repositories[1]?.setup).toEqual({ value: null, source: 'repository' });
    expect(config.repositories[1]?.requiredChecks).toEqual({ value: [], source: 'repository' });
  });

  it('a Task narrows its maxAttempts with source task, else keeps the Job value', () => {
    const config = resolved({ project: { maxAttempts: 4 } });
    expect(taskMaxAttempts(config, 2)).toEqual({ value: 2, source: 'task' });
    expect(taskMaxAttempts(config, undefined)).toEqual({ value: 4, source: 'project' });
  });
});

describe('resolveEffectiveConfig: permission values narrow only', () => {
  it('records the chain of narrowings for the Merge Policy, least specific first', () => {
    const config = resolved({
      factory: { mergePolicy: 'human_approval' },
      project: { mergePolicy: 'human_approval' },
      repositories: [web],
      job: { mergePolicy: 'never_auto' },
    });
    expect(config.repositories[0]?.mergePolicy).toEqual({
      value: 'never_auto',
      source: 'job',
      chain: [
        { source: 'factory', value: 'human_approval' },
        { source: 'project', value: 'human_approval' },
        { source: 'repository', value: 'human_approval' },
        { source: 'job', value: 'never_auto' },
      ],
    });
  });

  it('refuses a Repository wider than its parent, naming the parent and its value', () => {
    const result = resolveEffectiveConfig({
      factory: { mergePolicy: 'never_auto' },
      project: {},
      repositories: [web],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('config_widens_parent');
    expect(result.message).toContain("Repository 'web' sets mergePolicy human_approval");
    expect(result.message).toContain('the Factory Level sets never_auto');
  });

  it('refuses a Project planApproval wider than the Factory Level', () => {
    const result = resolveEffectiveConfig({
      factory: { planApproval: 'required' },
      project: { planApproval: 'skip' },
    });
    expect(result).toMatchObject({ ok: false, code: 'config_widens_parent' });
    if (result.ok) return;
    expect(result.message).toContain('the Factory Level sets required');
  });

  it('refuses a Job Merge Policy wider than the Repository', () => {
    const result = resolveEffectiveConfig({
      project: {},
      repositories: [api],
      job: { mergePolicy: 'human_approval' },
    });
    expect(result).toMatchObject({ ok: false, code: 'config_widens_parent' });
    if (result.ok) return;
    expect(result.message).toContain("Repository 'api' sets never_auto");
  });

  it('lets a lower level narrow, and skips levels that set nothing', () => {
    const config = resolved({
      factory: { planApproval: 'skip' },
      project: { planApproval: 'required' },
    });
    expect(config.planApproval).toEqual({
      value: 'required',
      source: 'project',
      chain: [
        { source: 'factory', value: 'skip' },
        { source: 'project', value: 'required' },
      ],
    });
  });

  it('does not treat a recipe default as a parent: a Project may skip plan approval', () => {
    expect(resolved({ project: { planApproval: 'skip' } }).planApproval).toMatchObject({
      value: 'skip',
      source: 'project',
    });
  });
});

describe('configTreeViolation: a config set anywhere keeps every level within its parent', () => {
  const tree = {
    factory: { mergePolicy: 'human_approval' as const },
    projects: [
      {
        name: 'shop',
        config: {},
        repositories: [{ name: 'web', mergePolicy: 'human_approval' as const }],
      },
    ],
  };

  it('accepts a tree that only narrows', () => {
    expect(configTreeViolation(tree)).toBeUndefined();
  });

  it('refuses narrowing a parent below a child that is wider, naming the parent value', () => {
    const narrowed = { ...tree, factory: { mergePolicy: 'never_auto' as const } };
    const violation = configTreeViolation(narrowed);
    expect(violation?.code).toBe('config_widens_parent');
    expect(violation?.message).toContain("Repository 'web' sets mergePolicy human_approval");
    expect(violation?.message).toContain('the Factory Level sets never_auto');
  });

  it('refuses a Project wider than the Factory Level', () => {
    const violation = configTreeViolation({
      factory: { planApproval: 'required' },
      projects: [{ name: 'shop', config: { planApproval: 'skip' }, repositories: [] }],
    });
    expect(violation?.message).toContain("Project 'shop' sets planApproval skip");
  });
});

describe('snapshots of Jobs created before Phase D', () => {
  const old = {
    maxAttempts: { value: 3, source: 'recipe' },
    mergePolicy: { value: 'human_approval', source: 'repository' },
    setup: { value: 'npm ci', source: 'repository' },
  };

  it('still parse, with no Repository sections', () => {
    const config = EffectiveConfigSchema.parse(old);
    expect(config.repositories).toEqual([]);
    expect(config.planApproval).toEqual({ value: 'required', source: 'recipe' });
  });

  it('give their Repository a section from the frozen values and the live Repository', () => {
    const config = EffectiveConfigSchema.parse(old);
    expect(repositoryConfigOf(config, api)).toEqual({
      repositoryId: 'repo_api',
      name: 'api',
      mergePolicy: { value: 'human_approval', source: 'repository' },
      mergeMethod: { value: 'squash', source: 'repository' },
      setup: { value: 'npm ci', source: 'repository' },
      commands: { value: { test: { run: 'npm test', acceptsArgs: false } }, source: 'repository' },
      sensitivePaths: { value: ['infra/**'], source: 'repository' },
      requiredChecks: { value: ['build'], source: 'repository' },
    });
    const older = EffectiveConfigSchema.parse({ maxAttempts: { value: 3, source: 'recipe' } });
    expect(repositoryConfigOf(older, api).mergePolicy).toEqual({
      value: 'never_auto',
      source: 'repository',
    });
  });

  it('read a section frozen before #100: v1 commands named, the default Sensitive Paths', () => {
    const config = EffectiveConfigSchema.parse({
      ...old,
      repositories: [
        {
          repositoryId: 'repo_api',
          name: 'api',
          mergePolicy: { value: 'never_auto', source: 'repository' },
          mergeMethod: { value: 'merge', source: 'repository' },
          setup: { value: null, source: 'repository' },
          commands: { value: { test: 'npm test', typecheck: null }, source: 'repository' },
          requiredChecks: { value: [], source: 'repository' },
        },
      ],
    });
    expect(config.repositories[0]?.commands.value).toEqual({
      test: { run: 'npm test', acceptsArgs: false },
    });
    expect(config.repositories[0]?.sensitivePaths).toEqual({
      value: [...DEFAULT_SENSITIVE_PATHS],
      source: 'repository',
    });
  });

  it('a new snapshot gives the frozen section, not the live Repository', () => {
    const config = resolved({ project: {}, repositories: [api] });
    const changed = { ...api, mergeMethod: 'rebase' as const };
    expect(repositoryConfigOf(config, changed).mergeMethod.value).toBe('squash');
  });
});
