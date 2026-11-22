/**
 * Multi-repo delivery (#106, ADR-0052, ADR-0066; ROADMAP exit test D1): a Job
 * over the `api` and `web` fixtures, each with GitHub coordinates on the fake
 * GitHub. Each Repository gets its own Integration Review (the other
 * Repository's change as context, tied to its own `(head, base)`) and its own
 * PR. Every PR body lists its sibling PRs, the Delivery Order and that the PRs
 * are not atomic, re-rendered as siblings open and merge. web's Merge Gate
 * waits until api's PR has merged; the Delivery Report shows each Repository
 * and says the PRs are not atomic. A human merging web first on GitHub is
 * flagged in the report. Under `human_approval` the factory merges in
 * Delivery Order.
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
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, SUM_SOURCE, validOutput } from '../support/scripts.js';

const GH_ACCESS = 'fake-gh-access-0123456789';
const POLL_MS = 250;
const API = 'acme/api';
const WEB = 'acme/web';
const NOT_ATOMIC =
  'The pull requests are not atomic: each is merged on its own, and one can be merged while another is not.';

interface RepoBody {
  id: string;
  name: string;
  projectId: string;
  clonePath: string;
}
interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
  repositoryId: string;
}
interface ConditionBody {
  id: string;
  label: string;
  status: string;
  reason: string;
}
interface PullRequestBody {
  id: string;
  repositoryId: string;
  taskId: string;
  owner: string;
  name: string;
  number: number;
  url: string;
  state: string;
  headSha: string;
  baseSha: string;
  mergedBefore: string[];
  gate: { verdict: string; conditions: ConditionBody[] } | null;
}
interface ReviewBody {
  taskId: string;
  headSha: string;
  baseSha: string;
  outcome: string;
  promptTemplate: { id: string };
  packet: {
    scope: string;
    diff: { files: string[] };
    otherRepositories?: {
      repository: { id: string; name: string };
      tasks: { key: string; headSha: string; diff: { patch: string; truncated: boolean } }[];
    }[];
  };
}
interface ItemBody {
  id: string;
  kind: string;
  subjectRef: string;
  version: number;
  state: string;
  options: { id: string }[];
}
interface ReportBody {
  reportVersion: number;
  outcome: string;
  notes: string[];
  knownLimitations: string[];
  pullRequests: { repository: string; number: number; state: string; mergedBefore: string[] }[];
  repositories: {
    name: string;
    after: string[];
    status: string;
    pullRequest: string | null;
    integration: { branch: string; state: string } | null;
  }[];
}

const USE_SUM = "import { sum } from './math.js';\n\nexport const five = sum(2, 3);\n";

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
            planTask('api-expand', 'api', 'src/math.ts', [], { command: 'has-sum' }),
            planTask('web-use', 'web', 'src/use-sum.ts', ['api-expand'], {
              command: 'exists',
              args: ['src/use-sum.ts'],
            }),
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

interface Delivery {
  rt: RunningRuntime;
  gh: FakeGitHub;
  api: RepoBody;
  web: RepoBody;
  job: JobBody;
}

/** api and web on the fake GitHub, a Job over both, run until its PRs are open. */
async function deliver(repoArgs: string[] = []): Promise<Delivery> {
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
      pollIntervalMs: POLL_MS,
      checksGraceMs: 0,
    },
  });
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  await createProject(rt, 'demo');
  for (const name of ['api', 'web']) {
    const added = await rt.home.cli([
      'repo',
      'add',
      sources[name] ?? '',
      '--project',
      'demo',
      '--yes',
      ...repoArgs,
    ]);
    expect(added.code, added.stderr).toBe(0);
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
  const res = await post(rt, '/v1/jobs', {
    repositoryIds: [api.id, web.id],
    title: 'Add and use sum()',
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as JobBody;
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
  expect(job.status, rt.output()).toBe('waiting_human');
  return { rt, gh, api, web, job };
}

/** Polls `read` until `done` holds (20 s at most). */
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

async function pullRequests(d: Delivery): Promise<{ api: PullRequestBody; web: PullRequestBody }> {
  const prs = await json<PullRequestBody[]>(d.rt.request(`/v1/jobs/${d.job.id}/pull-requests`));
  const of = (repo: RepoBody) => {
    const pr = prs.find((p) => p.repositoryId === repo.id);
    if (pr === undefined) throw new Error(`no pull request for ${repo.name}`);
    return pr;
  };
  return { api: of(d.api), web: of(d.web) };
}

const conditionOf = (pr: PullRequestBody, id: string) =>
  pr.gate?.conditions.find((c) => c.id === id);

const bodyOf = (gh: FakeGitHub, fullName: string) => gh.pullRequests(fullName)[0]?.body ?? '';

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

const terminal = (j: JobBody) => ['completed', 'failed', 'cancelled'].includes(j.status);

describe('multi-repo delivery (D1, #106)', { timeout: 150_000 }, () => {
  it('reviews and opens one PR per Repository, holds web until api merged, and reports the PRs as not atomic', async () => {
    const d = await deliver();
    const { rt, gh, api, web, job } = d;

    // One PR per Repository, on its own GitHub repository.
    const opened = await pullRequests(d);
    expect([opened.api.owner, opened.api.name, opened.web.name]).toEqual(['acme', 'api', 'web']);
    expect(gh.branchHead(API, `factory/${job.id}/integration`)).toBe(opened.api.headSha);
    expect(gh.branchHead(WEB, `factory/${job.id}/integration`)).toBe(opened.web.headSha);

    // One Integration Review per Repository, tied to that Repository's (head, base), with the
    // other Repository's approved change as read-only context.
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const integrationOf = (repo: RepoBody) =>
      tasks.find((t) => t.kind === 'integration' && t.repositoryId === repo.id)?.id;
    const reviews = (await json<ReviewBody[]>(rt.request(`/v1/jobs/${job.id}/reviews`))).filter(
      (r) => r.packet.scope === 'integration',
    );
    expect(reviews).toHaveLength(2);
    const reviewOf = (repo: RepoBody) => reviews.find((r) => r.taskId === integrationOf(repo));
    const [apiReview, webReview] = [reviewOf(api), reviewOf(web)];
    expect(apiReview).toMatchObject({
      outcome: 'approved',
      promptTemplate: { id: 'integration-review-packet@2' },
      headSha: opened.api.headSha,
      baseSha: opened.api.baseSha,
    });
    expect(webReview).toMatchObject({
      outcome: 'approved',
      headSha: opened.web.headSha,
      baseSha: opened.web.baseSha,
    });
    expect(apiReview?.packet.diff.files).toEqual(['src/math.ts']);
    expect(apiReview?.packet.otherRepositories).toEqual([
      {
        repository: { id: web.id, name: 'web' },
        tasks: [
          expect.objectContaining({
            key: 'web-use',
            diff: {
              patch: expect.stringContaining('+export const five') as string,
              truncated: false,
            },
          }) as unknown,
        ],
      },
    ]);
    expect(webReview?.packet.otherRepositories?.map((r) => r.repository.name)).toEqual(['api']);
    expect(webReview?.packet.otherRepositories?.[0]?.tasks[0]?.diff.patch).toContain(
      '+export function sum',
    );

    // Each PR body lists its siblings, the Delivery Order and that the PRs are not atomic.
    // api's PR opened first; the poller re-renders its body once web's PR is open.
    const apiLabel = `acme/api#${String(opened.api.number)}`;
    const webLabel = `acme/web#${String(opened.web.number)}`;
    const apiBody = await until(
      () => Promise.resolve(bodyOf(gh, API)),
      (b) => b.includes(`${webLabel} ([link](${opened.web.url})), open`),
      "api's body to list web's PR",
    );
    for (const body of [apiBody, bodyOf(gh, WEB)]) {
      expect(body).toContain('## Part of a multi-repository Job');
      expect(body).toContain(NOT_ATOMIC);
      expect(body).toContain('Delivery Order: `api` → `web`.');
    }
    expect(apiBody).toContain('- 1. `api`: this pull request');
    expect(apiBody).toContain(
      '- 2. `web`, after `api`: ' + `${webLabel} ([link](${opened.web.url})), open`,
    );
    expect(bodyOf(gh, WEB)).toContain(
      `- 1. \`api\`: ${apiLabel} ([link](${opened.api.url})), open`,
    );

    // web's Merge Gate waits for api's merge, naming it; api's has no such condition.
    const gated = await until(
      () => pullRequests(d),
      (p) => conditionOf(p.web, 'checks')?.status === 'pass' && p.api.gate !== null,
      'both gates evaluated',
    );
    expect(conditionOf(gated.web, 'delivery_order')).toEqual({
      id: 'delivery_order',
      label: 'The earlier PR in Delivery Order has merged',
      status: 'pending',
      reason: `waits for ${apiLabel} (api) to merge: this Repository comes after api in the Delivery Order`,
    });
    expect(conditionOf(gated.api, 'delivery_order')).toBeUndefined();
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain(
      `pending  The earlier PR in Delivery Order has merged: waits for ${apiLabel} (api) to merge`,
    );

    // A human merges api on GitHub: web's condition passes, and its body says api merged.
    gh.mergePullRequest(API, opened.api.number);
    const released = await until(
      () => pullRequests(d),
      (p) => conditionOf(p.web, 'delivery_order')?.status === 'pass',
      "web's delivery_order condition to pass",
    );
    expect(conditionOf(released.web, 'delivery_order')?.reason).toBe(
      `${apiLabel} (api) has merged`,
    );
    await until(
      () => Promise.resolve(bodyOf(gh, WEB)),
      (b) => b.includes(`${apiLabel} ([link](${opened.api.url})), merged`),
      "web's body to say api merged",
    );

    gh.mergePullRequest(WEB, opened.web.number);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');

    // The Delivery Report: each Repository in Delivery Order, and the PRs are not atomic.
    const report = await reportOf(rt, job.id);
    expect(report.reportVersion).toBe(7);
    expect(report.repositories).toEqual([
      expect.objectContaining({
        name: 'api',
        after: [],
        status: 'merged',
        pullRequest: apiLabel,
        integration: expect.objectContaining({
          branch: `factory/${job.id}/integration`,
          state: 'approved',
        }) as unknown,
      }),
      expect.objectContaining({
        name: 'web',
        after: ['api'],
        status: 'merged',
        pullRequest: webLabel,
      }),
    ]);
    expect(report.notes).toContain(
      `This Job spans 2 Repositories, delivered in the Delivery Order api → web (web after api), each with its own Integration Branch in its own Factory Clone and its own pull request. ${NOT_ATOMIC} A later Repository's Merge Gate waits until the pull requests it comes after have merged.`,
    );
    expect(report.pullRequests.map((p) => p.mergedBefore)).toEqual([[], []]);
    expect(report.knownLimitations.join('\n')).not.toContain('out of order');
    const logs = await rt.home.cli(['job', 'show', job.id]);
    expect(logs.stdout).toContain('Repositories, in Delivery Order:');
    expect(logs.stdout).toContain(`    web: merged (after api), ${webLabel}`);
  });

  it('flags a human merging web on GitHub before api in the Delivery Report', async () => {
    const d = await deliver();
    const { rt, gh, job } = d;
    const opened = await until(
      () => pullRequests(d),
      (p) => p.web.gate !== null,
      "web's gate evaluated",
    );
    const apiLabel = `acme/api#${String(opened.api.number)}`;
    const webLabel = `acme/web#${String(opened.web.number)}`;

    // never_auto can't stop a human merging out of order on GitHub: it is flagged.
    gh.mergePullRequest(WEB, opened.web.number);
    const flagged = await until(
      () => pullRequests(d),
      (p) => p.web.state === 'merged',
      'web seen merged',
    );
    expect(flagged.web.mergedBefore).toEqual([apiLabel]);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    expect(
      events.find((e) => e.type === 'pull_request.merged_out_of_order')?.payload['before'],
    ).toEqual([apiLabel]);

    gh.mergePullRequest(API, opened.api.number);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    const report = await reportOf(rt, job.id);
    expect(report.pullRequests.find((p) => p.repository === WEB)?.mergedBefore).toEqual([apiLabel]);
    expect(report.knownLimitations).toContain(
      `Merged out of order: ${webLabel} was merged on GitHub before ${apiLabel}, which comes before it in the Delivery Order. The factory never merges out of order; a human merging on GitHub can, and the factory flags it here.`,
    );
  });

  it('under human_approval, offers web only once api is approved, and the factory merges api first', async () => {
    const d = await deliver(['--merge-policy', 'human_approval']);
    const { rt, gh, job } = d;
    const items = async () =>
      (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter(
        (i) => i.kind === 'merge' && i.state === 'open',
      );
    const itemOf = (all: ItemBody[], pr: PullRequestBody) =>
      all.find((i) => i.subjectRef.startsWith(`${pr.id}@`));
    const opened = await until(
      () => pullRequests(d),
      (p) => conditionOf(p.api, 'checks')?.status === 'pass' && p.web.gate !== null,
      'both gates evaluated',
    );

    // api is offered; web waits for api (no merge option) until api's merge is approved.
    const offered = await until(
      items,
      (all) => itemOf(all, opened.api)?.options.some((o) => o.id === 'merge') === true,
      "api's item to offer merge",
    );
    expect(itemOf(offered, opened.web)?.options.map((o) => o.id)).not.toContain('merge');
    const apiItem = itemOf(offered, opened.api);
    if (apiItem === undefined) throw new Error('no merge item for api');
    const approved = await post(rt, `/v1/inbox/${apiItem.id}/decide`, {
      expectedVersion: apiItem.version,
      subjectRef: apiItem.subjectRef,
      option: 'merge',
    });
    expect(approved.status).toBe(200);
    // Nothing merges until every PR is approved.
    const webOffered = await until(
      items,
      (all) => itemOf(all, opened.web)?.options.some((o) => o.id === 'merge') === true,
      "web's item to offer merge once api is approved",
    );
    const released = await pullRequests(d);
    expect(conditionOf(released.web, 'delivery_order')).toMatchObject({
      status: 'pass',
      reason: `acme/api#${String(opened.api.number)} (api): its merge is approved, and the factory merges it first, in Delivery Order`,
    });
    expect(gh.pullRequests(API)[0]?.merged).toBe(false);
    const webItem = itemOf(webOffered, opened.web);
    if (webItem === undefined) throw new Error('no merge item for web');
    const decided = await post(rt, `/v1/inbox/${webItem.id}/decide`, {
      expectedVersion: webItem.version,
      subjectRef: webItem.subjectRef,
      option: 'merge',
    });
    expect(decided.status).toBe(200);

    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    // The factory merged api, then web: the order of its merge requests.
    const merges = gh.requests
      .filter((r) => r.method === 'PUT' && r.path.endsWith('/merge'))
      .map((r) => r.path.split('/')[3]);
    expect(merges).toEqual(['api', 'web']);
    const report = await reportOf(rt, job.id);
    expect(report.repositories.map((r) => [r.name, r.status])).toEqual([
      ['api', 'merged'],
      ['web', 'merged'],
    ]);
    expect(report.pullRequests.map((p) => p.mergedBefore)).toEqual([[], []]);
  });
});
