/**
 * Foreign pushes to the Integration Branch (#63, ADR-0042). When someone
 * other than the factory pushes to `factory/<job-id>/integration`, the poller
 * sees a PR head the factory did not push. The factory fetches it and never
 * overwrites it; the path-scope Gate, every command and the Integration Review
 * run again on it through `attempt + 1` Stage Runs; the PR body and the
 * Delivery Report list the foreign commits; and every later factory push
 * fast-forwards from that head. A foreign commit outside the union of the
 * Plan Tasks' writable globs fails the path-scope Gate, and a human decides
 * through its Blocker.
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
const FOREIGN_SUBJECT = 'A commit the factory did not write';

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
}
interface PullRequestBody {
  number: number;
  headSha: string;
  pushedSha: string;
  lastPolledAt: string | null;
}
interface ItemBody {
  id: string;
  kind: string;
  subjectRef: string;
  state: string;
  version: number;
  options: { id: string }[];
}
interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  baseSha: string;
  headSha: string | null;
  foreignCommits: { sha: string; subject: string; author: string }[];
  droppedCommits: { sha: string; subject: string; author: string }[];
  findings: { rule: string | null; problem: string }[];
  verificationRuns: { key: string; exitCode: number | null; headSha: string; baseSha: string }[];
}
interface ReviewBody {
  taskId: string;
  attemptId: string;
  headSha: string;
  sessionRef: string | null;
  reanchoredFrom: string | null;
  outcome: string;
}
interface TaskBody {
  id: string;
  kind: string;
  state: string;
  blocker: { reason: string; detail: string } | null;
}
interface ReportBody {
  outcome: string;
  integration: {
    foreignCommits: { sha: string; subject: string; attemptId: string; attemptState: string }[];
    droppedCommits: { sha: string; subject: string; attemptId: string; attemptState: string }[];
  } | null;
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
  },
};

const done = (summary: string) => ({
  status: 'done',
  summary,
  commits: [],
  criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
});

/**
 * One Plan Task writing `src/a.ts` (its scope, and so the Integration Task's,
 * is `src/a.ts` only). `integration`: the Integration Task's developer Runs;
 * `reviews`: its Integration Reviews, in order.
 */
function script(integration: Record<string, unknown>[], reviews: Record<string, unknown>[]) {
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
          result: done('Wrote src/a.ts.'),
        },
      ],
      // The script takes no empty list: a key with none is left out.
      ...(integration.length === 0 ? {} : { integration }),
    },
    { a: [APPROVE], ...(reviews.length === 0 ? {} : { integration: reviews }) },
  );
}

async function start(integration: Record<string, unknown>[], reviews: Record<string, unknown>[]) {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, script(integration, reviews));
  patchFactoryConfig(home, {
    github: { token: 'env:GH_ACCESS', apiBaseUrl: gh.url, pollIntervalMs: 250, checksGraceMs: 0 },
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
  return { gh, rt, repo, jobId: job.id, pr, branch: `factory/${job.id}/integration` };
}

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

async function pullRequest(rt: RunningRuntime, jobId: string): Promise<PullRequestBody> {
  const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
  if (pr === undefined) throw new Error('no pull request recorded');
  return pr;
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
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

const eventsOf = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));

async function itemsOf(rt: RunningRuntime, jobId: string, kind: string): Promise<ItemBody[]> {
  const all = await json<(ItemBody & { jobId: string })[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.kind === kind && i.jobId === jobId);
}

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

/** `true` when `ancestor` is reachable from `descendant` in `repo`. */
function descends(repo: string, ancestor: string, descendant: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

const bodyOf = (gh: FakeGitHub) => gh.pullRequests(FULL_NAME)[0]?.body ?? '';

/** The Job once the foreign head was verified and a new `merge_approval` waits again. */
const settled = (rt: RunningRuntime, id: string, runs: string) =>
  until(
    () => readJob(rt, id),
    (j) => stagesOf(j, 'merge_approval').join() === runs,
    `merge_approval to be ${runs}`,
  );

describe('foreign pushes to the Integration Branch (#63)', { timeout: 240_000 }, () => {
  it('fetches a foreign commit, re-verifies and re-reviews it, lists it as foreign, and fast-forwards the next factory push from it', async () => {
    const { gh, rt, repo, jobId, pr, branch } = await start(
      [
        {
          steps: [
            { write: { path: 'src/a.ts', content: 'export const a = 3;\n' } },
            { commit: 'Rework after PR feedback' },
          ],
          result: done('Made a equal 3.'),
        },
      ],
      // The Integration Review of the foreign head, then of the Rework.
      [APPROVE, APPROVE],
    );
    const factoryHead = pr.headSha;
    expect(pr.pushedSha).toBe(factoryHead);

    // Someone pushes a commit to the Integration Branch, inside the writable scope.
    const foreign = gh.pushForeignCommit(FULL_NAME, branch, {
      'src/a.ts': 'export const a = 2;\n',
    });
    const adopted = await settled(rt, jobId, 'superseded,waiting_human');
    expect(adopted.status, rt.output()).toBe('waiting_human');

    // The attempt + 1 Stage Runs, for the foreign push.
    const events = await eventsOf(rt, jobId);
    const created = events.filter(
      (e) => e.type === 'stage_run.created' && e.payload['reason'] === 'foreign_push',
    );
    expect(created.map((e) => [e.payload['stageId'], e.payload['attempt']])).toEqual([
      ['integration_review', 2],
      ['pull_request', 2],
      ['merge_approval', 2],
    ]);
    const seen = events.filter((e) => e.type === 'task.foreign_push');
    expect(seen.map((e) => [e.payload['pushedSha'], e.payload['foreignHeadSha']])).toEqual([
      [factoryHead, foreign],
    ]);

    // Fetched and verified as the factory's own: no Harness, the path-scope Gate and the commands.
    const { task, attempts, reviews } = await integration(rt, jobId);
    expect(task.state).toBe('approved');
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'merge', 'passed'],
      [2, 'foreign_push', 'passed'],
    ]);
    const [merge, adoption] = attempts as [AttemptBody, AttemptBody];
    expect(adoption.headSha).toBe(foreign);
    expect(adoption.baseSha).toBe(merge.baseSha);
    expect(adoption.foreignCommits).toEqual([
      { sha: foreign, subject: FOREIGN_SUBJECT, author: expect.any(String) as string },
    ]);
    expect(adoption.verificationRuns.map((r) => [r.key, r.exitCode, r.headSha])).toEqual([
      ['test', 0, foreign],
    ]);
    // The Integration Review ran on the foreign head (a reviewer, nothing re-anchored).
    const review = reviews.find((r) => r.attemptId === adoption.id);
    expect(review).toMatchObject({ headSha: foreign, outcome: 'approved', reanchoredFrom: null });
    expect(review?.sessionRef).not.toBeNull();

    // Never overwritten: the PR head is the foreign one, which the factory now counts as pushed.
    expect(gh.branchHead(FULL_NAME, branch)).toBe(foreign);
    expect(await pullRequest(rt, jobId)).toMatchObject({ headSha: foreign, pushedSha: foreign });
    expect(bodyOf(gh)).toContain('## Foreign commits');
    expect(bodyOf(gh)).toContain(`\`${foreign}\``);
    expect(bodyOf(gh)).toContain(`\`${FOREIGN_SUBJECT}\``);
    const shown = await rt.home.cli(['job', 'show', jobId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/\[foreign push: someone else pushed to the Integration Branch/);
    expect(shown.stdout).toContain(`foreign:   ${foreign.slice(0, 12)}`);

    // The factory's next push (a feedback Rework) fast-forwards from the foreign head.
    gh.addComment(FULL_NAME, pr.number, { user: 'bob', body: '/factory please make a equal 3' });
    await settled(rt, jobId, 'superseded,superseded,waiting_human');
    const after = await integration(rt, jobId);
    expect(after.attempts.map((a) => [a.cause, a.state])).toEqual([
      ['merge', 'passed'],
      ['foreign_push', 'passed'],
      ['rework', 'passed'],
    ]);
    const reworkHead = String(after.attempts[2]?.headSha);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(reworkHead);
    expect(descends(repo.clonePath, foreign, reworkHead)).toBe(true);
    expect(bodyOf(gh)).toContain(`\`${foreign}\``);

    // A human merges on GitHub: the Delivery Report lists the foreign commit.
    gh.mergePullRequest(FULL_NAME, pr.number);
    const closed = await waitForJob(rt, jobId, (j) => j.status === 'completed', 60_000);
    expect(closed.status, rt.output()).toBe('completed');
    const report = await reportOf(rt, jobId);
    expect(report.integration?.foreignCommits).toEqual([
      expect.objectContaining({
        sha: foreign,
        subject: FOREIGN_SUBJECT,
        attemptId: adoption.id,
        attemptState: 'passed',
      }),
    ]);
  });

  it('fails the path-scope Gate on a foreign commit outside the writable scope, and a human decides through the Blocker', async () => {
    const { gh, rt, repo, jobId, branch } = await start(
      [
        {
          // The human's Rework: revert the out-of-scope file on top of the foreign commit.
          steps: [{ run: 'git rm --quiet NOTES.md' }, { commit: 'Revert NOTES.md' }],
          result: done('Reverted the out-of-scope NOTES.md.'),
        },
      ],
      [APPROVE],
    );
    const foreign = gh.pushForeignCommit(FULL_NAME, branch, { 'NOTES.md': 'out of scope\n' });
    const blocked = await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'integration_review').at(-1) === 'waiting_human',
      'the foreign push Blocker',
    );
    expect(blocked.status).toBe('waiting_human');

    const { task, attempts } = await integration(rt, jobId);
    expect(task.state).toBe('blocked');
    expect(task.blocker?.reason).toBe('foreign_push_out_of_scope');
    const adoption = attempts.at(-1);
    expect(adoption).toMatchObject({
      cause: 'foreign_push',
      state: 'failed',
      exitReason: 'gates_failed',
      headSha: foreign,
    });
    expect(adoption?.findings.map((f) => f.rule)).toEqual(['scope.outside_writable']);
    expect(adoption?.findings[0]?.problem).toContain('NOTES.md');
    // No command ran on out-of-scope work, and nothing was pushed over the foreign commit.
    expect(adoption?.verificationRuns).toEqual([]);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(foreign);

    const [item] = (await itemsOf(rt, jobId, 'blocker')).filter((i) => i.state === 'open');
    if (item === undefined) throw new Error('no Blocker Approval');
    expect(item.options.map((o) => o.id)).toEqual(['rework', 'cancel_job']);
    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'rework',
      comment: 'Revert NOTES.md: it is outside the scope.',
    });
    expect(decided.status, await decided.clone().text()).toBe(200);

    // The Rework goes on top of the foreign head, is reviewed, and the PR fast-forwards to it.
    await settled(rt, jobId, 'superseded,waiting_human');
    const after = await integration(rt, jobId);
    expect(after.task.state).toBe('approved');
    expect(after.attempts.map((a) => [a.cause, a.state])).toEqual([
      ['merge', 'passed'],
      ['foreign_push', 'failed'],
      ['rework', 'passed'],
    ]);
    const reworkHead = String(after.attempts[2]?.headSha);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(reworkHead);
    expect(descends(repo.clonePath, foreign, reworkHead)).toBe(true);
    expect(bodyOf(gh)).toContain(`\`${foreign}\``);
  });

  it('blocks a foreign rewrite of the Integration Branch on a human, and on adopt_rewrite verifies and reviews it and lists the dropped approved commits', async () => {
    const { gh, rt, repo, jobId, pr, branch } = await start([], [APPROVE]);
    const approvedHead = pr.headSha;
    // Someone force-pushes a rewrite: one commit on the default branch, inside the scope.
    const rewrite = gh.forcePushForeignCommit(FULL_NAME, branch, {
      'src/a.ts': 'export const a = 5;\n',
    });
    expect(descends(repo.clonePath, approvedHead, rewrite)).toBe(false);
    await until(
      () => readJob(rt, jobId),
      (j) => stagesOf(j, 'integration_review').at(-1) === 'waiting_human',
      'the rewrite Blocker',
    );
    const blocked = await integration(rt, jobId);
    expect(blocked.task.state).toBe('blocked');
    expect(blocked.task.blocker?.reason).toBe('foreign_push_rewrite');
    expect(blocked.task.blocker?.detail).toContain(rewrite);
    expect(blocked.task.blocker?.detail).toContain(approvedHead);
    // Not adopted before a human approves, and never force-pushed back.
    expect(blocked.attempts.map((a) => a.cause)).toEqual(['merge']);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(rewrite);

    const [item] = (await itemsOf(rt, jobId, 'blocker')).filter((i) => i.state === 'open');
    if (item === undefined) throw new Error('no Blocker Approval');
    expect(item.options.map((o) => o.id)).toEqual(['adopt_rewrite', 'cancel_job']);
    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'adopt_rewrite',
    });
    expect(decided.status, await decided.clone().text()).toBe(200);

    // Adopted: verified and reviewed like any foreign push.
    await settled(rt, jobId, 'superseded,waiting_human');
    const { task, attempts, reviews } = await integration(rt, jobId);
    expect(task.state).toBe('approved');
    expect(attempts.map((a) => [a.cause, a.state])).toEqual([
      ['merge', 'passed'],
      ['foreign_push', 'passed'],
    ]);
    const adoption = attempts[1] as AttemptBody;
    expect(adoption.headSha).toBe(rewrite);
    expect(adoption.verificationRuns.map((r) => [r.key, r.exitCode, r.headSha])).toEqual([
      ['test', 0, rewrite],
    ]);
    expect(reviews.find((r) => r.attemptId === adoption.id)).toMatchObject({
      headSha: rewrite,
      outcome: 'approved',
    });
    expect(adoption.foreignCommits.map((c) => c.sha)).toEqual([rewrite]);
    // The approved commits the rewrite dropped are listed, the approved head among them.
    const dropped = adoption.droppedCommits.map((c) => c.sha);
    expect(dropped).toContain(approvedHead);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(rewrite);
    expect(await pullRequest(rt, jobId)).toMatchObject({ headSha: rewrite, pushedSha: rewrite });
    expect(bodyOf(gh)).toContain('Dropped by a rewrite');
    expect(bodyOf(gh)).toContain(`\`${approvedHead}\``);
    const approvals = (await itemsOf(rt, jobId, 'blocker')).filter((i) => i.id === item.id);
    expect(approvals.map((i) => i.state)).toEqual(['decided']);
    const audited = (await eventsOf(rt, jobId)).filter((e) => e.type === 'audit.recorded');
    expect(audited.map((e) => [e.payload['action'], e.payload['rewriteSha']])).toEqual([
      ['integration_rewrite.adopted', rewrite],
    ]);

    gh.mergePullRequest(FULL_NAME, pr.number);
    const closed = await waitForJob(rt, jobId, (j) => j.status === 'completed', 60_000);
    expect(closed.status, rt.output()).toBe('completed');
    const report = await reportOf(rt, jobId);
    expect(report.integration?.foreignCommits.map((c) => c.sha)).toEqual([rewrite]);
    expect(report.integration?.droppedCommits.map((c) => c.sha)).toEqual(dropped);
    expect(report.integration?.droppedCommits[0]?.attemptId).toBe(adoption.id);
  });

  it('cancels the Job from the rewrite Blocker without touching the foreign rewrite', async () => {
    const { gh, rt, jobId, branch } = await start([], []);
    const rewrite = gh.forcePushForeignCommit(FULL_NAME, branch, {
      'src/a.ts': 'export const a = 5;\n',
    });
    const item = await until(
      async () => (await itemsOf(rt, jobId, 'blocker')).find((i) => i.state === 'open'),
      (i) => i !== undefined,
      'the rewrite Blocker Approval',
    );
    if (item === undefined) throw new Error('no Blocker Approval');
    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'cancel_job',
    });
    expect(decided.status, await decided.clone().text()).toBe(200);
    const cancelled = await waitForJob(rt, jobId, (j) => j.status === 'cancelled', 30_000);
    expect(cancelled.status).toBe('cancelled');
    expect((await integration(rt, jobId)).attempts.map((a) => a.cause)).toEqual(['merge']);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(rewrite);
  });
});
