/**
 * A moved base (C2; #62, ADR-0041). When the default branch moves, nothing
 * stale is acted on: the gates for the old `(head, base)` go stale, the
 * factory merges the new base into the Integration Branch (a merge commit,
 * never a rebase or a force-push), verification re-runs on the new head, the
 * Integration Review is re-anchored (the diff unchanged, `if_diff_changed`) or
 * runs again (`always`), the same PR is updated in place, CI runs on the new
 * head, and the Merge Gate is evaluated again. The base is checked before the
 * first push, on every poll while the PR is open, and right before merging.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tempDir,
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
interface GateBody {
  verdict: string;
  conditions: { id: string; status: string; reason: string }[];
}
interface PullRequestBody {
  number: number;
  state: string;
  headSha: string;
  baseSha: string;
  pushedSha: string;
  lastPolledAt: string | null;
  gate: GateBody | null;
}
interface ItemBody {
  id: string;
  kind: string;
  reason: string | null;
  subjectRef: string;
  state: string;
  version: number;
  question: string;
  options: { id: string }[];
}
interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  cause: string;
  state: string;
  baseSha: string;
  headSha: string | null;
  verificationRuns: { key: string; exitCode: number | null; headSha: string; baseSha: string }[];
}
interface ReviewBody {
  id: string;
  taskId: string;
  attemptId: string;
  promptTemplate: { id: string };
  sessionRef: string | null;
  headSha: string;
  baseSha: string;
  outcome: string;
  reanchoredFrom: string | null;
}
interface TaskBody {
  id: string;
  kind: string;
  state: string;
  blocker: { reason: string; detail: string } | null;
}

const approve = (code = 'AC-01') => ({
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code, verdict: 'pass', detail: 'the command passed' }],
  },
});

/** A shell loop that waits until `file` exists (30 s at most). */
const waitFor = (file: string) =>
  `i=0; while [ ! -f '${file}' ]; do i=$((i+1)); if [ $i -gt 300 ]; then exit 1; fi; sleep 0.1; done`;

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

/**
 * Two Plan Tasks, `a` and `b` (so the Integration Review runs on the first
 * Integration Branch), each writing its own new file. `reviews`: the
 * Integration Reviews scripted, in order: a re-run beyond them would exhaust
 * the script and fail the review.
 */
function script(reviews: Record<string, unknown>[]) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = (key: string) => ({
    ...structuredClone(base),
    key,
    title: `Write src/${key}.ts`,
    scope: { writable: [`src/${key}.ts`], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: `test-${key}`, command: `test -f src/${key}.ts`, criteria: ['AC-01'] }],
  });
  return scriptWith(
    { planning: [{ output: { tasks: [task('a'), task('b')] } }] },
    {
      a: [writes('src/a.ts', 'export const a = 1;\n')],
      b: [writes('src/b.ts', 'export const b = 1;\n')],
    },
    { a: [approve()], b: [approve()], integration: reviews },
  );
}

async function start(
  opts: {
    reviews?: Record<string, unknown>[];
    projectConfig?: Record<string, unknown>;
    policy?: string;
    pollIntervalMs?: number;
    /** Wait for the Job to reach `waiting_human` (false: the caller drives it). */
    wait?: boolean;
  } = {},
) {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, script(opts.reviews ?? [approve()]));
  patchFactoryConfig(home, {
    github: {
      token: 'env:GH_ACCESS',
      apiBaseUrl: gh.url,
      pollIntervalMs: opts.pollIntervalMs ?? 250,
      checksGraceMs: 0,
    },
  });
  const rt = await startRuntime(home, { env: { ...gh.gitEnv(), GH_ACCESS } });
  const policy = opts.policy === undefined ? [] : ['--merge-policy', opts.policy];
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes', ...policy]);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await skipPlanApproval(rt, repo.projectId, opts.projectConfig ?? {});
  const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add a and b' });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  if (opts.wait === false) return { gh, rt, repo, jobId: created.id };
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
  expect(job.status, rt.output()).toBe('waiting_human');
  return { gh, rt, repo, jobId: created.id };
}

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

async function pullRequest(rt: RunningRuntime, jobId: string): Promise<PullRequestBody> {
  const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
  if (pr === undefined) throw new Error('no pull request recorded');
  return pr;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const readJob = (rt: RunningRuntime, id: string) => json<JobBody>(rt.request(`/v1/jobs/${id}`));

async function integration(rt: RunningRuntime, jobId: string) {
  const [tasks, attempts, reviews] = await Promise.all([
    json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`)),
    json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`)),
    json<ReviewBody[]>(rt.request(`/v1/jobs/${jobId}/reviews`)),
  ]);
  const task = tasks.find((t) => t.kind === 'integration');
  if (task === undefined) throw new Error('no Integration Task');
  return {
    task,
    attempts: attempts.filter((a) => a.taskId === task.id),
    reviews: reviews.filter((r) => r.taskId === task.id),
  };
}

async function eventsOf(rt: RunningRuntime, jobId: string): Promise<EventBody[]> {
  return json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
}

async function itemsOf(rt: RunningRuntime, jobId: string, kind: string): Promise<ItemBody[]> {
  const all = await json<(ItemBody & { jobId: string })[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.kind === kind && i.jobId === jobId);
}

async function decide(rt: RunningRuntime, item: ItemBody, option: string) {
  return post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
  });
}

/** The Job once the base merge-in went through and a new `merge_approval` waits again. */
const remerged = (rt: RunningRuntime, id: string) =>
  until(
    () => readJob(rt, id),
    (j) => stagesOf(j, 'merge_approval').join() === 'superseded,waiting_human',
    'the base merge-in and the new merge_approval',
  );

const parentsOf = (clone: string, sha: string) =>
  git(clone, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);

const commentPosts = (gh: FakeGitHub) =>
  gh.requests.filter((r) => r.method === 'POST' && /\/issues\/\d+\/comments$/.test(r.path));

describe('a moved base (C2)', { timeout: 240_000 }, () => {
  it('C2, unchanged diff: marks the gates stale, merges the base in, re-runs verification and CI, re-anchors the Review, and re-evaluates the Merge Gate', async () => {
    const { gh, rt, repo, jobId } = await start();
    const pr = await until(
      () => pullRequest(rt, jobId),
      (p) => p.lastPolledAt !== null,
      'the first poll',
    );
    const before = await integration(rt, jobId);
    const [merge] = before.attempts;
    const [original] = before.reviews;
    if (merge?.headSha == null || original === undefined) throw new Error('no reviewed head');
    const firstHead = merge.headSha;
    const firstBase = merge.baseSha;
    expect(pr).toMatchObject({ headSha: firstHead, baseSha: firstBase });
    const [oldItem] = await itemsOf(rt, jobId, 'merge');

    // Someone merges an unrelated change on the default branch.
    const movedBase = gh.moveBase(FULL_NAME, { 'NOTES.md': 'an unrelated change\n' });
    const done = await remerged(rt, jobId);

    // The attempt + 1 Stage Runs; job.status derives from them.
    expect(done.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(done, 'integration_review')).toEqual(['succeeded', 'succeeded']);
    expect(stagesOf(done, 'pull_request')).toEqual(['succeeded', 'succeeded']);
    expect(stagesOf(done, 'merge')).toEqual(['pending']);
    const events = await eventsOf(rt, jobId);
    const created = events.filter(
      (e) => e.type === 'stage_run.created' && e.payload['reason'] === 'base_moved',
    );
    expect(created.map((e) => [e.payload['stageId'], e.payload['attempt']])).toEqual([
      ['integration_review', 2],
      ['pull_request', 2],
      ['merge_approval', 2],
    ]);

    // The gates for the old (head, base) were marked stale.
    const moved = events.filter((e) => e.type === 'task.base_moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({
      seen: 'poll',
      headSha: firstHead,
      fromBaseSha: firstBase,
      toBaseSha: movedBase,
    });
    const stale = moved[0]?.payload['stale'] as Record<string, number>;
    expect(stale['verificationRuns']).toBeGreaterThan(0);
    expect(stale['reviews']).toBe(1);

    // The base was merged in: one two-parent merge commit on top of the reviewed head.
    const { task, attempts, reviews } = await integration(rt, jobId);
    expect(task.state).toBe('approved');
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'merge', 'passed'],
      [2, 'base_merge', 'passed'],
    ]);
    const baseMerge = attempts[1] as AttemptBody;
    const newHead = String(baseMerge.headSha);
    expect(baseMerge.baseSha).toBe(movedBase);
    expect(parentsOf(repo.clonePath, newHead)).toEqual([firstHead, movedBase]);

    // Verification re-ran on the new (head, base).
    expect(baseMerge.verificationRuns.map((r) => [r.key, r.exitCode])).toEqual([
      ['test-a', 0],
      ['test-b', 0],
    ]);
    for (const r of baseMerge.verificationRuns) {
      expect([r.headSha, r.baseSha]).toEqual([newHead, movedBase]);
    }

    // The Review was re-anchored to the new SHAs, pointing to the original; no reviewer ran.
    expect(
      reviews.map((r) => [r.attemptId, r.outcome, r.headSha, r.baseSha, r.reanchoredFrom]),
    ).toEqual([
      [merge.id, 'approved', firstHead, firstBase, null],
      [baseMerge.id, 'approved', newHead, movedBase, original.id],
    ]);
    expect(reviews[1]?.sessionRef).toBeNull();
    const reanchored = events.filter((e) => e.type === 'review.reanchored');
    expect(reanchored.map((e) => e.payload['reanchoredFrom'])).toEqual([original.id]);
    expect(reanchored[0]?.payload['patchId']).toMatch(/^[0-9a-f]{40}$/);
    const reviewerRuns = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['role'] === 'reviewer',
    );
    expect(reviewerRuns.filter((e) => e.payload['attemptId'] === baseMerge.id)).toHaveLength(0);

    // The same PR, updated in place: a fast-forward, never a force-push.
    const branch = `factory/${jobId}/integration`;
    expect(gh.pullRequests(FULL_NAME)).toHaveLength(1);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(newHead);
    const posts = commentPosts(gh);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0]?.body)).toMatch(/the default branch moved/);
    expect(JSON.stringify(posts[0]?.body)).toMatch(/re-anchored/);

    // The old merge item is superseded; a new one waits on the new head.
    const items = await itemsOf(rt, jobId, 'merge');
    expect(items.map((i) => [i.id === oldItem?.id, i.state])).toEqual([
      [true, 'superseded'],
      [false, 'open'],
    ]);
    expect(items[1]?.subjectRef).toContain(`${newHead}..${movedBase}`);

    // CI re-runs on the new head, and the Merge Gate is evaluated again on it.
    gh.setCheckRun(FULL_NAME, newHead, {
      name: 'build',
      status: 'completed',
      conclusion: 'success',
    });
    const regated = await until(
      () => pullRequest(rt, jobId),
      (p) =>
        p.headSha === newHead &&
        p.gate?.conditions.find((c) => c.id === 'checks')?.status === 'pass',
      'the Merge Gate on the new head',
    );
    expect(regated.gate?.conditions.find((c) => c.id === 'reviewed_head')?.status).toBe('pass');
    const gates = (await eventsOf(rt, jobId)).filter((e) => e.type === 'merge_gate.evaluated');
    expect(gates.some((e) => e.payload['headSha'] === newHead)).toBe(true);

    // The CLI shows the re-anchored Review.
    const shown = await rt.home.cli(['job', 'show', jobId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`re-anchored from review ${original.id}`);
    expect(shown.stdout).toMatch(/\[base merge: the factory merged the moved default branch in/);
  });

  it('C2, review.rerunOnBaseChange always: the Integration Review re-runs on the new head', async () => {
    const { gh, rt, jobId } = await start({
      reviews: [approve(), approve()],
      projectConfig: { review: { rerunOnBaseChange: 'always' } },
    });
    await until(
      () => pullRequest(rt, jobId),
      (p) => p.lastPolledAt !== null,
      'the first poll',
    );
    const movedBase = gh.moveBase(FULL_NAME, { 'NOTES.md': 'an unrelated change\n' });
    const done = await remerged(rt, jobId);
    expect(done.status, rt.output()).toBe('waiting_human');

    const { attempts, reviews } = await integration(rt, jobId);
    expect(attempts.map((a) => [a.cause, a.state])).toEqual([
      ['merge', 'passed'],
      ['base_merge', 'passed'],
    ]);
    const newHead = String(attempts[1]?.headSha);
    expect(reviews.map((r) => [r.promptTemplate.id, r.headSha, r.reanchoredFrom])).toEqual([
      ['integration-review-packet@1', attempts[0]?.headSha, null],
      ['integration-review-packet@1', newHead, null],
    ]);
    expect(reviews[1]?.baseSha).toBe(movedBase);
    expect(reviews[1]?.sessionRef).not.toBeNull();
    expect((await eventsOf(rt, jobId)).filter((e) => e.type === 'review.reanchored')).toHaveLength(
      0,
    );
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration`)).toBe(newHead);
  });

  it('a base merge-in conflict raises base_merge_conflict', async () => {
    const { gh, rt, jobId } = await start();
    const pr = await until(
      () => pullRequest(rt, jobId),
      (p) => p.lastPolledAt !== null,
      'the first poll',
    );
    // The default branch adds src/a.ts too, differently: merging it in conflicts.
    gh.moveBase(FULL_NAME, { 'src/a.ts': 'export const a = 99;\n' });
    const blocked = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'integration_review').at(-1) === 'waiting_human',
      'the conflict Blocker',
    );
    expect(blocked.status).toBe('waiting_human');
    const { task, attempts } = await integration(rt, jobId);
    expect(task.state).toBe('blocked');
    expect(task.blocker?.reason).toBe('base_merge_conflict');
    expect(task.blocker?.detail).toMatch(
      /merging the moved default branch .* conflicts in src\/a\.ts/,
    );
    // No base merge Attempt was made, and nothing was pushed.
    expect(attempts.map((a) => a.cause)).toEqual(['merge']);
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration`)).toBe(pr.headSha);

    const [item] = (await itemsOf(rt, jobId, 'blocker')).filter((i) => i.state === 'open');
    if (item === undefined) throw new Error('no Blocker Approval');
    expect(item.options.map((o) => o.id)).toEqual(['replan', 'cancel_job']);
    expect((await decide(rt, item, 'cancel_job')).status).toBe(200);
    const cancelled = await waitForJob(rt, jobId, (j) => j.status === 'cancelled', 30_000);
    expect(cancelled.status).toBe('cancelled');
  });

  it('the base check right before merge catches a move after approval and blocks the merge until re-evaluated', async () => {
    // A slow poller: the base moves and the merge is approved between two polls.
    const { gh, rt, jobId } = await start({ policy: 'human_approval', pollIntervalMs: 4_000 });
    const head = (await pullRequest(rt, jobId)).headSha;
    gh.setCheckRun(FULL_NAME, head, { name: 'build', status: 'completed', conclusion: 'success' });
    const offered = await until(
      async () => (await itemsOf(rt, jobId, 'merge')).find((i) => i.state === 'open'),
      (i) => i?.options.some((o) => o.id === 'merge') === true,
      'the merge item to offer merge',
    );
    if (offered === undefined) throw new Error('no merge item');
    // Right after a poll: the next is seconds away.
    const polled = (await pullRequest(rt, jobId)).lastPolledAt;
    await until(
      () => pullRequest(rt, jobId),
      (p) => p.lastPolledAt !== polled,
      'a fresh poll',
    );
    const fresh = (await itemsOf(rt, jobId, 'merge')).find((i) => i.state === 'open');
    if (fresh === undefined) throw new Error('no merge item');
    const movedBase = gh.moveBase(FULL_NAME, { 'NOTES.md': 'an unrelated change\n' });
    expect((await decide(rt, fresh, 'merge')).status).toBe(200);

    const done = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'merge_approval').join() === 'succeeded,waiting_human',
      'the base merge-in and a new merge_approval',
    );
    expect(stagesOf(done, 'merge')).toEqual(['superseded', 'pending']);
    expect(gh.pullRequests(FULL_NAME)[0]?.merged).toBe(false);
    expect(gh.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/merge'))).toHaveLength(
      0,
    );
    const moved = (await eventsOf(rt, jobId)).filter((e) => e.type === 'task.base_moved');
    expect(moved.map((e) => [e.payload['seen'], e.payload['toBaseSha']])).toEqual([
      ['pre_merge', movedBase],
    ]);
    // A new merge item on the new head waits for a new approval.
    const { attempts } = await integration(rt, jobId);
    const newHead = String(attempts.at(-1)?.headSha);
    const items = await itemsOf(rt, jobId, 'merge');
    expect(items.map((i) => i.state)).toEqual(['decided', 'open']);
    expect(items[1]?.subjectRef).toContain(`${newHead}..${movedBase}`);
  });

  it('the base check before the first push merges a base that moved during the Integration Review', async () => {
    const gate = tempDir('base-change-gate-');
    const go = join(gate, 'go');
    const { gh, rt, repo, jobId } = await start({
      reviews: [{ steps: [{ run: waitFor(go) }], ...approve() }],
      wait: false,
    });
    // The Integration Review is running: the base moves before anything is pushed.
    await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'integration_review').at(-1) === 'running',
      'the Integration Review',
    );
    const movedBase = gh.moveBase(FULL_NAME, { 'NOTES.md': 'an unrelated change\n' });
    writeFileSync(go, '');

    const job = await waitForJob(rt, jobId, (j) => j.status !== 'active', 90_000);
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'pull_request')).toEqual(['superseded', 'succeeded']);
    const moved = (await eventsOf(rt, jobId)).filter((e) => e.type === 'task.base_moved');
    expect(moved.map((e) => [e.payload['seen'], e.payload['toBaseSha']])).toEqual([
      ['pre_push', movedBase],
    ]);
    // One PR, opened on the merged-in head: the stale head was never pushed.
    const { attempts, reviews } = await integration(rt, jobId);
    const newHead = String(attempts.at(-1)?.headSha);
    expect(attempts.map((a) => a.cause)).toEqual(['merge', 'base_merge']);
    expect(parentsOf(repo.clonePath, newHead)[1]).toBe(movedBase);
    expect(reviews.at(-1)?.reanchoredFrom).toBe(reviews[0]?.id);
    expect(gh.pullRequests(FULL_NAME)).toHaveLength(1);
    expect(gh.branchHead(FULL_NAME, `factory/${jobId}/integration`)).toBe(newHead);
    expect(await pullRequest(rt, jobId)).toMatchObject({ headSha: newHead, baseSha: movedBase });
  });
});
