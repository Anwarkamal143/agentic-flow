/**
 * The configuration hierarchy (#97, ADR-0049, ADR-0057), through the CLI: a Job
 * freezes recipe < Factory < Project < Repository < Job at creation, each value
 * with its source; a later `config set` reaches only new Jobs (D3, CLI part);
 * and a permission value set wider than its parent is refused, naming the
 * parent's value.
 */
import { describe, expect, it } from 'vitest';
import { createProject, json, registeredRepo, type JobBody } from '../support/api.js';
import { startRuntime, tinyTsRepo, type RunningRuntime } from '../support/factory.js';

interface SectionBody {
  repositoryId: string;
  name: string;
  mergePolicy: { value: string; source: string; chain?: { source: string; value: string }[] };
  mergeMethod: { value: string; source: string };
  setup: { value: string | null; source: string };
}

type JobConfigBody = JobBody & {
  effectiveConfig: { repositories: SectionBody[]; maxAttempts: { value: number; source: string } };
};

async function cliOk(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

async function refused(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')} should be refused`).toBe(1);
  return res.stderr;
}

/** `job create` through the CLI; returns the new Job's id. */
async function cliJob(rt: RunningRuntime, title: string, extra: string[] = []): Promise<string> {
  const out = await cliOk(rt, ['job', 'create', '--title', title, ...extra]);
  const id = /job_[A-Za-z0-9_-]+/.exec(out)?.[0];
  if (id === undefined) throw new Error(`no Job id in: ${out}`);
  return id;
}

const getJob = (rt: RunningRuntime, id: string) =>
  json<JobConfigBody>(rt.request(`/v1/jobs/${id}`));

describe('the configuration hierarchy', () => {
  it('D3: a config change after creation leaves the running Job unchanged; a new Job gets it, with its source', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt, { planApproval: 'required' });

    const first = await cliJob(rt, 'before any change');
    const firstShow = await cliOk(rt, ['job', 'show', first]);
    expect(firstShow).toContain('Configuration (frozen at creation):');
    expect(firstShow).toMatch(/maxAttempts +3 +\(recipe\)/);
    expect(firstShow).toContain(`Repository tiny-ts (${repo.id}):`);
    expect(firstShow).toMatch(/mergePolicy +never_auto +\(repository\)/);
    expect(firstShow).toMatch(/mergeMethod +merge +\(repository\)/);
    const firstJob = await getJob(rt, first);
    expect(firstJob.effectiveConfig.repositories).toEqual([
      expect.objectContaining({
        repositoryId: repo.id,
        name: 'tiny-ts',
        mergePolicy: {
          value: 'never_auto',
          source: 'repository',
          chain: [{ source: 'repository', value: 'never_auto' }],
        },
      }),
    ]);

    await cliOk(rt, ['config', 'set', 'maxAttempts', '4']);
    const second = await cliJob(rt, 'after the Factory Level change');
    expect(await cliOk(rt, ['job', 'show', second])).toMatch(/maxAttempts +4 +\(factory\)/);

    expect(await cliOk(rt, ['project', 'config', 'set', 'demo', 'maxAttempts', '5'])).toContain(
      'maxAttempts = 5',
    );
    const third = await cliJob(rt, 'after the Project change');
    expect(await cliOk(rt, ['job', 'show', third])).toMatch(/maxAttempts +5 +\(project\)/);

    // The earlier Jobs keep what they froze, in the API and in `job show`.
    expect((await getJob(rt, first)).effectiveConfig).toEqual(firstJob.effectiveConfig);
    expect(await cliOk(rt, ['job', 'show', first])).toMatch(/maxAttempts +3 +\(recipe\)/);
    expect(await cliOk(rt, ['job', 'show', second])).toMatch(/maxAttempts +4 +\(factory\)/);
  });

  it('shows the chain of narrowings of a permission value', async () => {
    const rt = await startRuntime();
    await cliOk(rt, ['config', 'set', 'mergePolicy', 'human_approval']);
    await createProject(rt, 'demo');
    await cliOk(rt, [
      'repo',
      'add',
      tinyTsRepo(),
      '--project',
      'demo',
      '--yes',
      '--merge-policy',
      'human_approval',
    ]);
    const id = await cliJob(rt, 'stricter', ['--merge-policy', 'never_auto']);
    expect(await cliOk(rt, ['job', 'show', id])).toContain(
      'never_auto  (job; factory: human_approval → repository: human_approval → job: never_auto)',
    );
    expect((await getJob(rt, id)).effectiveConfig.repositories[0]?.mergePolicy).toEqual({
      value: 'never_auto',
      source: 'job',
      chain: [
        { source: 'factory', value: 'human_approval' },
        { source: 'repository', value: 'human_approval' },
        { source: 'job', value: 'never_auto' },
      ],
    });
  });

  it('refuses a config set wider than its parent at every level, naming the parent value', async () => {
    const rt = await startRuntime();
    await cliOk(rt, ['config', 'set', 'mergePolicy', 'never_auto']);
    await cliOk(rt, ['config', 'set', 'planApproval', 'required']);
    await createProject(rt, 'demo');

    const project = await refused(rt, [
      'project',
      'config',
      'set',
      'demo',
      'mergePolicy',
      'human_approval',
    ]);
    expect(project).toContain("Project 'demo' sets mergePolicy human_approval");
    expect(project).toContain('the Factory Level sets never_auto');
    expect(
      await refused(rt, ['project', 'config', 'set', 'demo', 'planApproval', 'skip']),
    ).toContain('the Factory Level sets required');

    const repo = await refused(rt, [
      'repo',
      'add',
      tinyTsRepo(),
      '--project',
      'demo',
      '--yes',
      '--merge-policy',
      'human_approval',
    ]);
    expect(repo).toContain('the Factory Level sets never_auto');
    expect(await json<unknown[]>(rt.request('/v1/repositories'))).toEqual([]);
    const [shown] = await json<{ config: unknown }[]>(rt.request('/v1/projects'));
    expect(shown?.config).toEqual({});
  });

  it('refuses narrowing a parent below a level that is wider, naming that level', async () => {
    const rt = await startRuntime();
    await createProject(rt, 'demo');
    await cliOk(rt, [
      'repo',
      'add',
      tinyTsRepo(),
      '--project',
      'demo',
      '--yes',
      '--merge-policy',
      'human_approval',
    ]);
    const stderr = await refused(rt, ['config', 'set', 'mergePolicy', 'never_auto']);
    expect(stderr).toContain("Repository 'tiny-ts' sets mergePolicy human_approval");
    expect(stderr).toContain('the Factory Level sets never_auto');
    const level = await json<{ config: unknown; version: number }>(
      rt.request('/v1/factory/config'),
    );
    expect(level).toMatchObject({ config: {}, version: 1 });
  });
});
