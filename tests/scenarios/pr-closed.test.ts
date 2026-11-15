/**
 * A PR closed without merging, and cancelling a Job with an open PR (#64;
 * Q16, Q27; ADR-0043).
 *
 * - Closing the PR on GitHub raises the human Blocker `pr_closed` on
 *   `merge_approval` with a Blocker Approval offering `reopen_pr` and
 *   `cancel_job`. The Job is never cancelled on its own. `reopen_pr` reopens
 *   it and the gate is evaluated again; reopening it on GitHub instead closes
 *   the item by itself. A reopen GitHub refuses is reported on the item, with
 *   `cancel_job` still offered.
 * - Cancelling the Job with its PR open opens one cleanup item asking three
 *   questions, each defaulting to keep: discard the preserved Worktrees? close
 *   the PR? delete the remote branch? Each answer has exactly its effect on
 *   GitHub, each PR gets a marked comment, and polling stops.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub (that is C7, `[real]`).
 */
import { existsSync } from 'node:fs';
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
}
interface PullRequestBody {
  number: number;
  state: string;
  headSha: string;
  lastPolledAt: string | null;
  gate: { verdict: string; conditions: { id: string; status: string; reason: string }[] } | null;
}
interface QuestionBody {
  id: string;
  text: string;
  options: string[];
  recommended: string | null;
  blocking: boolean;
  agentProposed: boolean;
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
  questions: QuestionBody[] | null;
  decision: { option: string; answers?: { questionId: string; option?: string }[] } | null;
}
interface StageRunDetail {
  stageId: string;
  state: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}
interface WorktreeBody {
  id: string;
  path: string;
  branch: string;
  state: string;
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
  },
};

/** One Plan Task writing `src/a.ts`, approved; then the Integration Task and its PR. */
function script() {
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
            summary: 'Write src/a.ts',
            commits: [],
            criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
          },
        },
      ],
    },
    { a: [APPROVE], integration: [APPROVE] },
  );
}

/** A Job waiting in `merge_approval` on its open PR, polled once. */
async function start() {
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

/** The Blocker the latest `merge_approval` holds. */
const mergeApprovalBlocker = (job: { stageRuns: StageRunDetail[] }) =>
  job.stageRuns.filter((s) => s.stageId === 'merge_approval').at(-1)?.blocker ?? null;

async function itemsOf(rt: RunningRuntime, jobId: string, kind: string): Promise<ItemBody[]> {
  const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.kind === kind && i.jobId === jobId);
}

/** The Job's open `pr_closed` Blocker Approval, once it is there. */
async function openClosedItem(rt: RunningRuntime, jobId: string): Promise<ItemBody> {
  const items = await until(
    () => itemsOf(rt, jobId, 'blocker'),
    (all) => all.some((i) => i.state === 'open'),
    'the pr_closed Blocker Approval',
  );
  const open = items.filter((i) => i.state === 'open');
  expect(open).toHaveLength(1);
  return open[0] as ItemBody;
}

async function eventsOf(rt: RunningRuntime, jobId: string): Promise<EventBody[]> {
  return json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
}

const decide = (rt: RunningRuntime, item: ItemBody, option: string) =>
  post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
  });

const prOnFake = (gh: FakeGitHub, number: number) => {
  const pr = gh.pullRequests(FULL_NAME).find((p) => p.number === number);
  if (pr === undefined) throw new Error(`no PR #${String(number)} on the fake`);
  return pr;
};

/** The poller's reads of the PR itself. */
const prReads = (gh: FakeGitHub, number: number) =>
  gh.requests.filter(
    (r) => r.method === 'GET' && r.path === `/repos/${FULL_NAME}/pulls/${String(number)}`,
  ).length;

describe('a PR closed without merging', { timeout: 180_000 }, () => {
  it('opens a Blocker Approval with reopen_pr and cancel_job, never cancels the Job, and reopen_pr reopens it so the gate is evaluated again', async () => {
    const { gh, rt, job, pr } = await start();
    gh.closePullRequest(FULL_NAME, pr.number);

    const blocked = await until(
      () => readJob(rt, job.id),
      (j) => mergeApprovalBlocker(j)?.reason === 'pr_closed',
      'the pr_closed Blocker',
    );
    expect(blocked.status).toBe('waiting_human');
    expect(mergeApprovalBlocker(blocked)?.detail).toContain(`${FULL_NAME}#${String(pr.number)}`);
    const item = await openClosedItem(rt, job.id);
    expect(item).toMatchObject({ stageId: 'merge_approval' });
    expect(item.options.map((o) => o.id)).toEqual(['reopen_pr', 'cancel_job']);
    expect(item.question).toContain('closed without merging');
    const closedGate = await pullRequest(rt, job.id);
    expect(closedGate.state).toBe('closed');
    expect(closedGate.gate?.conditions.find((c) => c.id === 'target')?.status).toBe('fail');

    // Nothing is decided alone: polls go by, the Job still waits on the human.
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    expect((await readJob(rt, job.id)).status).toBe('waiting_human');
    expect((await openClosedItem(rt, job.id)).id).toBe(item.id);

    const res = await decide(rt, item, 'reopen_pr');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(prOnFake(gh, pr.number).state).toBe('open');
    const [decided] = (await itemsOf(rt, job.id, 'blocker')).filter((i) => i.id === item.id);
    expect(decided).toMatchObject({ state: 'decided', decision: { option: 'reopen_pr' } });
    expect(mergeApprovalBlocker(await readJob(rt, job.id))?.reason).toBe('awaiting_merge');
    // The gate is evaluated again on the reopened PR: its target passes.
    const reopened = await until(
      () => pullRequest(rt, job.id),
      (p) => p.gate?.conditions.find((c) => c.id === 'target')?.status === 'pass',
      'the gate on the reopened PR',
    );
    expect(reopened.state).toBe('open');
    const log = await eventsOf(rt, job.id);
    const reopenedAt = log.find((e) => e.type === 'pull_request.reopened')?.seq ?? Infinity;
    const evaluated = log.filter((e) => e.type === 'merge_gate.evaluated' && e.seq > reopenedAt);
    const conditions = (e: EventBody) =>
      e.payload['conditions'] as { id: string; status: string }[];
    expect(
      evaluated.some((e) => conditions(e).some((c) => c.id === 'target' && c.status === 'pass')),
      JSON.stringify(evaluated.map((e) => e.payload)),
    ).toBe(true);
    expect(log.map((e) => e.type)).not.toContain('job.cancelled');
  });

  it('reopened on GitHub instead, the item closes itself and the Job waits on the merge again', async () => {
    const { gh, rt, job, pr } = await start();
    gh.closePullRequest(FULL_NAME, pr.number);
    const item = await openClosedItem(rt, job.id);

    gh.reopenPullRequest(FULL_NAME, pr.number);
    const closedItself = await until(
      async () => (await itemsOf(rt, job.id, 'blocker')).find((i) => i.id === item.id),
      (i) => i?.state !== 'open',
      'the item to close itself',
    );
    expect(closedItself).toMatchObject({ state: 'superseded', decision: null });
    const after = await readJob(rt, job.id);
    expect(after.status).toBe('waiting_human');
    expect(mergeApprovalBlocker(after)?.reason).toBe('awaiting_merge');
    expect((await pullRequest(rt, job.id)).state).toBe('open');
    const superseded = (await eventsOf(rt, job.id)).find(
      (e) => e.type === 'approval.superseded' && e.entityId === item.id,
    );
    expect(superseded?.payload['reason']).toBe('the pull request was reopened on GitHub');
  });

  it('a reopen GitHub refuses is reported on the item, which still offers cancel_job', async () => {
    const { gh, rt, job, pr } = await start();
    gh.refuseReopen(FULL_NAME, pr.number);
    gh.closePullRequest(FULL_NAME, pr.number);
    const item = await openClosedItem(rt, job.id);

    const res = await decide(rt, item, 'reopen_pr');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'reopen_refused' });
    expect(prOnFake(gh, pr.number).state).toBe('closed');
    const [reported] = (await itemsOf(rt, job.id, 'blocker')).filter((i) => i.id === item.id);
    if (reported === undefined) throw new Error('the item is gone');
    expect(reported.state).toBe('open');
    expect(reported.version).toBeGreaterThan(item.version);
    expect(reported.why).toContain('GitHub did not reopen');
    expect(reported.why).toContain('refused 422: Validation Failed');
    expect(reported.options.map((o) => o.id)).toEqual(['reopen_pr', 'cancel_job']);
    expect((await readJob(rt, job.id)).status).toBe('waiting_human');
    const refused = (await eventsOf(rt, job.id)).find(
      (e) => e.type === 'approval.reopen_refused' && e.entityId === item.id,
    );
    expect(refused?.payload).toMatchObject({ failure: 'refused', status: 422 });

    // A later poll leaves the reported item as it is (no second item for the same close).
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    const still = (await itemsOf(rt, job.id, 'blocker')).filter((i) => i.state === 'open');
    expect(still.map((i) => [i.id, i.version])).toEqual([[item.id, reported.version]]);

    const cancel = await decide(rt, reported, 'cancel_job');
    expect(cancel.status, await cancel.clone().text()).toBe(200);
    expect((await readJob(rt, job.id)).status).toBe('cancelled');
  });
});

/** Cancels the Job from the CLI and returns its cleanup item and the CLI's output. */
async function cancelWithPr(rt: RunningRuntime, jobId: string) {
  const res = await rt.home.cli(['job', 'cancel', jobId]);
  expect(res.code, res.stderr).toBe(0);
  const [item, more] = await itemsOf(rt, jobId, 'cleanup');
  expect(more).toBeUndefined();
  if (item === undefined) throw new Error('no cleanup item');
  return { item, stdout: res.stdout };
}

/** Answers the cleanup item from the CLI and waits until it is carried out. */
async function answerCleanup(rt: RunningRuntime, item: ItemBody, answers: string[]) {
  const res = await rt.home.cli([
    'inbox',
    'answer',
    item.id,
    ...answers.flatMap((a) => ['--answer', a]),
    '--expect-version',
    String(item.version),
  ]);
  expect(res.code, res.stderr).toBe(0);
  await until(
    () => eventsOf(rt, item.jobId),
    (log) => log.some((e) => e.type === 'cleanup.completed' && e.entityId === item.id),
    'cleanup.completed',
  );
  return eventsOf(rt, item.jobId);
}

const MARKER = (jobId: string) => `<!-- factory:${jobId}:untracked -->`;

describe('cancelling a Job with an open PR', { timeout: 180_000 }, () => {
  it('opens one cleanup item with three keep-by-default questions; keeping everything leaves the PR open with a marked comment, the branch on the remote, and stops polling', async () => {
    const { gh, rt, job, pr } = await start();
    const branch = `factory/${job.id}/integration`;
    const { item, stdout } = await cancelWithPr(rt, job.id);
    expect(item).toMatchObject({ state: 'open', subjectRef: job.id });
    expect(item.options.map((o) => o.id)).toEqual(['answer']);
    expect(
      item.questions?.map((q) => [q.id, q.options, q.recommended, q.blocking, q.agentProposed]),
    ).toEqual([
      ['worktrees', ['keep', 'discard'], 'keep', false, false],
      ['pull_request', ['keep', 'close'], 'keep', false, false],
      ['remote_branch', ['keep', 'delete'], 'keep', false, false],
    ]);
    expect(item.questions?.[1]?.text).toContain(`${FULL_NAME}#${String(pr.number)}`);
    expect(item.questions?.[2]?.text).toContain(branch);
    expect(stdout).toContain(`Cleanup Approval ${item.id}`);
    expect(stdout).toContain('pull_request: Close');
    // Cancelling stopped the polling already: no PR read after the cancel.
    const readsAtCancel = prReads(gh, pr.number);

    // Deleting the branch of a PR kept open is refused (GitHub would close it), and the
    // refusal names the conflict: from the API, the CLI and the dashboard alike.
    const refused = await post(rt, `/v1/inbox/${item.id}/answer`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      answers: [{ questionId: 'remote_branch', option: 'delete' }],
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_answer');
    expect(body.message).toContain('conflicts with keeping the PR open');
    expect(body.message).toContain('pull_request=close');
    const cli = await rt.home.cli([
      'inbox',
      'answer',
      item.id,
      '--answer',
      'remote_branch=delete',
      '--expect-version',
      String(item.version),
    ]);
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toContain('conflicts with keeping the PR open');
    const dash = await startDashboard(rt.home);
    const page = await dash.html(`/inbox/${item.id}`);
    expect(page).toContain('data-testid="cleanup-form"');
    expect(page).toContain('data-testid="delete-needs-close"');
    expect(page).toMatch(
      /<input[^>]*value="delete"[^>]*disabled|<input[^>]*disabled[^>]*value="delete"/,
    );
    const form = await dash.postForm(`/api/inbox/${item.id}/answer`, {
      expectedVersion: String(item.version),
      subjectRef: item.subjectRef,
      'choice.remote_branch': 'delete',
    });
    expect(form.status).toBe(400);
    expect(form.body).toContain('conflicts with keeping the PR open');

    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const log = await answerCleanup(rt, item, ['worktrees=keep']);
    expect(prOnFake(gh, pr.number).state).toBe('open');
    expect(gh.branchHead(FULL_NAME, branch)).toBeDefined();
    const comments = gh.comments(FULL_NAME, pr.number);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(MARKER(job.id));
    expect(comments[0]?.body).toContain('stopped tracking');
    expect(comments[0]?.body).toContain('left open');
    for (const w of worktrees.filter((x) => x.state === 'preserved')) {
      expect(existsSync(w.path), w.path).toBe(true);
    }
    const types = log.map((e) => e.type);
    expect(types).toContain('pull_request.untracked');
    expect(types).not.toContain('pull_request.closed');
    expect(types).not.toContain('pull_request.branch_deleted');

    await new Promise((r) => setTimeout(r, POLL_MS * 6));
    expect(prReads(gh, pr.number), 'polling stopped').toBe(readsAtCancel);
  });

  it('closing the PR and deleting the remote branch do exactly that, with the marked comment; the Task Branches stay', async () => {
    const { gh, rt, repo, job, pr } = await start();
    const branch = `factory/${job.id}/integration`;
    const { item } = await cancelWithPr(rt, job.id);
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const log = await answerCleanup(rt, item, [
      'worktrees=discard',
      'pull_request=close',
      'remote_branch=delete',
    ]);
    expect(prOnFake(gh, pr.number)).toMatchObject({ state: 'closed', merged: false });
    expect(gh.branchHead(FULL_NAME, branch)).toBeUndefined();
    const comments = gh.comments(FULL_NAME, pr.number);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(MARKER(job.id));
    expect(comments[0]?.body).toMatch(/It is closed/);
    const types = log.map((e) => e.type);
    // Closed first, then the comment, then the branch.
    const order = ['pull_request.closed', 'pull_request.untracked', 'pull_request.branch_deleted'];
    expect(
      order
        .map((t) => types.indexOf(t))
        .every((i, n, all) => i >= 0 && (n === 0 || i > (all[n - 1] ?? 0))),
    ).toBe(true);
    expect((await pullRequest(rt, job.id)).state).toBe('closed');
    // The Worktrees are discarded; every Task Branch stays in the Factory Clone.
    const after = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    for (const w of worktrees.filter((x) => x.state === 'preserved')) {
      expect(after.find((a) => a.id === w.id)?.state).toBe('removed');
      expect(existsSync(w.path), w.path).toBe(false);
      expect(git(repo.clonePath, ['rev-parse', '--verify', w.branch]).trim()).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
  });

  it('a transient GitHub failure is recorded once and retried later; the cleanup then completes', async () => {
    const { gh, rt, job, pr } = await start();
    const branch = `factory/${job.id}/integration`;
    const { item } = await cancelWithPr(rt, job.id);
    // GitHub fails the branch deletion twice (a 503), then answers.
    const refs = /\/git\/refs\/heads\//;
    gh.simulate({ kind: 'server_error', status: 503 }, { path: refs });
    gh.simulate({ kind: 'server_error', status: 503 }, { path: refs });
    const log = await answerCleanup(rt, item, ['pull_request=close', 'remote_branch=delete']);
    expect(gh.branchHead(FULL_NAME, branch)).toBeUndefined();
    expect(prOnFake(gh, pr.number).state).toBe('closed');
    const failed = log.filter((e) => e.type === 'cleanup.step_failed' && e.entityId === item.id);
    expect(failed.map((e) => [e.payload['step'], e.payload['failure']])).toEqual([
      ['delete_branch', 'transient'],
    ]);
    // Retried at the timer, not in a tight loop: three DELETEs in all, the PR closed once.
    const deletes = gh.requests.filter((r) => r.method === 'DELETE' && refs.test(r.path));
    expect(deletes).toHaveLength(3);
    expect(log.filter((e) => e.type === 'pull_request.closed')).toHaveLength(1);
    expect(gh.comments(FULL_NAME, pr.number)).toHaveLength(1);
  });

  it('closing the PR alone keeps the remote branch', async () => {
    const { gh, rt, job, pr } = await start();
    const branch = `factory/${job.id}/integration`;
    const { item } = await cancelWithPr(rt, job.id);
    const log = await answerCleanup(rt, item, ['pull_request=close']);
    expect(prOnFake(gh, pr.number).state).toBe('closed');
    expect(gh.branchHead(FULL_NAME, branch)).toBeDefined();
    expect(gh.comments(FULL_NAME, pr.number).map((c) => c.body.includes(MARKER(job.id)))).toEqual([
      true,
    ]);
    expect(log.map((e) => e.type)).not.toContain('pull_request.branch_deleted');
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(worktrees.some((w) => w.state === 'removed')).toBe(false);
  });
});
