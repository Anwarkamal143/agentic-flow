import { describe, expect, it } from 'vitest';
import { json, post, type EventBody, type JobBody } from '../support/api.js';
import { startRuntime, tinyTsRepo, type RunningRuntime } from '../support/factory.js';

interface ProjectSummaryBody {
  id: string;
  name: string;
  config: Record<string, unknown>;
  repositories: { id: string; name: string }[];
  activeJobs: { id: string; title: string; status: string }[];
}

async function cliOk(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

async function projectEvents(rt: RunningRuntime): Promise<EventBody[]> {
  const events = await json<EventBody[]>(rt.request('/v1/events?limit=1000'));
  return events.filter((e) => e.entityKind === 'project');
}

describe('factory project', () => {
  it('creates, lists, shows and configures Projects through the runtime, audited with events', async () => {
    const rt = await startRuntime();

    const created = await cliOk(rt, ['project', 'create', 'shop']);
    expect(created).toMatch(/Created Project shop \(prj_\w+\)/);
    await cliOk(rt, ['project', 'create', 'blog']);

    const again = await rt.home.cli(['project', 'create', 'shop']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Project 'shop' already exists");

    await cliOk(rt, ['repo', 'add', tinyTsRepo(), '--project', 'shop', '--yes']);
    const job = await rt.home.cli(['job', 'create', '--project', 'shop', '--title', 'Add sum()']);
    expect(job.code, job.stderr).toBe(0);

    const summaries = await json<ProjectSummaryBody[]>(rt.request('/v1/projects'));
    const shop = summaries.find((p) => p.name === 'shop');
    expect(summaries.map((p) => p.name)).toEqual(['blog', 'shop']);
    expect(shop?.repositories.map((r) => r.name)).toEqual(['tiny-ts']);
    expect(shop?.activeJobs.map((j) => j.title)).toEqual(['Add sum()']);

    const list = await cliOk(rt, ['project', 'list']);
    expect(list).toMatch(/blog +\(prj_\w+\) +repositories: none +active Jobs: 0/);
    expect(list).toMatch(/shop +\(prj_\w+\) +repositories: tiny-ts +active Jobs: 1/);

    const set = await cliOk(rt, ['project', 'config', 'set', 'shop', 'maxAttempts', '5']);
    expect(set).toContain('maxAttempts = 5');
    await cliOk(rt, ['project', 'config', 'set', 'shop', 'concurrency.perJob', '4']);
    await cliOk(rt, ['project', 'config', 'set', 'shop', 'planApproval', 'skip']);

    const bad = await rt.home.cli(['project', 'config', 'set', 'shop', 'maxAttempts', '99']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('maxAttempts');
    const unknown = await rt.home.cli(['project', 'config', 'set', 'shop', 'colour', 'red']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown Project config key 'colour'");

    const show = await cliOk(rt, ['project', 'show', 'shop']);
    expect(show).toMatch(/Project shop \(prj_\w+\)/);
    expect(show).toMatch(/maxAttempts +5/);
    expect(show).toMatch(/concurrency\.perJob +4/);
    expect(show).toMatch(/planApproval +skip/);
    expect(show).toMatch(/tiny-ts \(repo_\w+\)/);
    expect(show).toContain('Add sum()');

    const detail = JSON.parse(await cliOk(rt, ['project', 'show', 'shop', '--json'])) as {
      config: Record<string, unknown>;
    };
    expect(detail.config).toEqual({
      maxAttempts: 5,
      concurrency: { perJob: 4 },
      planApproval: 'skip',
    });

    const events = await projectEvents(rt);
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ['project.created', 'user:local'],
      ['project.created', 'user:local'],
      ['project.config_updated', 'user:local'],
      ['project.config_updated', 'user:local'],
      ['project.config_updated', 'user:local'],
    ]);
    expect(events[2]?.payload).toMatchObject({
      key: 'maxAttempts',
      before: {},
      after: { maxAttempts: 5 },
    });

    const missing = await rt.home.cli(['project', 'show', 'nope']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no Project 'nope'");
  });

  it('refuses repo add for an unknown Project and creates nothing', async () => {
    const rt = await startRuntime();
    await cliOk(rt, ['project', 'create', 'shop']);

    const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'shpo', '--yes']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no Project 'shpo'");
    expect(res.stderr).toContain('shop');

    // The API refuses it too, whatever the client does.
    const direct = await post(rt, '/v1/repositories', {
      path: tinyTsRepo(),
      project: 'shpo',
      commands: { test: null, typecheck: null },
    });
    expect(direct.status).toBe(404);
    expect(await direct.json()).toMatchObject({ error: 'project_not_found' });

    expect(await json<unknown[]>(rt.request('/v1/repositories'))).toEqual([]);
    expect(
      (await json<ProjectSummaryBody[]>(rt.request('/v1/projects'))).map((p) => p.name),
    ).toEqual(['shop']);
    expect((await projectEvents(rt)).map((e) => e.type)).toEqual(['project.created']);
  });

  it('job create infers the Project only when exactly one exists', async () => {
    const rt = await startRuntime();

    const none = await rt.home.cli(['job', 'create', '--title', 'x']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no Projects');

    await cliOk(rt, ['project', 'create', 'shop']);
    await cliOk(rt, ['repo', 'add', tinyTsRepo(), '--project', 'shop', '--yes']);
    const inferred = await rt.home.cli(['job', 'create', '--title', 'Add sum()']);
    expect(inferred.code, inferred.stderr).toBe(0);
    const [job] = await json<JobBody[]>(rt.request('/v1/jobs'));
    expect(job?.repositories.map((r) => r.name)).toEqual(['tiny-ts']);

    await cliOk(rt, ['project', 'create', 'blog']);
    const ambiguous = await rt.home.cli(['job', 'create', '--title', 'y']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('name one with --project');
    expect(ambiguous.stderr).toContain('blog');
    expect(ambiguous.stderr).toContain('shop');
    expect(await json<unknown[]>(rt.request('/v1/jobs'))).toHaveLength(1);
  });
});
