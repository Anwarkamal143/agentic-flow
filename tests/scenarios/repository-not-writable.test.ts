/**
 * `repository_not_writable` and Partial Completion (#108, ADR-0052,
 * ADR-0068; ROADMAP exit test D5). Before a Task's first Attempt the factory
 * checks that the Factory Clone is writable and that the GitHub token may push
 * to the Repository. A Job over `api` and `web` where the token can't push to
 * api: api's Task is blocked with the exact reason, web is delivered, and the
 * Delivery Report shows "partial completion: 1 of 2 delivered" while the Job
 * stays blocked and after it is cancelled. A single-repo Job blocked the same
 * way runs once the permission is fixed and the human checks again; a push
 * GitHub refuses for lack of permission raises the same Blocker.
 *
 * Runs against the fake GitHub only (tests/support/github.ts); asserted
 * through the API, the CLI and the fake's records.
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
import { fakeGitHub, type FakeGitHub } from '../support/github.js';
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

const GH_ACCESS = 'fake-gh-access-0123456789';
const POLL_MS = 250;
const API = 'acme/api';
const WEB = 'acme/web';
const NO_PUSH =
  "the GitHub token has no push permission on acme/api (GitHub reports the repository's permissions.push as false), so the factory could not push api's Integration Branch";

interface RepoBody {
  id: string;
  name: string;
  projectId: string;
}
interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
  state: string;
  repositoryId: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  subjectRef: string;
  version: number;
  state: string;
  question: string;
  why: string;
  options: { id: string }[];
}
interface ReportBody {
  outcome: string;
  statement: string;
  notes: string[];
  partialCompletion?: { delivered: number; total: number; line: string } | null;
  repositories: {
    name: string;
    status: string;
    pullRequest: string | null;
    blocker?: { reason: string; detail: string } | null;
  }[];
}

function planTask(key: string, repository: string, writable: string, verify: object) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `${key} in ${repository}`,
    repository,
    scope: { writable: [writable], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', ...verify, criteria: ['AC-01'] }],
  };
}

function developerRun(path: string, content: string) {
  return [
    {
      steps: [{ write: { path, content } }, { commit: `Write ${path}` }],
      result: {
        status: 'done',
        summary: `Wrote ${path}.`,
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

/** api and web, independent: no Task of one depends on the other's. */
const TWO_REPOS = scriptWith(
  {
    planning: [
      {
        output: {
          tasks: [
            planTask('api-sum', 'api', 'src/math.ts', { command: 'has-sum' }),
            planTask('web-page', 'web', 'src/page.ts', {
              command: 'exists',
              args: ['src/page.ts'],
            }),
          ],
        },
      },
    ],
  },
  {
    'api-sum': developerRun('src/math.ts', SUM_SOURCE),
    'web-page': developerRun('src/page.ts', 'export const page = 1;\n'),
  },
  { 'api-sum': [APPROVE], 'web-page': [APPROVE], integration: [APPROVE, APPROVE] },
);

/** api alone. */
const ONE_REPO = scriptWith(
  {
    planning: [
      { output: { tasks: [planTask('api-sum', 'api', 'src/math.ts', { command: 'has-sum' })] } },
    ],
  },
  { 'api-sum': developerRun('src/math.ts', SUM_SOURCE) },
  { 'api-sum': [APPROVE], integration: [APPROVE] },
);

interface Setup {
  rt: RunningRuntime;
  gh: FakeGitHub;
  repos: Record<string, RepoBody>;
}

/** The named fixtures on the fake GitHub, with `before` applied to it, in one Project. */
async function setup(
  names: string[],
  script: string,
  before: (gh: FakeGitHub) => void,
): Promise<Setup> {
  const gh = await fakeGitHub();
  const sources: Record<string, string> = {};
  for (const name of names) {
    const src = tinyTsRepo(name);
    git(src, ['remote', 'add', 'origin', gh.addRepository(`acme/${name}`, src).remoteUrl]);
    sources[name] = src;
  }
  before(gh);
  const home = await initializedHome();
  useFakeHarness(home, script);
  patchFactoryConfig(home, {
    github: {
      token: 'env:GH_ACCESS',
      apiBaseUrl: gh.url,
      pollIntervalMs: POLL_MS,
      checksGraceMs: 0,
    },
  });
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  await createProject(rt, 'demo');
  for (const name of names) {
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
  const all = await json<RepoBody[]>(rt.request('/v1/repositories'));
  const repos: Record<string, RepoBody> = {};
  for (const repo of all) {
    repos[repo.name] = repo;
    await declareCommands(rt, repo.id);
  }
  const first = all[0];
  if (first === undefined) throw new Error('no Repository');
  await skipPlanApproval(rt, first.projectId);
  return { rt, gh, repos };
}

async function createJob(s: Setup, names: string[]): Promise<JobBody> {
  const res = await post(s.rt, '/v1/jobs', {
    repositoryIds: names.map((n) => s.repos[n]?.id),
    title: 'Add sum()',
  });
  expect(res.status).toBe(201);
  return (await res.json()) as JobBody;
}

const tasksOf = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));

async function openItem(rt: RunningRuntime, jobId: string): Promise<ItemBody> {
  const items = await json<(ItemBody & { jobId: string })[]>(rt.request('/v1/inbox'));
  const item = items.find((i) => i.jobId === jobId && i.kind === 'blocker' && i.state === 'open');
  if (item === undefined) throw new Error('no open Blocker Approval');
  return item;
}

function decide(rt: RunningRuntime, item: ItemBody, option: string): Promise<Response> {
  return post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
  });
}

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

/** Polls `read` until `done` holds (30 s at most). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('repository_not_writable and Partial Completion (D5, #108)', { timeout: 150_000 }, () => {
  it('blocks the unwritable Repository with the exact reason, delivers the other, and reports partial completion while blocked and after a cancel', async () => {
    const s = await setup(['api', 'web'], TWO_REPOS, (gh) => {
      gh.denyPush(API);
    });
    const { rt, gh, repos } = s;
    const created = await createJob(s, ['api', 'web']);

    // web goes on to its PR while api's Task is blocked before any Attempt.
    await until(
      () => Promise.resolve(gh.pullRequests(WEB)),
      (prs) => prs.length === 1,
      "web's pull request",
    );
    const tasks = await tasksOf(rt, created.id);
    const apiTask = tasks.find((t) => t.kind === 'plan' && t.repositoryId === repos['api']?.id);
    expect(apiTask).toMatchObject({
      key: 'api-sum',
      state: 'blocked',
      blocker: { kind: 'infrastructure', reason: 'repository_not_writable', detail: NO_PUSH },
    });
    const attempts = await json<{ taskId: string }[]>(
      rt.request(`/v1/jobs/${created.id}/attempts`),
    );
    expect(
      attempts.filter((a) => a.taskId === apiTask?.id),
      'no Attempt is made on an unwritable Repository',
    ).toEqual([]);
    expect(
      tasks.filter((t) => t.kind === 'integration').map((t) => t.repositoryId),
      'only web is integrated',
    ).toEqual([repos['web']?.id]);
    expect(gh.pullRequests(API)).toEqual([]);
    const item = await openItem(rt, created.id);
    expect(item).toMatchObject({
      taskId: apiTask?.id,
      question: "Task api-sum can't start: its Repository is not writable",
      options: [{ id: 'retry_check' }, { id: 'cancel_job' }],
    });
    expect(item.why).toContain(NO_PUSH);

    // A human merges web on GitHub (never_auto): the report is written, and the Job stays blocked.
    const [webPr] = gh.pullRequests(WEB);
    gh.mergePullRequest(WEB, webPr?.number ?? 0);
    const blocked = await waitForJob(rt, created.id, (j) => j.status === 'blocked', 30_000);
    expect(blocked.stageRuns.find((r) => r.stageId === 'closure')).toMatchObject({
      state: 'blocked',
      blocker: { reason: 'repository_not_writable' },
    });
    const report = await reportOf(rt, created.id);
    expect(report.partialCompletion).toEqual({
      delivered: 1,
      total: 2,
      line: 'partial completion: 1 of 2 delivered',
    });
    expect(report.repositories.map((r) => [r.name, r.status])).toEqual([
      ['api', 'not_delivered'],
      ['web', 'merged'],
    ]);
    expect(report.repositories.map((r) => r.blocker)).toEqual([
      { reason: 'repository_not_writable', detail: NO_PUSH },
      null,
    ]);
    expect(report.notes).toContain(
      'partial completion: 1 of 2 delivered. Not delivered: api (repository_not_writable). The Job stays blocked until the Blocker is cleared or the Job is cancelled.',
    );
    const shown = await rt.home.cli(['job', 'show', created.id]);
    expect(shown.stdout).toContain('partial completion: 1 of 2 delivered');
    expect(shown.stdout).toContain('    api: not delivered (repository_not_writable)');

    // web is delivered without api, so checking again can't bring api into this Job.
    const late = await decide(rt, await openItem(rt, created.id), 'retry_check');
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe('partial_delivery_started');

    // Cancelled: the report still shows the Partial Completion.
    const cancelled = await rt.home.cli(['job', 'cancel', created.id]);
    expect(cancelled.code, cancelled.stderr).toBe(0);
    await waitForJob(rt, created.id, (j) => j.status === 'cancelled', 10_000);
    expect((await reportOf(rt, created.id)).partialCompletion?.line).toBe(
      'partial completion: 1 of 2 delivered',
    );
    const after = await rt.home.cli(['job', 'show', created.id]);
    expect(after.stdout).toContain('partial completion: 1 of 2 delivered');
  });

  it('a single-repo Job blocked by the preflight runs once the permission is fixed and checked again', async () => {
    const s = await setup(['api'], ONE_REPO, (gh) => {
      gh.denyPush(API);
    });
    const { rt, gh } = s;
    const created = await createJob(s, ['api']);
    const blocked = await waitForJob(rt, created.id, (j) => j.status === 'blocked', 30_000);
    expect(blocked.stageRuns.find((r) => r.stageId === 'execution')).toMatchObject({
      state: 'blocked',
      blocker: { reason: 'repository_not_writable' },
    });

    // Checked again while it is still not writable: blocked again, with a new item.
    const first = await openItem(rt, created.id);
    expect((await decide(rt, first, 'retry_check')).status).toBe(200);
    await until(
      () => openItem(rt, created.id).catch(() => undefined),
      (i) => i !== undefined && i.id !== first.id,
      'a new Blocker Approval',
    );

    gh.allowPush(API);
    const again = await openItem(rt, created.id);
    expect((await decide(rt, again, 'retry_check')).status).toBe(200);
    const waiting = await waitForJob(rt, created.id, (j) => j.status === 'waiting_human', 60_000);
    expect(waiting.currentStage).toBe('merge_approval');
    expect(gh.pullRequests(API)).toHaveLength(1);
  });

  it('a push GitHub refuses for lack of permission raises the same Blocker, and checking again pushes', async () => {
    // The REST API still reports push: only the push itself is refused (permission lost mid-Job).
    const s = await setup(['api'], ONE_REPO, (gh) => {
      gh.denyPush(API, { apiStillAllows: true });
    });
    const { rt, gh } = s;
    const created = await createJob(s, ['api']);
    const blocked = await waitForJob(rt, created.id, (j) => j.status === 'blocked', 60_000);
    const pr = blocked.stageRuns.find((r) => r.stageId === 'pull_request');
    expect(pr).toMatchObject({ state: 'blocked', blocker: { reason: 'repository_not_writable' } });
    const tasks = await tasksOf(rt, created.id);
    expect(tasks.find((t) => t.kind === 'integration')?.state).toBe('approved');
    const item = await openItem(rt, created.id);
    expect(item.question).toBe(
      "Integration Task can't be delivered: its Repository is not writable",
    );
    expect(item.why).toContain(
      `GitHub refused the push of factory/${created.id}/integration to acme/api for lack of permission`,
    );
    expect(item.why).toContain('Permission to acme/api.git denied');
    expect(gh.pullRequests(API)).toEqual([]);

    gh.allowPush(API);
    expect((await decide(rt, item, 'retry_check')).status).toBe(200);
    const waiting = await waitForJob(rt, created.id, (j) => j.status === 'waiting_human', 30_000);
    expect(waiting.currentStage).toBe('merge_approval');
    expect(gh.pullRequests(API)).toHaveLength(1);
  });
});
