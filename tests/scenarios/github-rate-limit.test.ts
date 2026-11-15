/**
 * The GitHub rate-limit pause and the transient backoff (#66, ADR-0045; Q23).
 * A rate limit is capacity, not failure: the factory sets a GitHub-wide
 * `paused_until` (GitHub's reset), records `github.paused` and
 * `github.resumed`, makes no GitHub call until the reset, and resumes on its
 * own. No Stage Run changes and no Blocker is raised. Repeated 5xx responses
 * back the poller off exponentially (capped at 5 minutes: the cap itself is a
 * unit test, tests/unit/github-backoff.test.ts).
 *
 * Runs against the fake GitHub only (tests/support/github.ts).
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
}
interface PullRequestBody {
  lastPolledAt: string | null;
}
interface GitHubStateBody {
  pause: { pausedUntil: string; pausedAt: string; status: number } | null;
}
interface ItemBody {
  kind: string;
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

async function githubHome(): Promise<{ home: TestHome; gh: FakeGitHub; src: string }> {
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
      checksGraceMs: 60_000,
    },
  });
  return { home, gh, src };
}

/** A Job whose PR is open and polled, waiting in merge_approval. */
async function waitingJob() {
  const { home, gh, src } = await githubHome();
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
  expect(job.status, rt.output()).toBe('waiting_human');
  await until(
    () => pullRequest(rt, job.id),
    (pr) => pr.lastPolledAt !== null,
    'the first poll',
  );
  return { rt, gh, job };
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What must not move while GitHub is unavailable: the Job's status and every Stage Run. */
const standing = (job: JobBody) => ({
  status: job.status,
  stageRuns: job.stageRuns.map((s) => [s.stageId, s.state]),
});

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the GitHub rate-limit pause and the transient backoff', { timeout: 150_000 }, () => {
  it('pauses every GitHub call on a 429 until the reset, shows paused_until in status and on the dashboard, and resumes on its own', async () => {
    const { rt, gh, job } = await waitingJob();
    const before = standing(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)));
    expect(await json<GitHubStateBody>(rt.request('/v1/github'))).toEqual({ pause: null });
    // Started first, so the pages are read while the pause still holds.
    const dash = await startDashboard(rt.home);

    // GitHub's reset is on whole seconds (x-ratelimit-reset).
    const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 8_000);
    gh.simulate({ kind: 'rate_limit', status: 429, resetAt });
    const paused = await until(
      () => json<GitHubStateBody>(rt.request('/v1/github')),
      (s) => s.pause !== null,
      'the pause',
    );
    expect(paused.pause).toMatchObject({ pausedUntil: resetAt.toISOString(), status: 429 });

    // `factory status` shows it, in text and in JSON.
    const shown = await rt.home.cli(['status']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`github:         paused until ${resetAt.toISOString()}`);
    const asJson = await rt.home.cli(['status', '--json']);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      github: { pause: { pausedUntil: resetAt.toISOString(), status: 429 } },
    });

    // So does the dashboard: the Job list and the Job detail.
    const until_ = resetAt
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC');
    expect(text(await dash.html('/'))).toContain(`GitHub calls are paused until ${until_}`);
    expect(text(await dash.html(`/jobs/${job.id}`))).toContain(
      `GitHub calls are paused until ${until_}`,
    );

    // No GitHub call is made while paused (the 429's own request was the last one).
    const sent = gh.requests.length;
    await sleep(Math.min(2_000, resetAt.getTime() - Date.now() - 500));
    expect(Date.now(), 'still before the reset').toBeLessThan(resetAt.getTime());
    expect(gh.requests.slice(sent), 'no GitHub call during the pause').toEqual([]);
    expect(await json<GitHubStateBody>(rt.request('/v1/github'))).toEqual(paused);

    // Capacity, not failure: the Job and its Stage Runs stay where they were, no Blocker.
    expect(standing(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)))).toEqual(before);
    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    expect(items.map((i) => i.kind)).toEqual(['merge']);

    // At the reset the pause ends by itself and polling resumes.
    await until(
      () => json<GitHubStateBody>(rt.request('/v1/github')),
      (s) => s.pause === null,
      'the pause to end',
    );
    expect(Date.now()).toBeGreaterThanOrEqual(resetAt.getTime());
    await until(
      () => pullRequest(rt, job.id),
      (pr) => pr.lastPolledAt !== null && Date.parse(pr.lastPolledAt) >= resetAt.getTime(),
      'a poll after the reset',
    );
    expect(gh.requests.length).toBeGreaterThan(sent);
    expect(standing(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)))).toEqual(before);

    // One event when the pause started, one when it ended; status shows no pause.
    const events = await json<EventBody[]>(rt.request('/v1/events?limit=1000'));
    const github = events.filter((e) => e.entityKind === 'github');
    expect(github.map((e) => e.type)).toEqual(['github.paused', 'github.resumed']);
    expect(github[0]?.payload).toMatchObject({ pausedUntil: resetAt.toISOString(), status: 429 });
    const after = await rt.home.cli(['status']);
    expect(after.stdout).toContain('github:         not paused');
    expect(text(await dash.html('/'))).not.toContain('GitHub calls are paused');
  });

  it('backs off exponentially on repeated 5xx responses, without changing the Job', async () => {
    const { rt, gh, job } = await waitingJob();
    const before = standing(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)));
    const checkRuns = /\/check-runs$/;
    const sent = gh.requests.length;
    for (let i = 0; i < 4; i++)
      gh.simulate({ kind: 'server_error', status: 503 }, { path: checkRuns });

    // The four failed reads, then one that is answered again.
    const reads = await until(
      () =>
        Promise.resolve(
          gh.requests
            .slice(sent)
            .filter((r) => checkRuns.test(r.path.split('?')[0] ?? '') && r.status !== undefined),
        ),
      (rs) => rs.length >= 5,
      'four failures and a recovered read',
    );
    expect(reads.slice(0, 4).map((r) => r.status)).toEqual([503, 503, 503, 503]);
    expect([200, 304]).toContain(reads[4]?.status);
    // Each wait at least the poll interval doubled per failure in a row: 500, 1000, 2000, 4000 ms.
    const gaps = reads.slice(1, 5).map((r, i) => r.at - (reads[i]?.at ?? 0));
    gaps.forEach((gap, i) => {
      expect(gap, `wait after failure ${String(i + 1)}`).toBeGreaterThanOrEqual(
        POLL_MS * 2 ** (i + 1) - 50,
      );
    });

    // Transient failures are not a failure of the Job: nothing moved, no Blocker, no pause.
    expect(standing(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)))).toEqual(before);
    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    expect(items.map((i) => i.kind)).toEqual(['merge']);
    expect(await json<GitHubStateBody>(rt.request('/v1/github'))).toEqual({ pause: null });
  });
});
