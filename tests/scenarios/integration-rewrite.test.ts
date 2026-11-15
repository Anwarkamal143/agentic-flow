/**
 * Rewriting a published Integration Branch (#65; ARCHITECTURE §8.1 and §14,
 * Q25). A Replan rebuilds the Integration Branch from the current base. With
 * no PR open nothing was published, so the rebuilt branch is pushed with no
 * approval. With a PR open, the push waits on the human Blocker
 * `integration_rewrite`: force-push with a lease pinned to the last head the
 * factory pushed (audited, the PR updated in place), a new PR on
 * `factory/<job-id>/integration-2` (the old one closed with a marked
 * comment), or cancel the Job. The factory never force-pushes on its own.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub.
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

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
}
interface PullRequestBody {
  id: string;
  number: number;
  state: string;
  headBranch: string;
  headSha: string;
  pushedSha: string;
  taskId: string;
  lastPolledAt: string | null;
}
interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  taskId: string | null;
  subjectRef: string;
  state: string;
  version: number;
  question: string;
  why: string;
  recommended: string | null;
  options: { id: string }[];
}
interface TaskBody {
  id: string;
  kind: string;
  state: string;
  cancelReason: string | null;
  blocker: { reason: string } | null;
}
interface AttemptBody {
  taskId: string;
  state: string;
  headSha: string | null;
}
interface AuditBody {
  action: string;
  actor: string;
  target: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  policyRef: string | null;
}

const approve = (code = 'AC-01') => ({
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code, verdict: 'pass', detail: 'the command passed' }],
  },
});

/** An Integration Review whose blocking Finding blames the Plan: a Replan before any PR. */
const blamesPlan = {
  output: {
    outcome: 'changes_requested',
    summary: 'The Tasks are split wrongly.',
    findings: [
      {
        severity: 'high',
        faultOrigin: 'plan',
        location: 'src/a.ts:1',
        problem: 'the Plan splits one change across two Tasks',
        why: 'The two files must change together.',
        recommendation: 'Replan it.',
        blocking: true,
      },
    ],
    criteria: [{ code: 'AC-01', verdict: 'fail', detail: 'split wrongly' }],
  },
};

function writes(path: string, content: string) {
  return {
    steps: [{ write: { path, content } }, { commit: `Write ${path}` }],
    result: {
      status: 'done',
      summary: `Wrote ${path}.`,
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
    },
  };
}

function task(key: string) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Write src/${key}.ts`,
    scope: { writable: [`src/${key}.ts`], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: `test-${key}`, command: `test -f src/${key}.ts`, criteria: ['AC-01'] }],
  };
}

/**
 * Plans `a` and `b`; the Replan plans `b` and `c` (the moved base took
 * src/a.ts, so a Task writing it would conflict again). `reviews`: the
 * Integration Reviews, in order.
 */
function script(reviews: Record<string, unknown>[]) {
  return scriptWith(
    {
      planning: [
        { output: { tasks: [task('a'), task('b')] } },
        { output: { tasks: [task('b'), task('c')] } },
      ],
    },
    {
      a: [writes('src/a.ts', 'export const a = 1;\n')],
      b: [writes('src/b.ts', 'export const b = 1;\n'), writes('src/b.ts', 'export const b = 1;\n')],
      c: [writes('src/c.ts', 'export const c = 1;\n')],
    },
    { a: [approve()], b: [approve(), approve()], c: [approve()], integration: reviews },
  );
}

async function start(reviews: Record<string, unknown>[]) {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, script(reviews));
  patchFactoryConfig(home, {
    github: { token: 'env:GH_ACCESS', apiBaseUrl: gh.url, pollIntervalMs: 250, checksGraceMs: 0 },
  });
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes']);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await skipPlanApproval(rt, repo.projectId, {});
  const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add the files' });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  return { gh, rt, repo, jobId: created.id };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const readJob = (rt: RunningRuntime, id: string) => json<JobBody>(rt.request(`/v1/jobs/${id}`));
const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);
const pullRequests = (rt: RunningRuntime, jobId: string) =>
  json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
const eventsOf = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
const auditOf = (rt: RunningRuntime, jobId: string) =>
  json<AuditBody[]>(rt.request(`/v1/jobs/${jobId}/audit`));

async function itemsOf(rt: RunningRuntime, jobId: string): Promise<ItemBody[]> {
  const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.jobId === jobId && i.kind === 'blocker');
}

async function decide(rt: RunningRuntime, item: ItemBody, option: string) {
  return post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
  });
}

/** The newest Integration Task and its approved head. */
async function integration(rt: RunningRuntime, jobId: string) {
  const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
  const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
  const all = tasks.filter((t) => t.kind === 'integration');
  const current = all.at(-1);
  if (current === undefined) throw new Error('no Integration Task');
  const head = attempts.filter((a) => a.taskId === current.id && a.state === 'passed').at(-1);
  return { all, current, head: head?.headSha ?? null };
}

const commentsOn = (gh: FakeGitHub, n: number) => gh.comments(FULL_NAME, n);

/**
 * A PR is open; the base moves under it in a way that conflicts, a human
 * replans, and the rebuilt Integration Branch waits on `integration_rewrite`.
 */
async function rebuiltWithOpenPr() {
  const started = await start([approve(), approve()]);
  const { gh, rt, jobId } = started;
  const [pr] = await until(
    () => pullRequests(rt, jobId),
    (p) => p[0]?.lastPolledAt != null,
    'the first poll',
  );
  if (pr === undefined) throw new Error('no PR');
  // The default branch adds src/a.ts too, differently: merging it in conflicts.
  gh.moveBase(FULL_NAME, { 'src/a.ts': 'export const a = 99;\n' });
  const conflict = await until(
    async () => (await itemsOf(rt, jobId)).find((i) => i.state === 'open'),
    (i) => i?.options.some((o) => o.id === 'replan') === true,
    'the base_merge_conflict Blocker',
  );
  if (conflict === undefined) throw new Error('no conflict item');
  expect((await decide(rt, conflict, 'replan')).status).toBe(200);
  const item = await until(
    async () =>
      (await itemsOf(rt, jobId)).find(
        (i) => i.state === 'open' && i.options.some((o) => o.id === 'force_push_with_lease'),
      ),
    (i) => i !== undefined,
    'the integration_rewrite Blocker',
  );
  if (item === undefined) throw new Error('no integration_rewrite item');
  return { ...started, pr, item };
}

describe('rewriting a published Integration Branch (#65)', { timeout: 300_000 }, () => {
  it('a Replan before any PR rebuilds the Integration Branch and pushes it with no approval', async () => {
    const { gh, rt, jobId } = await start([blamesPlan, approve()]);
    const job = await waitForJob(rt, jobId, (j) => j.status !== 'active', 120_000);
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'integration_review')).toEqual(['superseded', 'succeeded']);
    expect(stagesOf(job, 'pull_request')).toEqual(['succeeded']);

    const { all, current, head } = await integration(rt, jobId);
    expect(all.map((t) => [t.state, t.cancelReason])).toEqual([
      ['cancelled', 'replan'],
      ['approved', null],
    ]);
    // One PR, from the rebuilt branch, and no integration_rewrite: nothing was published before.
    const prs = await pullRequests(rt, jobId);
    expect(prs.map((p) => [p.headBranch, p.pushedSha, p.taskId])).toEqual([
      [`factory/${jobId}/integration`, head, current.id],
    ]);
    expect(gh.pullRequests(FULL_NAME)).toHaveLength(1);
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration`)).toBe(head);
    const items = await itemsOf(rt, jobId);
    expect(items.some((i) => i.options.some((o) => o.id === 'force_push_with_lease'))).toBe(false);
    expect(
      (await auditOf(rt, jobId)).filter((a) => a.action.startsWith('integration_rewrite')),
    ).toEqual([]);
  });

  it('a Replan with an open PR raises integration_rewrite; force_push_with_lease updates the same PR and audits both heads', async () => {
    const { gh, rt, jobId, pr, item } = await rebuiltWithOpenPr();
    const branch = `factory/${jobId}/integration`;

    // Waiting on a human: nothing was pushed, the PR still has the head the factory published.
    const blocked = await readJob(rt, jobId);
    expect(blocked.status).toBe('waiting_human');
    expect(stagesOf(blocked, 'pull_request').at(-1)).toBe('waiting_human');
    expect(item.options.map((o) => o.id)).toEqual([
      'force_push_with_lease',
      'new_pr',
      'cancel_job',
    ]);
    expect(item.recommended).toBe('force_push_with_lease');
    expect(item.question).toMatch(/Integration Task was rebuilt/);
    expect(item.why).toContain(pr.pushedSha);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(pr.pushedSha);
    const { current, head } = await integration(rt, jobId);
    if (head === null) throw new Error('no rebuilt head');
    expect(head).not.toBe(pr.pushedSha);

    expect((await decide(rt, item, 'force_push_with_lease')).status).toBe(200);
    const done = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'merge_approval').at(-1) === 'waiting_human',
      'merge_approval on the force-pushed head',
    );
    expect(stagesOf(done, 'pull_request').at(-1)).toBe('succeeded');

    // The same PR, updated in place on the rebuilt head.
    expect(gh.pullRequests(FULL_NAME)).toHaveLength(1);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(head);
    const [updated] = await pullRequests(rt, jobId);
    expect(updated).toMatchObject({
      id: pr.id,
      number: pr.number,
      state: 'open',
      pushedSha: head,
      taskId: current.id,
    });
    const comments = commentsOn(gh, pr.number);
    expect(comments.some((c) => /force-push whose lease was pinned/.test(c.body))).toBe(true);

    // The decision is audited with the old and new heads and the lease.
    const audit = (await auditOf(rt, jobId)).filter((a) =>
      a.action.startsWith('integration_rewrite'),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'integration_rewrite.force_push_with_lease',
        actor: 'user:local',
        target: `pull_request:${pr.id}`,
        before: expect.objectContaining({ headSha: pr.pushedSha, branch }) as unknown,
        after: { branch, headSha: head, lease: pr.pushedSha },
        policyRef: `inbox:${item.id}/force_push_with_lease`,
      }),
    ]);
    const events = await eventsOf(rt, jobId);
    const pushed = events.filter((e) => e.type === 'pull_request.updated');
    expect(
      pushed.map((e) => [e.payload['forced'], e.payload['fromSha'], e.payload['headSha']]),
    ).toContainEqual([true, pr.pushedSha, head]);
  });

  it('new_pr closes the old PR with a marked comment and opens one on factory/<job-id>/integration-2', async () => {
    const { gh, rt, jobId, pr, item } = await rebuiltWithOpenPr();
    const { current, head } = await integration(rt, jobId);

    expect((await decide(rt, item, 'new_pr')).status).toBe(200);
    const done = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'merge_approval').at(-1) === 'waiting_human',
      'merge_approval on the new PR',
    );
    expect(done.status).toBe('waiting_human');

    const onGitHub = gh.pullRequests(FULL_NAME);
    expect(onGitHub.map((p) => [p.number, p.state, p.head])).toEqual([
      [pr.number, 'closed', `factory/${jobId}/integration`],
      [expect.any(Number), 'open', `factory/${jobId}/integration-2`],
    ]);
    // The old branch is left as it was published; the new one has the rebuilt head.
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration`)).toBe(pr.pushedSha);
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration-2`)).toBe(head);
    const closing = commentsOn(gh, pr.number).filter((c) =>
      c.body.includes(`pull_request.replaced:${item.id}`),
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.body).toContain(`factory/${jobId}/integration-2`);

    const rows = await pullRequests(rt, jobId);
    expect(rows.map((p) => [p.number, p.state, p.headBranch, p.taskId])).toEqual([
      [pr.number, 'closed', `factory/${jobId}/integration`, pr.taskId],
      [onGitHub[1]?.number, 'open', `factory/${jobId}/integration-2`, current.id],
    ]);
    const shown = await rt.home.cli(['job', 'show', jobId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(
      `closed by the factory and replaced by #${String(onGitHub[1]?.number)}`,
    );
    // The replaced PR doesn't count as closed: no pr_closed Blocker, the merge waits on the new one.
    await new Promise((r) => setTimeout(r, 1_000));
    const blockers = (await readJob(rt, jobId)).stageRuns
      .filter((s) => s.stageId === 'merge_approval')
      .at(-1);
    expect(JSON.stringify(blockers)).not.toContain('pr_closed');
    expect((await itemsOf(rt, jobId)).filter((i) => i.state === 'open')).toEqual([]);
    const audit = (await auditOf(rt, jobId)).filter((a) =>
      a.action.startsWith('integration_rewrite'),
    );
    expect(audit.map((a) => [a.action, a.after['branch'], a.after['headSha']])).toEqual([
      ['integration_rewrite.new_pr', `factory/${jobId}/integration-2`, head],
    ]);
  });

  it('the lease is pinned: a push to the branch since the factory pushed refuses the force-push, and it is reported', async () => {
    const { gh, rt, jobId, pr, item } = await rebuiltWithOpenPr();
    const branch = `factory/${jobId}/integration`;
    // Someone pushes to the published branch while the Blocker waits.
    const foreign = gh.pushForeignCommit(FULL_NAME, branch, { 'NOTES.md': 'a foreign note\n' });

    expect((await decide(rt, item, 'force_push_with_lease')).status).toBe(200);
    const done = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'pull_request').at(-1) === 'failed',
      'the refused force-push',
    );
    const failed = done.stageRuns.filter((s) => s.stageId === 'pull_request').at(-1);
    expect(JSON.stringify(failed)).toMatch(/force-push of .* was refused: its lease is pinned to/);
    expect(JSON.stringify(failed)).toContain(pr.pushedSha);
    // Nothing was overwritten.
    expect(gh.branchHead(FULL_NAME, branch)).toBe(foreign);
    const [row] = await pullRequests(rt, jobId);
    expect(row?.pushedSha).toBe(pr.pushedSha);
  });
});
