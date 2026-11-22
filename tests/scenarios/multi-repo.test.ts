/**
 * Multi-repo Jobs (#105, ADR-0052, the execution part of ROADMAP exit test
 * D1): `job create --repo api --repo web` makes one Job over two Repositories
 * of a Project. The Plan's cross-repo edge (web's Task depends on api's) gives
 * the Delivery Order api → web, stored on the Job and shown by `job show`.
 * Each Repository's Task runs in its own Worktree on its own Task Branch of its
 * own Factory Clone; the web Task becomes ready only once the api Task is
 * approved, and gets that Task's result summary and diff as read-only context,
 * never its code. Each Repository gets its own Integration Task and Branch.
 * Asserted through the CLI, the API and git in the Factory Clones only.
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createProject,
  declareCommands,
  json,
  jobSettled,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, SUM_SOURCE, validOutput } from '../support/scripts.js';

interface RepoBody {
  id: string;
  name: string;
  projectId: string;
  clonePath: string;
  defaultBranch: string;
}
interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
  state: string;
  repositoryId: string;
}
interface WorktreeBody {
  taskId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseSha: string;
}
interface UpstreamBody {
  task: { id: string; key: string; title: string };
  repository: { id: string; name: string };
  baseSha: string;
  headSha: string;
  summary: string | null;
  diff: { patch: string; truncated: boolean };
}
interface AttemptBody {
  taskId: string;
  cause: string;
  baseSha: string;
  headSha: string | null;
  packet: { packetVersion: number; context: { upstream: UpstreamBody[] } };
}
type MultiRepoJob = JobBody & {
  deliveryOrder: { repositoryId: string; name: string; after: string[] }[] | null;
};

const USE_SUM = "import { sum } from './math.js';\n\nexport const five = sum(2, 3);\n";

/** A Plan Task of `repository` writing `writable`, verified by `verify`. */
function planTask(
  key: string,
  repository: string,
  writable: string,
  dependsOn: string[],
  verify: { command: string; args?: string[] },
) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `${key} in ${repository}`,
    repository,
    scope: { writable: [writable], forbidden: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [{ key: 'test', ...verify, criteria: ['AC-01'] }],
  };
}

function developerRun(path: string, content: string, summary: string) {
  return [
    {
      steps: [{ write: { path, content } }, { commit: `Write ${path}` }],
      result: {
        status: 'done',
        summary,
        commits: [],
        criteria: [{ code: 'AC-01', claim: 'met', how: 'the factory checks it' }],
      },
    },
  ];
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'The change is correct.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
  },
};

const SCRIPT = scriptWith(
  {
    planning: [
      {
        output: {
          tasks: [
            // Listed web first: the Delivery Order comes from the edge, not from Plan order.
            planTask('web-use', 'web', 'src/use-sum.ts', ['api-expand'], {
              command: 'exists',
              args: ['src/use-sum.ts'],
            }),
            planTask('api-expand', 'api', 'src/math.ts', [], { command: 'has-sum' }),
          ],
        },
      },
    ],
  },
  {
    'api-expand': developerRun('src/math.ts', SUM_SOURCE, 'Exported sum(a, b) from src/math.ts.'),
    'web-use': developerRun('src/use-sum.ts', USE_SUM, 'Used sum() in src/use-sum.ts.'),
  },
  // Two Integration Tasks share the key `integration`: one approving review each.
  { 'api-expand': [APPROVE], 'web-use': [APPROVE], integration: [APPROVE, APPROVE] },
);

/** A runtime with Project `demo` holding the `api` and `web` fixtures, plan approval skipped. */
async function twoRepoRuntime(): Promise<{ rt: RunningRuntime; api: RepoBody; web: RepoBody }> {
  const home = await initializedHome();
  useFakeHarness(home, SCRIPT);
  const rt = await startRuntime(home);
  await createProject(rt, 'demo');
  for (const name of ['api', 'web']) {
    const res = await rt.home.cli(['repo', 'add', tinyTsRepo(name), '--project', 'demo', '--yes']);
    if (res.code !== 0) throw new Error(`repo add ${name} failed: ${res.stderr}`);
  }
  const repos = await json<RepoBody[]>(rt.request('/v1/repositories'));
  const byName = (name: string) => {
    const repo = repos.find((r) => r.name === name);
    if (repo === undefined) throw new Error(`no Repository ${name}`);
    return repo;
  };
  const [api, web] = [byName('api'), byName('web')];
  for (const repo of [api, web]) await declareCommands(rt, repo.id);
  await skipPlanApproval(rt, api.projectId);
  return { rt, api, web };
}

describe('multi-repo Jobs (#105)', { timeout: 90_000 }, () => {
  it('runs api before web, each in its own Worktree and integration, in Delivery Order', async () => {
    const { rt, api, web } = await twoRepoRuntime();

    const created = await rt.home.cli([
      'job',
      'create',
      '--title',
      'Add and use sum()',
      '--repo',
      'web',
      '--repo',
      'api',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const jobId = /Created Job (job_\S+) for api, web\n/.exec(created.stdout)?.[1];
    if (jobId === undefined) throw new Error(`no Job id in: ${created.stdout}`);

    const job = (await waitForJob(rt, jobId, jobSettled, 60_000)) as MultiRepoJob;
    expect(job.status).toBe('completed');
    expect(job.repositories.map((r) => r.name)).toEqual(['api', 'web']);
    // The Delivery Order: api first; web waits for api.
    expect(job.deliveryOrder).toEqual([
      { repositoryId: api.id, name: 'api', after: [] },
      { repositoryId: web.id, name: 'web', after: [api.id] },
    ]);
    const shown = await rt.home.cli(['job', 'show', jobId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`repositories: api (${api.id}), web (${web.id})`);
    expect(shown.stdout).toContain('delivery order: api → web (web after api)');

    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
    const taskOf = (key: string, repositoryId: string) => {
      const found = tasks.find((t) => t.key === key && t.repositoryId === repositoryId);
      if (found === undefined) throw new Error(`no Task ${key} in ${repositoryId}`);
      return found;
    };
    const apiTask = taskOf('api-expand', api.id);
    const webTask = taskOf('web-use', web.id);
    // One Integration Task per Repository, each approved.
    expect(
      tasks
        .filter((t) => t.kind === 'integration')
        .map((t) => [t.repositoryId, t.state])
        .sort(),
    ).toEqual(
      [
        [api.id, 'approved'],
        [web.id, 'approved'],
      ].sort(),
    );
    expect([apiTask.state, webTask.state]).toEqual(['approved', 'approved']);

    // The web Task became ready, and was claimed, only after the api Task was approved.
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
    const seq = (taskId: string, type: string) =>
      events.find((e) => e.entityId === taskId && e.type === type)?.seq ?? Number.NaN;
    expect(seq(webTask.id, 'task.ready')).toBeGreaterThan(seq(apiTask.id, 'task.approved'));
    expect(seq(webTask.id, 'task.claimed')).toBeGreaterThan(seq(apiTask.id, 'task.approved'));

    // Separate Worktrees and Task Branches, each in its own Repository's Factory Clone.
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${jobId}/worktrees`));
    const worktreeOf = (taskId: string) => {
      const found = worktrees.find((w) => w.taskId === taskId);
      if (found === undefined) throw new Error(`no Worktree for ${taskId}`);
      return found;
    };
    const apiTree = worktreeOf(apiTask.id);
    const webTree = worktreeOf(webTask.id);
    expect([apiTree.repositoryId, webTree.repositoryId]).toEqual([api.id, web.id]);
    expect(apiTree.path).not.toBe(webTree.path);
    expect(apiTree.branch).toBe(`factory/${jobId}/${apiTask.id}-api-expand`);
    expect(webTree.branch).toBe(`factory/${jobId}/${webTask.id}-web-use`);
    expect(git(api.clonePath, ['branch', '--list', webTree.branch]).trim()).toBe('');
    expect(git(web.clonePath, ['branch', '--list', apiTree.branch]).trim()).toBe('');
    // A cross-repo dependency is no Dependency Base: web starts from its own default branch.
    const webDefault = git(web.clonePath, ['rev-parse', `refs/heads/${web.defaultBranch}`]).trim();
    expect(webTree.baseSha).toBe(webDefault);
    const webCreated = events.find(
      (e) => e.type === 'worktree.created' && e.payload['taskId'] === webTask.id,
    );
    expect(webCreated?.payload['dependencyBase']).toEqual([]);

    // The web Task's packet carries the api Task's summary and diff as context, read-only.
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
    const attemptOf = (taskId: string) => {
      const found = attempts.find((a) => a.taskId === taskId && a.cause === 'initial');
      if (found === undefined) throw new Error(`no Attempt of ${taskId}`);
      return found;
    };
    const apiAttempt = attemptOf(apiTask.id);
    const webAttempt = attemptOf(webTask.id);
    expect(webAttempt.packet.packetVersion).toBe(4);
    expect(webAttempt.packet.context.upstream).toEqual([
      {
        task: { id: apiTask.id, key: 'api-expand', title: 'api-expand in api' },
        repository: { id: api.id, name: 'api' },
        baseSha: apiAttempt.baseSha,
        headSha: apiAttempt.headSha,
        summary: 'Exported sum(a, b) from src/math.ts.',
        diff: {
          patch: expect.stringContaining('+export function sum') as string,
          truncated: false,
        },
      },
    ]);
    expect(apiAttempt.packet.context.upstream).toEqual([]);
    // Never its code: the web Worktree's history holds nothing of api's.
    expect(git(web.clonePath, ['show', `${webAttempt.headSha ?? ''}:src/math.ts`])).not.toContain(
      'sum',
    );

    // One Integration Branch per Repository, in its own Factory Clone, holding only its own Task.
    const integration = `factory/${jobId}/integration`;
    expect(git(api.clonePath, ['show', `${integration}:src/math.ts`])).toBe(SUM_SOURCE);
    expect(git(web.clonePath, ['show', `${integration}:src/use-sum.ts`])).toBe(USE_SUM);
    expect(git(api.clonePath, ['ls-tree', '--name-only', integration, 'src/']).trim()).toBe(
      'src/math.ts',
    );

    // The Delivery Report reads each Task's diff in its own Factory Clone, and says which
    // Integration Branch it shows (the per-Repository report is a later version).
    const artifacts = await json<{ id: string; kind: string }[]>(
      rt.request(`/v1/jobs/${jobId}/artifacts`),
    );
    const reportId = artifacts.find((a) => a.kind === 'report')?.id ?? '';
    const report = await json<{
      tasks: { key: string; changedFiles: string[] }[];
      knownLimitations: string[];
    }>(rt.request(`/v1/artifacts/${reportId}/content`));
    expect(report.tasks.map((t) => [t.key, t.changedFiles]).sort()).toEqual([
      ['api-expand', ['src/math.ts']],
      ['web-use', ['src/use-sum.ts']],
    ]);
    expect(report.knownLimitations).toContain(
      `This Job spans 2 Repositories (api, web); this report shows the Integration Branch of api only. web's Integration Branch is ${integration} in its own Factory Clone at ${web.clonePath}. The branches of several Repositories are not atomic: each is delivered on its own.`,
    );
  });

  it("takes several Repositories of one Project at creation, and refuses another Project's", async () => {
    const { rt, api, web } = await twoRepoRuntime();
    await createProject(rt, 'other');
    const added = await rt.home.cli([
      'repo',
      'add',
      tinyTsRepo('lib'),
      '--project',
      'other',
      '--yes',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const lib = (await json<RepoBody[]>(rt.request('/v1/repositories'))).find(
      (r) => r.name === 'lib',
    );

    const mixed = await post(rt, '/v1/jobs', { repositoryIds: [api.id, lib?.id], title: 'Mixed' });
    expect(mixed.status).toBe(409);
    expect(await mixed.json()).toEqual({
      error: 'repository_not_in_project',
      message: `Repository lib (${lib?.id ?? ''}) belongs to Project 'other', not 'demo'`,
    });
    const twice = await post(rt, '/v1/jobs', { repositoryIds: [api.id, api.id], title: 'Twice' });
    expect(twice.status).toBe(400);

    const res = await post(rt, '/v1/jobs', { repositoryIds: [web.id, api.id], title: 'Both' });
    expect(res.status).toBe(201);
    const job = (await res.json()) as MultiRepoJob;
    expect(job.repositories.map((r) => r.name)).toEqual(['api', 'web']);
    // No Plan yet: no Delivery Order.
    expect(job.deliveryOrder).toBeNull();
  });
});
