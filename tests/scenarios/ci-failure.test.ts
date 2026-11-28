/**
 * A CI failure (#61, C4; Q14). A required check failing on the PR head fails
 * the Merge Gate's checks condition and raises the human Blocker `ci_failed`
 * on `merge_approval`: the Job shows the check's name and link (`job show`,
 * the dashboard Job detail), and its Blocker Approval offers `rework` (the
 * check's name, summary and link as untrusted context), `rerun_checks` and
 * `cancel_job`. Nothing reworks on its own. Once the checks no longer fail
 * the Blocker clears and the gate is evaluated again.
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
} from '../support/factory.js';
import { fakeGitHub, type FakeGitHub, type RecordedRequest } from '../support/github.js';
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
import { scriptWith, validOutput } from '../support/scripts.js';

const FULL_NAME = 'acme/tiny-ts';
const GH_ACCESS = 'fake-gh-access-0123456789';
const POLL_MS = 250;
const BUILD_URL = 'https://ci.example/build/1';
const SUMMARY = '2 tests failed: sum.test.ts';

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
}
interface PullRequestBody {
  number: number;
  state: string;
  headSha: string;
  pushedSha: string;
  lastPolledAt: string | null;
  gate: { verdict: string; conditions: { id: string; status: string; reason: string }[] } | null;
  checks: { name: string; outcome: string; url: string | null }[];
}
interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  state: string;
  question: string;
  why: string;
  version: number;
  options: { id: string }[];
}
interface FeedbackBody {
  from: string;
  untrusted: boolean;
  label: string;
  source: string;
  url: string | null;
  trigger: boolean;
  text: string;
}
interface AttemptBody {
  taskId: string;
  n: number;
  cause: string;
  state: string;
  headSha: string | null;
  packet: {
    context: { prFeedback: FeedbackBody[]; guidance: { text: string }[] };
  };
}
interface TaskBody {
  id: string;
  kind: string;
  state: string;
}
interface StageRunDetail {
  stageId: string;
  state: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
  },
};

function writes(content: string, summary: string) {
  return {
    steps: [{ write: { path: 'src/a.ts', content } }, { commit: summary }],
    result: {
      status: 'done',
      summary,
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
    },
  };
}

/** One Plan Task writing `src/a.ts`; the Integration Task's one Rework rewrites it. */
function script() {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'a',
    title: 'Write src/a.ts',
    scope: { writable: ['src/a.ts'], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'exists', args: ['src/a.ts'], criteria: ['AC-01'] }],
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    {
      a: [writes('export const a = 1;\n', 'Write src/a.ts')],
      integration: [writes('export const a = 2;\n', 'Fix the failed build')],
    },
    { a: [APPROVE], integration: [APPROVE] },
  );
}

async function start(requiredChecks: string[] = ['build']) {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, script());
  patchFactoryConfig(home, {
    github: {
      token: 'env:GH_ACCESS',
      apiBaseUrl: gh.url,
      pollIntervalMs: POLL_MS,
      checksGraceMs: 60_000,
    },
  });
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  await createProject(rt, 'demo');
  const added = await rt.home.cli([
    'repo',
    'add',
    src,
    '--project',
    'demo',
    '--yes',
    ...requiredChecks.flatMap((name) => ['--required-check', name]),
  ]);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await declareCommands(rt, repo.id);
  await skipPlanApproval(rt, repo.projectId);
  const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add a' });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
  expect(job.status, rt.output()).toBe('waiting_human');
  const pr = await until(
    () => pullRequest(rt, job.id),
    (p) => p.lastPolledAt !== null,
    'the first poll',
  );
  return { gh, rt, repo, job, pr };
}

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

async function pullRequest(rt: RunningRuntime, jobId: string): Promise<PullRequestBody> {
  const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
  if (pr === undefined) throw new Error('no pull request recorded');
  return pr;
}

const readJob = async (rt: RunningRuntime, id: string) =>
  (await json<JobBody>(rt.request(`/v1/jobs/${id}`))) as JobBody & { stageRuns: StageRunDetail[] };

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

/** The Blocker the latest `merge_approval` holds. */
const mergeApprovalBlocker = (job: { stageRuns: StageRunDetail[] }) =>
  job.stageRuns.filter((s) => s.stageId === 'merge_approval').at(-1)?.blocker ?? null;

async function itemsOf(rt: RunningRuntime, jobId: string, kind: string): Promise<ItemBody[]> {
  const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.kind === kind && i.jobId === jobId);
}

/** The open `ci_failed` Blocker Approval of the Job, once it is there. */
async function openCiItem(rt: RunningRuntime, jobId: string): Promise<ItemBody> {
  const items = await until(
    () => itemsOf(rt, jobId, 'blocker'),
    (all) => all.some((i) => i.state === 'open'),
    'the ci_failed Blocker Approval',
  );
  const open = items.filter((i) => i.state === 'open');
  expect(open).toHaveLength(1);
  return open[0] as ItemBody;
}

async function integrationAttempts(rt: RunningRuntime, jobId: string) {
  const [tasks, attempts] = await Promise.all([
    json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`)),
    json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`)),
  ]);
  const task = tasks.find((t) => t.kind === 'integration');
  if (task === undefined) throw new Error('no Integration Task');
  return { task, attempts: attempts.filter((a) => a.taskId === task.id) };
}

async function eventsOf(rt: RunningRuntime, jobId: string): Promise<EventBody[]> {
  return json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
}

const decide = (rt: RunningRuntime, item: ItemBody, option: string, comment?: string) =>
  post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
    ...(comment === undefined ? {} : { comment }),
  });

/** The Actions re-run requests (#77); the GitHub-App-only check-run rerequest is never sent. */
const rerunRequests = (gh: FakeGitHub) =>
  gh.requests.filter(
    (r) => r.method === 'POST' && /\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(r.path),
  );
const checkRunRerequests = (gh: FakeGitHub) =>
  gh.requests.filter((r) => /\/check-runs\/\d+\/rerequest$/.test(r.path));

function failBuild(gh: FakeGitHub, head: string) {
  gh.setCheckRun(FULL_NAME, head, {
    name: 'build',
    status: 'completed',
    conclusion: 'failure',
    detailsUrl: BUILD_URL,
    summary: SUMMARY,
  });
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('a CI failure', { timeout: 180_000 }, () => {
  it('C4: a failed required check blocks the merge with ci_failed, the Job shows the check with its link, and re-running it clears the Blocker once it passes', async () => {
    const { gh, rt, job, pr } = await start();
    const head = pr.headSha;
    // An optional check failing blocks nothing: only `build` is required.
    gh.setCheckRun(FULL_NAME, head, {
      name: 'flaky',
      workflow: 'optional',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://ci.example/flaky/1',
    });
    failBuild(gh, head);

    const blocked = await until(
      () => readJob(rt, job.id),
      (j) => mergeApprovalBlocker(j)?.reason === 'ci_failed',
      'the ci_failed Blocker',
    );
    expect(blocked.status).toBe('waiting_human');
    expect(stagesOf(blocked, 'merge_approval')).toEqual(['waiting_human']);
    const blocker = mergeApprovalBlocker(blocked);
    expect(blocker?.kind).toBe('human');
    expect(blocker?.detail).toContain('build');
    expect(blocker?.detail).toContain(BUILD_URL);
    expect(blocker?.detail).not.toContain('flaky');
    expect(blocker?.detail).toContain('rerun_checks can re-run build (GitHub Actions)');
    const gated = await pullRequest(rt, job.id);
    expect(gated.gate?.verdict).toBe('fail');
    expect(gated.gate?.conditions.find((c) => c.id === 'checks')).toMatchObject({
      status: 'fail',
      reason: 'failed: build',
    });

    // Its Blocker Approval: rework, re-run the checks, cancel the Job. The merge item stays.
    const item = await openCiItem(rt, job.id);
    expect(item.stageId).toBe('merge_approval');
    expect(item.options.map((o) => o.id)).toEqual(['rework', 'rerun_checks', 'cancel_job']);
    expect(item.question).toMatch(/a required check failed/);
    expect(item.why).toContain(BUILD_URL);
    expect(item.why).toContain('rerun_checks can re-run build (GitHub Actions)');
    expect((await itemsOf(rt, job.id, 'merge')).map((i) => i.state)).toEqual(['open']);

    // job show and the dashboard Job detail show the check's name with its link.
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/merge_approval\s+waiting_human: human Blocker ci_failed/);
    expect(shown.stdout).toContain(BUILD_URL);
    expect(shown.stdout).toMatch(/build\s+failure\s+https:\/\/ci\.example\/build\/1/);
    const dash = await startDashboard(rt.home);
    const html = await dash.html(`/jobs/${job.id}`);
    expect(html).toContain(`href="${BUILD_URL}"`);
    expect(text(html)).toMatch(/Ci failed/i);
    expect(text(html)).toContain(`build (failure, ${BUILD_URL})`);

    // No automatic Rework: polls go on, no Attempt starts.
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect((await integrationAttempts(rt, job.id)).attempts).toHaveLength(1);
    expect(
      (await eventsOf(rt, job.id)).filter((e) => e.type === 'stage_run.created'),
      'no attempt + 1 Stage Run',
    ).toEqual([]);

    // rerun_checks re-runs the failed jobs of the required check's Actions workflow run only,
    // through the Actions API: never the GitHub-App-only check-run rerequest.
    expect(rerunRequests(gh)).toEqual([]);
    const res = await decide(rt, item, 'rerun_checks');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rerunRequests(gh)).toHaveLength(1);
    expect(checkRunRerequests(gh)).toEqual([]);
    const events = await eventsOf(rt, job.id);
    const requested = events.find((e) => e.type === 'pull_request.checks_rerun_requested');
    expect(requested?.payload['checks']).toEqual(['build']);
    expect(requested?.payload['requested']).toEqual([
      expect.objectContaining({ workflow: 'ci', checks: ['build'], headSha: head }),
    ]);
    expect(requested?.payload['notRerun']).toEqual([]);

    // The re-run is queued: the checks no longer fail, so the Blocker clears.
    const cleared = await until(
      () => readJob(rt, job.id),
      (j) => mergeApprovalBlocker(j)?.reason === 'awaiting_merge',
      'the Blocker to clear',
    );
    expect(cleared.status).toBe('waiting_human');
    expect(
      (await pullRequest(rt, job.id)).gate?.conditions.find((c) => c.id === 'checks'),
    ).toMatchObject({ status: 'pending' });
    // A subsequent pass: the gate is evaluated again with the check green.
    gh.setCheckRun(FULL_NAME, head, {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: BUILD_URL,
    });
    const green = await until(
      () => pullRequest(rt, job.id),
      (p) => p.gate?.conditions.find((c) => c.id === 'checks')?.status === 'pass',
      'the checks condition to pass',
    );
    expect(green.checks.find((c) => c.name === 'build')?.outcome).toBe('success');
    expect(mergeApprovalBlocker(await readJob(rt, job.id))?.reason).toBe('awaiting_merge');
    const blockers = await itemsOf(rt, job.id, 'blocker');
    expect(blockers.map((i) => i.state)).toEqual(['decided']);

    // Failing again raises a new ci_failed with its own Blocker Approval.
    failBuild(gh, head);
    const again = await openCiItem(rt, job.id);
    expect(again.id).not.toBe(item.id);
    expect(mergeApprovalBlocker(await readJob(rt, job.id))?.reason).toBe('ci_failed');
    // And a pass before anyone decides supersedes it.
    gh.setCheckRun(FULL_NAME, head, {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: BUILD_URL,
    });
    await until(
      () => itemsOf(rt, job.id, 'blocker'),
      (all) => all.find((i) => i.id === again.id)?.state === 'superseded',
      'the open ci_failed item to be superseded',
    );
    expect(mergeApprovalBlocker(await readJob(rt, job.id))?.reason).toBe('awaiting_merge');
    expect((await integrationAttempts(rt, job.id)).attempts).toHaveLength(1);
  });

  // A poll whose GitHub reads predate a rerun_checks decision would record the old failure after
  // it, and `ciBlockerStep` would raise a new ci_failed Blocker Approval that the next poll
  // supersedes (what made C4 above flaky under load). The decision bumps the pull_requests row's
  // version, so the poller's "row changed while GitHub was read" guard drops the stale poll.
  it('a poll that read the failed check before rerun_checks raises no new Blocker Approval when it records after the decision', async () => {
    const { gh, rt, job, pr } = await start();
    failBuild(gh, pr.headSha);
    const item = await openCiItem(rt, job.id);

    // Hold the next poll between its check-run read (still `failure`) and its write.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const statuses = /\/commits\/[^/]+\/statuses$/;
    const from = gh.requests.length;
    gh.simulate({ kind: 'held', release: held }, { path: statuses });
    const isHeld = (r: RecordedRequest) =>
      statuses.test(r.path.split('?')[0] ?? '') && r.status === undefined;
    await until(
      () => Promise.resolve(gh.requests.slice(from).some(isHeld)),
      (seen) => seen,
      'a poll to hold its statuses read',
    );
    const res = await decide(rt, item, 'rerun_checks');
    expect(res.status, await res.clone().text()).toBe(200);
    release();

    // The re-run is queued: the Blocker clears, and the only Blocker Approval is the decided one.
    await until(
      () => readJob(rt, job.id),
      (j) => mergeApprovalBlocker(j)?.reason === 'awaiting_merge',
      'the Blocker to clear',
    );
    expect((await itemsOf(rt, job.id, 'blocker')).map((i) => i.state)).toEqual(['decided']);
  });

  it('rework sends the failed check to a Rework Attempt as labelled untrusted context and updates the PR in place', async () => {
    const { gh, rt, repo, job, pr } = await start();
    const firstHead = pr.headSha;
    failBuild(gh, firstHead);
    const item = await openCiItem(rt, job.id);

    const res = await decide(rt, item, 'rework', 'Make the build pass.');
    expect(res.status, await res.clone().text()).toBe(200);
    const done = await until(
      () => readJob(rt, job.id),
      (j) => stagesOf(j, 'merge_approval').join() === 'superseded,waiting_human',
      'the Rework and the new merge_approval',
    );
    expect(done.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(done, 'pull_request')).toEqual(['succeeded', 'succeeded']);
    expect(mergeApprovalBlocker(done)?.reason).toBe('awaiting_merge');

    // The Rework Attempt carries the check's name, summary and link, labelled untrusted CI output.
    const { task, attempts } = await integrationAttempts(rt, job.id);
    expect(task.state).toBe('approved');
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'merge', 'passed'],
      [2, 'rework', 'passed'],
    ]);
    const rework = attempts[1] as AttemptBody;
    expect(rework.packet.context.prFeedback).toEqual([
      expect.objectContaining({
        from: 'github',
        untrusted: true,
        source: 'ci',
        url: BUILD_URL,
        trigger: true,
      }),
    ]);
    const [entry] = rework.packet.context.prFeedback;
    expect(entry?.label).toMatch(/^UNTRUSTED CI output/);
    expect(entry?.text).toContain('build');
    expect(entry?.text).toContain(SUMMARY);
    expect(entry?.text).toContain(BUILD_URL);
    // The operator's comment is guidance, not CI text.
    expect(rework.packet.context.guidance.map((g) => g.text)).toEqual(['Make the build pass.']);

    // The same PR, fast-forwarded to the new head.
    const newHead = String(rework.headSha);
    const prs = gh.pullRequests(FULL_NAME);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: pr.number, state: 'open' });
    expect(gh.branchHead(FULL_NAME, `factory/${job.id}/integration`)).toBe(newHead);
    expect(git(repo.clonePath, ['merge-base', '--is-ancestor', firstHead, newHead])).toBe('');
    expect(await pullRequest(rt, job.id)).toMatchObject({ headSha: newHead, pushedSha: newHead });
    expect((await itemsOf(rt, job.id, 'blocker')).map((i) => i.state)).toEqual(['decided']);
    expect((await itemsOf(rt, job.id, 'merge')).map((i) => i.state)).toEqual([
      'superseded',
      'open',
    ]);
  });

  it("refuses rerun_checks by name when only another app's check run and a commit status fail; in a mixed set it re-runs the Actions check and names the others", async () => {
    const { gh, rt, job, pr } = await start(['build', 'circle', 'legacy/ci']);
    const head = pr.headSha;
    gh.setCheckRun(FULL_NAME, head, { name: 'build', status: 'completed', conclusion: 'success' });
    gh.setCheckRun(FULL_NAME, head, {
      name: 'circle',
      app: 'circleci-checks',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://circleci.example/1',
    });
    gh.setStatus(FULL_NAME, head, { context: 'legacy/ci', state: 'failure' });

    // The item says up front what rerun_checks can't re-run.
    const item = await openCiItem(rt, job.id);
    expect(item.why).toContain(
      "rerun_checks can't re-run circle (a check run made by the app circleci-checks), legacy/ci (a commit status)",
    );
    const refused = await decide(rt, item, 'rerun_checks');
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe('nothing_to_rerun');
    expect(body.message).toContain('circle (a check run made by the app circleci-checks)');
    expect(body.message).toContain('legacy/ci (a commit status)');
    expect(rerunRequests(gh)).toEqual([]);
    expect(checkRunRerequests(gh)).toEqual([]);
    const still = await itemsOf(rt, job.id, 'blocker');
    expect(still.find((i) => i.id === item.id)?.state).toBe('open');

    // The Actions check fails too: a new item; rerun_checks re-runs it and names the others.
    failBuild(gh, head);
    const mixed = await until(
      () => itemsOf(rt, job.id, 'blocker'),
      (all) => all.some((i) => i.state === 'open' && i.id !== item.id),
      'the ci_failed item naming build',
    );
    const next = mixed.find((i) => i.state === 'open') as ItemBody;
    expect(next.why).toContain('rerun_checks can re-run build (GitHub Actions)');
    expect(next.why).toContain("it can't re-run circle");
    const res = await decide(rt, next, 'rerun_checks');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rerunRequests(gh)).toHaveLength(1);
    const requested = (await eventsOf(rt, job.id)).find(
      (e) => e.type === 'pull_request.checks_rerun_requested',
    );
    expect(requested?.payload['checks']).toEqual(['build']);
    expect(requested?.payload['notRerun']).toEqual([
      expect.objectContaining({ name: 'circle', why: 'other_app', app: 'circleci-checks' }),
      expect.objectContaining({ name: 'legacy/ci', why: 'commit_status' }),
    ]);
  });

  it('cancels the Job from the ci_failed Blocker Approval', async () => {
    const { gh, rt, job, pr } = await start();
    failBuild(gh, pr.headSha);
    const item = await openCiItem(rt, job.id);
    const res = await decide(rt, item, 'cancel_job');
    expect(res.status, await res.clone().text()).toBe(200);
    const cancelled = await waitForJob(rt, job.id, (j) => j.status === 'cancelled', 30_000);
    expect(stagesOf(cancelled, 'merge_approval')).toEqual(['cancelled']);
    expect(rerunRequests(gh)).toEqual([]);
  });
});
