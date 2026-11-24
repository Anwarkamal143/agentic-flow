/**
 * The contract step as a follow-up Job (#110, ADR-0052; spec #93 stories 60,
 * 68 and 69). A multi-repo Job over the `api` and `web` fixtures on the fake
 * GitHub, whose Plan is expand (api) → use (web) → contract (api, deferred).
 * The deferred Task is never dispatched; the Delivery Report lists it as the
 * pending contract step; once both PRs have merged in Delivery Order an
 * Approval offers a follow-up Job, and approving it creates that Job with the
 * deferred Task as its description. The planner's prompt asks for the
 * contract in the upstream Task's Acceptance Criteria and for the contract
 * step to be deferred.
 *
 * Runs against the fake GitHub and the Claude Code stand-in only; asserted
 * through the API, the CLI and the stand-in's recorded prompts.
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import { fakeGitHub } from '../support/github.js';
import {
  createProject,
  declareCommands,
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type JobBody,
} from '../support/api.js';
import { scriptWith, SUM_SOURCE, validOutput } from '../support/scripts.js';
import { claudeStub, useClaudeCode } from '../support/claude.js';
import { killGroupsOnFinish } from '../support/processes.js';

const GH_ACCESS = 'fake-gh-access-0123456789';
const API = 'acme/api';
const WEB = 'acme/web';

interface RepoBody {
  id: string;
  name: string;
  projectId: string;
}
interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
}
interface PullRequestBody {
  repositoryId: string;
  number: number;
  state: string;
}
interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  subjectRef: string;
  question: string;
  why: string;
  version: number;
  state: string;
  options: { id: string }[];
  decision: { option: string; followUpJobId?: string } | null;
}
interface ReportBody {
  notes: string[];
  contractStep: {
    status: string;
    repositories: string[];
    tasks: { key: string; repository: string }[];
    line: string;
  } | null;
}

const USE_SUM = "import { sum } from './math.js';\n\nexport const five = sum(2, 3);\n";

function planTask(
  key: string,
  repository: string,
  writable: string,
  dependsOn: string[],
  verify: { command: string; args?: string[] },
  extra: Record<string, unknown> = {},
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
    ...extra,
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

// No developer run for api-contract: dispatching it would fail the Job.
const SCRIPT = scriptWith(
  {
    planning: [
      {
        output: {
          tasks: [
            planTask('api-expand', 'api', 'src/math.ts', [], { command: 'has-sum' }),
            planTask('web-use', 'web', 'src/use-sum.ts', ['api-expand'], {
              command: 'exists',
              args: ['src/use-sum.ts'],
            }),
            planTask(
              'api-contract',
              'api',
              'src/math.ts',
              ['web-use'],
              { command: 'has-sum' },
              { title: 'Remove the old add()', deferred: true },
            ),
          ],
        },
      },
      // The follow-up Job's Plan: the contract step, now run. It waits for plan approval.
      {
        output: {
          tasks: [
            planTask(
              'api-contract',
              'api',
              'src/math.ts',
              [],
              { command: 'has-sum' },
              {
                title: 'Remove the old add()',
              },
            ),
          ],
        },
      },
    ],
  },
  {
    'api-expand': developerRun('src/math.ts', SUM_SOURCE, 'Exported sum(a, b) from src/math.ts.'),
    'web-use': developerRun('src/use-sum.ts', USE_SUM, 'Used sum() in src/use-sum.ts.'),
  },
  { 'api-expand': [APPROVE], 'web-use': [APPROVE], integration: [APPROVE, APPROVE] },
);

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

/** api and web registered in Project demo; `github` puts both on the fake GitHub. */
async function twoRepositories(rt: RunningRuntime, sources: Record<string, string>) {
  await createProject(rt, 'demo');
  for (const name of ['api', 'web']) {
    const added = await rt.home.cli([
      'repo',
      'add',
      sources[name] ?? '',
      '--project',
      'demo',
      '--yes',
    ]);
    expect(added.code, added.stderr).toBe(0);
  }
  const repos = await json<RepoBody[]>(rt.request('/v1/repositories'));
  const byName = (name: string) => {
    const repo = repos.find((r) => r.name === name);
    if (repo === undefined) throw new Error(`no Repository ${name}`);
    return repo;
  };
  return { api: byName('api'), web: byName('web') };
}

const terminal = (j: JobBody) => ['completed', 'failed', 'cancelled'].includes(j.status);

describe('the contract step as a follow-up Job (#110)', { timeout: 150_000 }, () => {
  it('never runs the deferred Task, reports it pending, and offers a follow-up Job once every PR merged', async () => {
    const gh = await fakeGitHub();
    const sources: Record<string, string> = {};
    for (const [name, full] of [
      ['api', API],
      ['web', WEB],
    ] as const) {
      const src = tinyTsRepo(name);
      git(src, ['remote', 'add', 'origin', gh.addRepository(full, src).remoteUrl]);
      sources[name] = src;
    }
    const home = await initializedHome();
    useFakeHarness(home, SCRIPT);
    patchFactoryConfig(home, {
      github: {
        token: 'env:GH_ACCESS',
        apiBaseUrl: gh.url,
        pollIntervalMs: 250,
        checksGraceMs: 0,
      },
    });
    const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
    const { api, web } = await twoRepositories(rt, sources);
    for (const repo of [api, web]) await declareCommands(rt, repo.id);
    await skipPlanApproval(rt, api.projectId);
    const res = await post(rt, '/v1/jobs', {
      repositoryIds: [api.id, web.id],
      title: 'Add and use sum()',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as JobBody;
    const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
    expect(job.status, rt.output()).toBe('waiting_human');

    // The deferred Task is never a Task of the Job; the Plan view lists it as deferred.
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.filter((t) => t.kind === 'plan').map((t) => t.key)).toEqual([
      'api-expand',
      'web-use',
    ]);
    const plan = await json<{ deferredTasks: { key: string; repositoryId: string }[] }>(
      rt.request(`/v1/jobs/${job.id}/plan`),
    );
    expect(plan.deferredTasks.map((t) => [t.key, t.repositoryId])).toEqual([
      ['api-contract', api.id],
    ]);
    const shownPlan = await rt.home.cli(['plan', 'show', job.id]);
    expect(shownPlan.stdout).toContain(
      'Deferred (the contract step, offered as a follow-up Job once every pull request has merged):',
    );
    expect(shownPlan.stdout).toMatch(/ {2}api-contract\s+api {2}Remove the old add\(\)/);
    // The Delivery Order comes from the Tasks that run: the contract step's edge orders nothing.
    expect(
      (await json<{ deliveryOrder: unknown }>(rt.request(`/v1/jobs/${job.id}`))).deliveryOrder,
    ).toEqual([
      { repositoryId: api.id, name: 'api', after: [] },
      { repositoryId: web.id, name: 'web', after: [api.id] },
    ]);

    // No contract item while a PR is unmerged.
    const contractItems = async () =>
      (await json<ItemBody[]>(rt.request('/v1/inbox?all=true'))).filter(
        (i) => i.kind === 'contract_job',
      );
    const prs = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`));
    const numberOf = (repo: RepoBody) => prs.find((p) => p.repositoryId === repo.id)?.number ?? 0;
    gh.mergePullRequest(API, numberOf(api));
    await until(
      () => json<PullRequestBody[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`)),
      (seen) => seen.some((p) => p.repositoryId === api.id && p.state === 'merged'),
      "api's merge to be seen",
    );
    expect(await contractItems()).toEqual([]);
    gh.mergePullRequest(WEB, numberOf(web));
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');

    // The Delivery Report lists the pending contract step.
    const report = await reportOf(rt, job.id);
    expect(report.contractStep).toEqual({
      status: 'pending',
      repositories: ['api'],
      tasks: [expect.objectContaining({ key: 'api-contract', repository: 'api' }) as unknown],
      line: 'contract step pending: Task api-contract (api) was deferred by the Plan and did not run in this Job',
    });
    expect(report.notes).toContainEqual(
      'contract step pending: Task api-contract (api) was deferred by the Plan and did not run in this Job. Every pull request has merged, so an Approval in the Inbox offers it as a follow-up Job.',
    );
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain('Contract step (pending):');
    expect(shown.stdout).toContain('  - api-contract (api): Remove the old add()');

    // Every PR merged: the Approval offers the follow-up Job.
    const [item] = await until(contractItems, (items) => items.length > 0, 'the contract item');
    expect(item).toMatchObject({
      jobId: job.id,
      state: 'open',
      question: 'Start the contract Job for api?',
      options: [{ id: 'start_job' }, { id: 'decline' }],
    });
    expect(item?.why).toContain('Task api-contract (api): Remove the old add()');
    if (item === undefined) throw new Error('no contract item');

    // Approving it creates the follow-up Job over api, with the deferred Task as its description.
    // It is planned and approved like any other Job: this Project now requires plan approval.
    const required = await post(rt, `/v1/projects/${api.projectId}/config`, {
      planApproval: 'required',
    });
    expect(required.ok).toBe(true);
    const decided = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'start_job',
      '--expect-version',
      String(item.version),
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    const after = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
    expect(after.state).toBe('decided');
    const followUpId = after.decision?.followUpJobId ?? '';
    expect(decided.stdout).toContain(`follow-up Job: ${followUpId}`);
    const followUp = await json<JobBody>(rt.request(`/v1/jobs/${followUpId}`));
    expect(followUp.title).toBe('Contract step: Add and use sum()');
    expect(followUp.repositories.map((r) => r.name)).toEqual(['api']);
    expect(followUp.description).toContain(
      `The contract step of Job ${job.id} (Add and use sum()): its Plan deferred these Tasks`,
    );
    expect(followUp.description).toContain('- Task api-contract (api): Remove the old add()');
    expect(followUp.description).toContain(`  After (done in Job ${job.id}): web-use`);
    const planned = await waitForJob(rt, followUpId, (j) => j.status === 'waiting_human', 30_000);
    expect(planned.currentStage, rt.output()).toBe('plan_approval');

    // Decided once: a second decision is refused, and no second Job is made.
    const again = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'start_job',
      '--expect-version',
      String(after.version),
    ]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('item_not_open');
    const jobs = await json<JobBody[]>(rt.request('/v1/jobs'));
    expect(jobs.filter((j) => j.title.startsWith('Contract step:'))).toHaveLength(1);
  });
});

describe('the planner prompt: contract and deferred contract step (story 60)', () => {
  it('asks a multi-repo planner for the contract in the upstream Task’s criteria and the contract step deferred', async () => {
    const stub = claudeStub();
    const home = await initializedHome();
    useClaudeCode(home, stub.command);
    const rt = await startRuntime(home);
    killGroupsOnFinish(rt);
    const { api, web } = await twoRepositories(rt, {
      api: tinyTsRepo('api'),
      web: tinyTsRepo('web'),
    });
    const res = await post(rt, '/v1/jobs', {
      repositoryIds: [api.id, web.id],
      title: 'Add and use sum()',
    });
    expect(res.status).toBe(201);
    const planner = await until(
      () => Promise.resolve(stub.invocations().find((r) => r.role === 'planner')?.prompt),
      (p) => p !== undefined,
      'the planner Run',
    );
    expect(planner).toContain(
      'When a Task depends on a Task of another Repository, the upstream Task provides the contract: write the interface it adds (names, signatures, shapes) into its objective, and list in its acceptance the Acceptance Criteria that verify that interface, so the contract is verified, not assumed. A Plan whose upstream Task covers no Acceptance Criterion is invalid.',
    );
    expect(planner).toContain(
      'Change the interface expand → migrate → contract: add the new interface without breaking the old one, migrate the consumers, and put the contract step (removing the old interface) in Tasks marked "deferred": true. Deferred Tasks do not run in this Job; once every pull request has merged, a human is offered them as a follow-up Job. No Task that runs may depend on a deferred Task.',
    );
    const events = await json<{ type: string; payload: Record<string, unknown> }[]>(
      rt.request(`/v1/jobs/${((await res.json()) as JobBody).id}/events`),
    );
    const started = events.find(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect((started?.payload['template'] as { id: string } | undefined)?.id).toBe(
      'proposal-stage@8',
    );
  });

  it('says nothing about contracts to a single-repo planner', async () => {
    const stub = claudeStub();
    const home = await initializedHome();
    useClaudeCode(home, stub.command);
    const rt = await startRuntime(home);
    killGroupsOnFinish(rt);
    await createProject(rt, 'demo');
    const added = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
    expect(added.code, added.stderr).toBe(0);
    const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
    if (repo === undefined) throw new Error('no Repository');
    expect((await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add sum()' })).status).toBe(
      201,
    );
    const planner = await until(
      () => Promise.resolve(stub.invocations().find((r) => r.role === 'planner')?.prompt),
      (p) => p !== undefined,
      'the planner Run',
    );
    expect(planner).not.toContain('the upstream Task provides the contract');
    expect(planner).not.toContain('expand → migrate → contract');
  });
});
