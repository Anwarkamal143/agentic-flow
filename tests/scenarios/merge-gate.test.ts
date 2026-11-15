/**
 * The poller and the Merge Gate under `never_auto` (#58, ADR-0037). While the
 * PR is open the factory polls it (ETags kept in memory), records the PR, its
 * checks and `mergeable_state` only when what it saw changed, and evaluates
 * the Merge Gate from those rows. `merge_approval` holds one `merge` item per
 * PR `(head, base)`: under `never_auto` the human merges on GitHub, the poller
 * sees it, closes the item as `system:github-poller`, `merge` records the
 * merge SHA and closure runs. The views read only the persisted rows.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub (that is C7, `[real]`).
 */
import { describe, expect, it } from 'vitest';
import { startDashboard } from '../support/dashboard.js';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
  type TestHome,
} from '../support/factory.js';
import { fakeGitHub, type FakeGitHub } from '../support/github.js';
import {
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

const FULL_NAME = 'acme/tiny-ts';
const GH_ACCESS = 'fake-gh-access-0123456789';
const POLL_MS = 250;

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
  defaultBranch: string;
}
interface GateBody {
  verdict: string;
  conditions: { id: string; label: string; status: string; reason: string }[];
}
interface PullRequestBody {
  id: string;
  number: number;
  url: string;
  state: string;
  headSha: string;
  mergeSha: string | null;
  lastPolledAt: string | null;
  gate: GateBody | null;
  checks: { name: string; outcome: string; url: string | null }[];
}
interface ItemBody {
  id: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  state: string;
  question: string;
  why: string;
  version: number;
  options: { id: string }[];
  decidedBy: string | null;
}
interface AttemptBody {
  taskId: string;
  evidence: { kind: string; source: string; verdict: string; detail: string; headSha: string }[];
}
interface ReportBody {
  reportVersion: number;
  outcome: string;
  statement: string;
  knownLimitations: string[];
  pullRequests: {
    number: number;
    state: string;
    mergeSha: string | null;
    ci: { status: string; reason: string; checks: { name: string; url: string | null }[] } | null;
  }[];
}

/** One Plan Task writing `src/a.ts`: the Integration Review is skipped by its rule. */
function oneTaskScript() {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'a',
    title: 'Write src/a.ts',
    scope: { writable: ['src/a.ts'], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'test -f src/a.ts', criteria: ['AC-01'] }],
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    {
      a: [
        {
          steps: [
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
          result: {
            status: 'done',
            summary: 'Wrote src/a.ts.',
            commits: [],
            criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
          },
        },
      ],
    },
    {
      a: [
        {
          output: {
            outcome: 'approved',
            summary: 'Looks right.',
            findings: [],
            criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
          },
        },
      ],
    },
  );
}

async function githubHome(
  graceMs: number,
): Promise<{ home: TestHome; gh: FakeGitHub; src: string }> {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, oneTaskScript());
  patchFactoryConfig(home, {
    github: {
      token: 'env:GH_ACCESS',
      apiBaseUrl: gh.url,
      pollIntervalMs: POLL_MS,
      checksGraceMs: graceMs,
    },
  });
  return { home, gh, src };
}

async function startJob(home: TestHome, gh: FakeGitHub, src: string) {
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes']);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await skipPlanApproval(rt, repo.projectId);
  const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add a' });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
  return { rt, repo, job };
}

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

async function pullRequest(rt: RunningRuntime, jobId: string): Promise<PullRequestBody> {
  const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
  if (pr === undefined) throw new Error('no pull request recorded');
  return pr;
}

/** Polls `read` until `done` holds (20 s at most). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const gateOf = (pr: PullRequestBody, id: string) => pr.gate?.conditions.find((c) => c.id === id);

async function eventsOf(rt: RunningRuntime, jobId: string): Promise<EventBody[]> {
  const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
  if (!Array.isArray(events)) throw new Error(`no event list: ${JSON.stringify(events)}`);
  expect(events.length, 'fewer events than one page').toBeLessThan(1000);
  return events;
}

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the poller and the Merge Gate under never_auto', { timeout: 150_000 }, () => {
  it('waits on the merge item with green checks, polls without writing when nothing changed, and completes with the merge SHA once a human merges on GitHub', async () => {
    const { home, gh, src } = await githubHome(60_000);
    const { rt, job } = await startJob(home, gh, src);

    // The PR is open; merge_approval waits for the human, the Job is waiting_human.
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'pull_request')).toEqual(['succeeded']);
    expect(stagesOf(job, 'merge_approval')).toEqual(['waiting_human']);
    expect(stagesOf(job, 'merge')).toEqual(['pending']);
    const branch = `factory/${job.id}/integration`;
    const head = gh.branchHead(FULL_NAME, branch);
    if (head === undefined) throw new Error('the Integration Branch was not pushed');

    // One merge item for the PR (head, base): "merge on GitHub", request_changes is #60's.
    const items = (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter(
      (i) => i.kind === 'merge',
    );
    expect(items).toHaveLength(1);
    const [item] = items as [ItemBody];
    expect(item).toMatchObject({ stageId: 'merge_approval', state: 'open' });
    expect(item.subjectRef).toContain(head);
    expect(item.options.map((o) => o.id)).toEqual(['cancel_job']);
    expect(`${item.question} ${item.why}`).toMatch(/merge .*on GitHub/i);

    // A green check on the head: every condition passes but the policy (never_auto).
    gh.setCheckRun(FULL_NAME, head, {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://ci.example/build/1',
    });
    const green = await until(
      () => pullRequest(rt, job.id),
      (pr) => gateOf(pr, 'checks')?.status === 'pass',
      'the checks condition to pass',
    );
    expect(green.gate?.conditions.map((c) => [c.id, c.status])).toEqual([
      ['target', 'pass'],
      ['reviewed_head', 'pass'],
      ['checks', 'pass'],
      ['reviews', 'pass'],
      ['mergeable', 'pass'],
      ['policy', 'pending'],
    ]);
    expect(green.checks).toEqual([
      expect.objectContaining({
        name: 'build',
        outcome: 'success',
        url: 'https://ci.example/build/1',
      }),
    ]);
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).status).toBe('waiting_human');
    // The PR body was re-rendered with the checks and PATCHed.
    await until(
      () => Promise.resolve(gh.pullRequests(FULL_NAME)[0]?.body ?? ''),
      (body) => body.includes('`build`: success'),
      'the PR body to show the check',
    );

    // Nothing changes on GitHub any more: polls are answered 304 and write no event.
    const polledAfter = async (since: string | null, times: number) => {
      let last = since;
      for (let i = 0; i < times; i++) {
        const seen = last;
        last = (
          await until(
            () => pullRequest(rt, job.id),
            (pr) => pr.lastPolledAt !== seen,
            'another poll',
          )
        ).lastPolledAt;
      }
      return last;
    };
    const settledAt = await polledAfter((await pullRequest(rt, job.id)).lastPolledAt, 2);
    const eventCount = (await eventsOf(rt, job.id)).length;
    const requestCount = gh.requests.length;
    await polledAfter(settledAt, 3);
    expect((await eventsOf(rt, job.id)).length, 'no event without a change').toBe(eventCount);
    const quiet = gh.requests.slice(requestCount).filter((r) => r.status !== undefined);
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((r) => r.method === 'GET')).toBe(true);
    expect(quiet.every((r) => r.headers['if-none-match'] !== undefined)).toBe(true);
    expect(quiet.every((r) => r.status === 304)).toBe(true);

    // job show shows each condition, the check with its link and when it was polled.
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/Merge Gate: pending/);
    expect(shown.stdout).toMatch(/pass\s+The reviewed SHA is the PR head/);
    expect(shown.stdout).toMatch(/pending\s+The Merge Policy: never_auto/);
    expect(shown.stdout).toMatch(/build\s+success\s+https:\/\/ci\.example\/build\/1/);
    expect(shown.stdout).toMatch(/last polled \d{4}-\d\d-\d\dT/);

    // A human merges on GitHub: the poller sees it and the Job completes.
    const [pr] = gh.pullRequests(FULL_NAME);
    const mergeSha = gh.mergePullRequest(FULL_NAME, pr?.number ?? 0);
    const done = await waitForJob(
      rt,
      job.id,
      (j) => ['completed', 'failed', 'cancelled'].includes(j.status),
      30_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    expect(stagesOf(done, 'merge_approval')).toEqual(['succeeded']);
    expect(stagesOf(done, 'merge')).toEqual(['succeeded']);
    expect(stagesOf(done, 'closure')).toEqual(['succeeded']);
    const decided = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
    expect(decided).toMatchObject({ state: 'decided', decidedBy: 'system:github-poller' });
    const events = await eventsOf(rt, job.id);
    const merged = events.find(
      (e) => e.type === 'stage_run.succeeded' && e.payload['stageId'] === 'merge',
    );
    expect(merged?.payload['mergeSha']).toBe(mergeSha);
    const recorded = await pullRequest(rt, job.id);
    expect(recorded).toMatchObject({ state: 'merged', mergeSha });

    const report = await reportOf(rt, job.id);
    expect(report.reportVersion).toBe(6);
    expect(report.outcome).toBe('completed');
    expect(report.pullRequests).toEqual([expect.objectContaining({ state: 'merged', mergeSha })]);
    expect(report.pullRequests[0]?.ci?.checks).toEqual([
      expect.objectContaining({ name: 'build', url: 'https://ci.example/build/1' }),
    ]);
    expect(report.statement).toContain(mergeSha);

    // Polling stopped with the merge; no page load calls GitHub.
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    const before = gh.requests.length;
    const after = await rt.home.cli(['job', 'show', job.id]);
    expect(after.stdout).toMatch(/merged/);
    expect(after.stdout).toContain(mergeSha);
    expect(after.stdout).toMatch(/build\s+success\s+https:\/\/ci\.example\/build\/1/);
    const dash = await startDashboard(rt.home);
    const html = await dash.html(`/jobs/${job.id}`);
    expect(html).toContain('href="https://ci.example/build/1"');
    expect(text(html)).toContain('The reviewed SHA is the PR head');
    expect(text(html)).toMatch(/The Merge Policy pending/);
    expect(text(html)).toMatch(/Last polled \d{4}-/);
    expect(gh.requests.length, 'no GitHub call from job show or the dashboard').toBe(before);
  });

  it('passes the checks condition with "no checks reported" after the grace window, and Evidence, the PR body and the Delivery Report say so', async () => {
    const { home, gh, src } = await githubHome(1_500);
    const { rt, job } = await startJob(home, gh, src);
    expect(job.status, rt.output()).toBe('waiting_human');

    const passed = await until(
      () => pullRequest(rt, job.id),
      (pr) => gateOf(pr, 'checks')?.status === 'pass',
      'the grace window to pass',
    );
    expect(gateOf(passed, 'checks')?.reason).toMatch(/^no checks reported on /);

    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    const ci = attempts.flatMap((a) => a.evidence).filter((e) => e.kind === 'ci');
    expect(ci).toEqual([
      expect.objectContaining({ source: 'github', verdict: 'pass', headSha: passed.headSha }),
    ]);
    expect(ci[0]?.detail).toMatch(/no checks reported/);
    await until(
      () => Promise.resolve(gh.pullRequests(FULL_NAME)[0]?.body ?? ''),
      (body) => /\*\*pass\*\*: no checks reported/.test(body),
      'the PR body to say no checks reported',
    );

    const [pr] = gh.pullRequests(FULL_NAME);
    gh.mergePullRequest(FULL_NAME, pr?.number ?? 0);
    const done = await waitForJob(
      rt,
      job.id,
      (j) => ['completed', 'failed', 'cancelled'].includes(j.status),
      30_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const report = await reportOf(rt, job.id);
    expect(report.pullRequests[0]?.ci).toMatchObject({ status: 'pass', checks: [] });
    expect(report.pullRequests[0]?.ci?.reason).toMatch(/^no checks reported/);
  });

  it('cancels the Job from the merge item; polling stops', async () => {
    const { home, gh, src } = await githubHome(60_000);
    const { rt, job } = await startJob(home, gh, src);
    expect(job.status, rt.output()).toBe('waiting_human');
    const [item] = (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter(
      (i) => i.kind === 'merge',
    );
    if (item === undefined) throw new Error('no merge item');

    const res = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'cancel_job',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const cancelled = await waitForJob(rt, job.id, (j) => j.status === 'cancelled', 30_000);
    expect(stagesOf(cancelled, 'merge_approval')).toEqual(['cancelled']);
    await new Promise((r) => setTimeout(r, POLL_MS * 3));
    const before = gh.requests.length;
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect(gh.requests.length, 'no polling after the Job was cancelled').toBe(before);
  });
});
