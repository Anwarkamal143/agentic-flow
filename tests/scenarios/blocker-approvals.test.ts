/**
 * Blocker Approvals (#43, ROADMAP exit test B5; ARCHITECTURE §8.1; ADR-0026).
 * A cap reached or an uncertain recovery opens an Inbox Approval with fixed
 * options in the transaction that sets the Blocker. A grant raises the cap
 * (audited, decided by `user:local`) and the Task goes on with the human's
 * guidance; "retry now" re-checks the recorded process before a Retry and
 * never starts one beside a live process; "cancel the Job" runs the cancel
 * operation.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createJob,
  json,
  phaseAConfig,
  post,
  registeredRepo,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { startDashboard } from '../support/dashboard.js';
import { factoryGroups, groupAlive, killGroupsOnFinish, waitFor } from '../support/processes.js';
import { scriptWith, validTaskResponse } from '../support/scripts.js';

interface ItemBody {
  id: string;
  jobId: string;
  taskId: string | null;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  question: string;
  why: string;
  options: { id: string; agentProposed: boolean }[];
  state: string;
  requestedBy: string;
  decidedBy: string | null;
  decision: { option: string; comment: string | null; grant?: number } | null;
  version: number;
}

interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  headSha: string | null;
  worktreeId: string;
  findings: { rule: string | null }[];
  packet: {
    context: {
      guidance: { attemptN: number; text: string; decidedBy: string; approvalId: string }[];
      priorFindings: unknown[];
    };
  };
}

interface TaskBody {
  id: string;
  state: string;
  maxAttempts: number;
  maxRetries: number;
  maxQuestions: number;
  blocker: { kind: string; reason: string; attemptId: string } | null;
}

interface AuditBody {
  actor: string;
  action: string;
  target: string;
  before: Record<string, number>;
  after: Record<string, number>;
  policyRef: string | null;
  correlationId: string | null;
}

const settled = (job: JobBody) => job.status !== 'active';

/** A developer response that commits the forbidden `package.json` (the path-scope Gate fails). */
function touchingPackageJson(content: string) {
  const response = validTaskResponse();
  response.steps.push(
    { write: { path: 'package.json', content } },
    { commit: 'Change package.json' },
  );
  return response;
}

/** A later Attempt that changes `package.json` again, and nothing else. */
const touchingOnlyPackageJson = (content: string) => ({
  steps: [{ write: { path: 'package.json', content } }, { commit: 'Change package.json again' }],
  result: validTaskResponse().result,
});

/** A later Attempt that restores `package.json` from the base, keeping sum(). */
const restoringPackageJson = () => ({
  steps: [{ run: 'git checkout origin/main -- package.json' }, { commit: 'Restore package.json' }],
  result: { ...validTaskResponse().result, summary: 'Restored package.json.' },
});

/** A developer Run that asks one blocking question, after committing `content`. */
const asks = (content: string) => ({
  steps: [{ write: { path: 'src/math.ts', content } }, { commit: 'Start on sum()' }],
  result: {
    status: 'needs_decision',
    summary: 'sum() could round or not.',
    commits: [],
    criteria: [],
    questions: [{ text: 'Should sum() round?', options: ['round', 'exact'], blocking: true }],
  },
});

async function runtimeWith(tasks: unknown[], config: Record<string, unknown>) {
  const home = await initializedHome();
  useFakeHarness(home, scriptWith({}, { 'add-sum': tasks }));
  const rt = await startRuntime(home);
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; projectId: string; clonePath: string }]>(
    rt.request('/v1/repositories'),
  );
  await skipPlanApproval(rt, repo.projectId, config);
  return { rt, repo };
}

async function startJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Add sum() to math.ts' });
  expect(res.status).toBe(201);
  return waitForJob(rt, ((await res.json()) as JobBody).id, settled, 40_000);
}

const attempts = (rt: RunningRuntime, jobId: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
const tasks = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
const inbox = (rt: RunningRuntime) => json<ItemBody[]>(rt.request('/v1/inbox'));
const item = (rt: RunningRuntime, id: string) => json<ItemBody>(rt.request(`/v1/inbox/${id}`));
const audit = (rt: RunningRuntime, jobId: string) =>
  json<AuditBody[]>(rt.request(`/v1/jobs/${jobId}/audit`));
const events = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));

/** The one open Inbox Item, a Blocker Approval. */
async function onlyBlocker(rt: RunningRuntime): Promise<ItemBody> {
  const items = await inbox(rt);
  expect(items.map((i) => i.kind)).toEqual(['blocker']);
  return items[0] as ItemBody;
}

const decide = (rt: RunningRuntime, it: ItemBody, body: Record<string, unknown>) =>
  post(rt, `/v1/inbox/${it.id}/decide`, {
    expectedVersion: it.version,
    subjectRef: it.subjectRef,
    ...body,
  });

describe('a Rework cap is a Blocker Approval, and a grant continues the Task', () => {
  it('B5: Rework capped at 3 waits for a human with every Attempt kept; a grant of +1 with guidance continues it to completion', async () => {
    const { rt, repo } = await runtimeWith(
      [
        touchingPackageJson('{ "name": "one" }\n'),
        touchingOnlyPackageJson('{ "name": "two" }\n'),
        touchingOnlyPackageJson('{ "name": "three" }\n'),
        restoringPackageJson(),
      ],
      { maxAttempts: 3 },
    );
    const job = await startJob(rt, repo.id);

    // Capped: waiting_human, never failed, and every Attempt is kept and visible.
    expect(job.status).toBe('waiting_human');
    const capped = await attempts(rt, job.id);
    expect(capped.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'failed', 'gates_failed'],
      [2, 'rework', 'failed', 'gates_failed'],
      [3, 'rework', 'failed', 'gates_failed'],
    ]);
    for (const a of capped) {
      expect(a.findings.map((f) => f.rule)).toContain('scope.forbidden');
      // Its head stays reachable in the Factory Clone, pinned per Attempt.
      expect(git(repo.clonePath, ['rev-parse', `refs/factory/attempts/${a.id}`]).trim()).toBe(
        a.headSha,
      );
    }
    const [worktree] = await json<{ state: string }[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(worktree?.state).toBe('preserved');
    const [task] = await tasks(rt, job.id);
    expect(task).toMatchObject({
      state: 'blocked',
      maxAttempts: 3,
      blocker: { kind: 'human', reason: 'rework_cap_reached', attemptId: capped[2]?.id },
    });

    // The Blocker opened one Approval, in the same transaction, with the fixed options.
    const blocker = await onlyBlocker(rt);
    expect(blocker).toMatchObject({
      jobId: job.id,
      taskId: task?.id,
      stageId: 'execution',
      subjectRef: capped[2]?.id,
      state: 'open',
      question: 'Task add-sum reached its Rework cap',
    });
    expect(blocker.options.map((o) => [o.id, o.agentProposed])).toEqual([
      ['grant', false],
      ['cancel_job', false],
    ]);
    const blockedEvent = (await events(rt, job.id)).find(
      (e) => e.type === 'task.blocked' && e.payload['reason'] === 'rework_cap_reached',
    );
    const opened = (await events(rt, job.id)).find(
      (e) => e.type === 'approval.opened' && e.entityId === blocker.id,
    );
    expect(opened?.seq).toBe((blockedEvent?.seq ?? 0) + 1);

    // A grant is +1 to +5, and only on the grant option; a stale version is refused.
    const tooBig = await decide(rt, blocker, { option: 'grant', grant: 6 });
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as { error: string }).error).toBe('invalid_grant');
    const sizedCancel = await decide(rt, blocker, { option: 'cancel_job', grant: 1 });
    expect(sizedCancel.status).toBe(400);
    const stale = await post(rt, `/v1/inbox/${blocker.id}/decide`, {
      expectedVersion: blocker.version + 1,
      subjectRef: blocker.subjectRef,
      option: 'grant',
    });
    expect(stale.status).toBe(409);
    expect(await item(rt, blocker.id)).toMatchObject({ state: 'open', version: blocker.version });

    // The CLI grant: +1 with guidance.
    const res = await rt.home.cli([
      'inbox',
      'decide',
      blocker.id,
      'grant',
      '--grant',
      '1',
      '--expect-version',
      String(blocker.version),
      '--comment',
      'Leave package.json exactly as it is on main.',
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(await item(rt, blocker.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: {
        option: 'grant',
        grant: 1,
        comment: 'Leave package.json exactly as it is on main.',
      },
    });

    const done = await waitForJob(rt, job.id, settled, 40_000);
    expect(done.status).toBe('completed');
    const all = await attempts(rt, job.id);
    expect(all.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'initial', 'failed'],
      [2, 'rework', 'failed'],
      [3, 'rework', 'failed'],
      [4, 'rework', 'passed'],
    ]);
    // The guidance went into the next Attempt's context, beside the Findings to fix.
    expect(all[3]?.packet.context.guidance).toEqual([
      {
        attemptN: 3,
        about: 'Task add-sum reached its Rework cap',
        text: 'Leave package.json exactly as it is on main.',
        decidedBy: 'user:local',
        approvalId: blocker.id,
      },
    ]);
    expect(all[3]?.packet.context.priorFindings.length).toBeGreaterThan(0);
    expect((await tasks(rt, job.id))[0]?.maxAttempts).toBe(4);
    // The cap raise is audited, decided by user:local.
    expect(await audit(rt, job.id)).toEqual([
      {
        id: expect.any(String) as string,
        ts: expect.any(String) as string,
        actor: 'user:local',
        action: 'cap.raised',
        target: `task:${String(task?.id)}`,
        before: { maxAttempts: 3 },
        after: { maxAttempts: 4 },
        policyRef: `inbox:${blocker.id}/grant`,
        correlationId: blocker.id,
      },
    ]);
  });

  it('"cancel the Job" from a Blocker Approval runs the cancel operation', async () => {
    const { rt, repo } = await runtimeWith([touchingPackageJson('{ "name": "one" }\n')], {
      maxAttempts: 1,
    });
    const job = await startJob(rt, repo.id);
    expect(job.status).toBe('waiting_human');
    const blocker = await onlyBlocker(rt);

    const res = await decide(rt, blocker, { option: 'cancel_job', comment: 'Not worth it.' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await item(rt, blocker.id)).toMatchObject({
      state: 'decided',
      decision: { option: 'cancel_job', comment: 'Not worth it.' },
    });
    const after = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(after.status).toBe('cancelled');
    expect((await tasks(rt, job.id))[0]?.state).toBe('cancelled');
    const cancelled = (await events(rt, job.id)).find((e) => e.type === 'job.cancelled');
    expect(cancelled?.payload).toMatchObject({ reason: `cancelled from Inbox item ${blocker.id}` });
    expect(await audit(rt, job.id)).toEqual([]);
  });
});

describe('a question cap is a Blocker Approval', () => {
  it('a grant raises maxQuestions and reopens the capped Attempt’s Question; its answer continues the Task', async () => {
    const { rt, repo } = await runtimeWith(
      [asks('// one\n'), asks('// two\n'), validTaskResponse()],
      { maxQuestions: 1 },
    );
    const job = await startJob(rt, repo.id);
    const [question] = await inbox(rt);
    expect(question?.kind).toBe('question');
    const answered = await post(rt, `/v1/inbox/${String(question?.id)}/answer`, {
      expectedVersion: question?.version,
      subjectRef: question?.subjectRef,
      answers: [{ questionId: 'q1', option: 'exact' }],
    });
    expect(answered.status).toBe(200);
    const capped = await waitForJob(rt, job.id, settled, 30_000);
    expect(capped.status).toBe('waiting_human');
    const [, second] = await attempts(rt, job.id);
    const blocker = await onlyBlocker(rt);
    expect(blocker).toMatchObject({
      subjectRef: second?.id,
      question: 'Task add-sum reached its question cap',
    });
    expect(blocker.options.map((o) => o.id)).toEqual(['grant', 'cancel_job']);

    const res = await decide(rt, blocker, { option: 'grant', grant: 2, comment: 'Keep it exact.' });
    expect(res.status, await res.clone().text()).toBe(200);
    // The capped Attempt's Question is open again, and the Task waits for its answer.
    const [reopened] = await inbox(rt);
    expect(reopened).toMatchObject({ kind: 'question', subjectRef: second?.id, state: 'open' });
    const [task] = await tasks(rt, job.id);
    expect(task).toMatchObject({
      state: 'blocked',
      maxQuestions: 3,
      blocker: { reason: 'awaiting_human', attemptId: second?.id },
    });
    const capJob = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(capJob.stageRuns.find((s) => s.stageId === 'execution')).toMatchObject({
      state: 'waiting_human',
      blocker: { reason: 'awaiting_human' },
    });
    expect((await audit(rt, job.id)).map((a) => [a.actor, a.before, a.after])).toEqual([
      ['user:local', { maxQuestions: 1 }, { maxQuestions: 3 }],
    ]);

    const again = await post(rt, `/v1/inbox/${String(reopened?.id)}/answer`, {
      expectedVersion: reopened?.version,
      subjectRef: reopened?.subjectRef,
      answers: [{ questionId: 'q1', option: 'exact' }],
    });
    expect(again.status).toBe(200);
    const done = await waitForJob(rt, job.id, settled, 30_000);
    expect(done.status).toBe('completed');
    const third = (await attempts(rt, job.id))[2];
    expect(third).toMatchObject({ n: 3, cause: 'answer', state: 'passed' });
    expect(third?.packet.context.guidance.map((g) => g.text)).toEqual(['Keep it exact.']);
  });
});

describe('"retry now" never starts a second process', () => {
  /** A developer Run that does nothing and hangs: its lease is what ends it. */
  const hung = () => ({ ...validTaskResponse(), steps: [], delayMs: 120_000 });

  async function frozenRuntime(script: string, ttlMs: number) {
    const home = await initializedHome();
    useFakeHarness(home, script);
    const rt = await startRuntime(home, {
      env: { FACTORY_TEST_FREEZE_HEARTBEAT: '1', FACTORY_TEST_LEASE_TTL_MS: String(ttlMs) },
    });
    killGroupsOnFinish(rt);
    return rt;
  }

  async function developerStarts(rt: RunningRuntime, jobId: string) {
    return (await events(rt, jobId)).filter(
      (e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer',
    );
  }

  it('recovery_uncertain: refused while the process can’t be checked, then offers kill and retry while it is alive, then retries', async () => {
    const rt = await frozenRuntime(scriptWith({}, { 'add-sum': [hung(), hung()] }), 4_000);
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);
    let started: EventBody | undefined;
    await waitFor(
      async () => {
        started = (await developerStarts(rt, job.id))[0];
        return started !== undefined;
      },
      20_000,
      'the developer Run',
    );
    const attemptId = String(started?.payload['attemptId']);
    const pid = started?.payload['pid'] as number;
    const pidFile = join(rt.home.dir, 'run', attemptId, 'developer-1', 'pid');
    await waitFor(() => existsSync(pidFile), 5_000, 'the spooled pid');
    const pidText = readFileSync(pidFile, 'utf8');
    rmSync(pidFile);

    const stopped = await waitForJob(rt, job.id, settled, 30_000);
    expect(stopped.status, rt.output()).toBe('blocked');
    const blocker = await onlyBlocker(rt);
    expect(blocker).toMatchObject({ subjectRef: attemptId, requestedBy: 'system:sweeper' });
    expect(blocker.options.map((o) => o.id)).toEqual(['retry_now', 'cancel_job']);

    // No readable pid: nothing proves the process gone, so no Retry.
    const unconfirmed = await decide(rt, blocker, { option: 'retry_now' });
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { error: string }).error).toBe('process_unconfirmed');
    expect(groupAlive(pid)).toBe(true);

    // The pid is readable again and the process alive: "kill and retry" is offered instead.
    writeFileSync(pidFile, pidText);
    const alive = await decide(rt, blocker, { option: 'retry_now' });
    expect(alive.status).toBe(409);
    expect(((await alive.json()) as { error: string }).error).toBe('process_alive');
    const offered = await item(rt, blocker.id);
    expect(offered).toMatchObject({ state: 'open', version: blocker.version + 1 });
    expect(offered.options.map((o) => o.id)).toEqual(['kill_and_retry', 'cancel_job']);
    expect(groupAlive(pid), 'retry now never signals a process').toBe(true);
    expect(await developerStarts(rt, job.id)).toHaveLength(1);

    const killed = await decide(rt, offered, { option: 'kill_and_retry' });
    expect(killed.status, await killed.clone().text()).toBe(200);
    expect(groupAlive(pid)).toBe(false);
    await waitFor(
      async () => (await developerStarts(rt, job.id)).length === 2,
      20_000,
      'the Retry',
    );
    const all = await attempts(rt, job.id);
    expect(all.slice(0, 2).map((a) => [a.n, a.cause])).toEqual([
      [1, 'initial'],
      [2, 'retry'],
    ]);
    // One Harness start per Attempt id, and nothing but the Retry's process running.
    const starts = (await developerStarts(rt, job.id)).map((e) => e.payload['attemptId']);
    expect(new Set(starts).size).toBe(starts.length);
    expect(factoryGroups(rt.home.dir).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('retry_cap_reached: retry now raises maxRetries by one (audited) and starts the Retry', async () => {
    const rt = await frozenRuntime(scriptWith({}, { 'add-sum': [hung(), hung(), hung()] }), 1_500);
    const repo = await registeredRepo(rt);
    const config = phaseAConfig({ maxRetries: 0 });
    expect((await post(rt, `/v1/projects/${repo.projectId}/config`, config)).status).toBe(200);
    const job = await createJob(rt, repo.id);
    const stopped = await waitForJob(rt, job.id, settled, 30_000);
    expect(stopped.status, rt.output()).toBe('blocked');
    const [task] = await tasks(rt, job.id);
    expect(task?.blocker?.reason).toBe('retry_cap_reached');
    const blocker = await onlyBlocker(rt);

    const res = await decide(rt, blocker, { option: 'retry_now' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await audit(rt, job.id)).map((a) => [a.before, a.after, a.policyRef])).toEqual([
      [{ maxRetries: 0 }, { maxRetries: 1 }, `inbox:${blocker.id}/retry_now`],
    ]);
    await waitFor(
      async () => (await attempts(rt, job.id)).some((a) => a.cause === 'retry'),
      20_000,
      'the Retry',
    );
    expect((await tasks(rt, job.id))[0]?.maxRetries).toBe(1);
  }, 60_000);
});

describe('the dashboard decides a Blocker Approval', () => {
  it('shows the options and a grant size, and grants as user:local', async () => {
    const { rt, repo } = await runtimeWith(
      [touchingPackageJson('{ "name": "one" }\n'), restoringPackageJson()],
      { maxAttempts: 1 },
    );
    const job = await startJob(rt, repo.id);
    const blocker = await onlyBlocker(rt);
    const dash = await startDashboard(rt.home);

    const html = await dash.html(`/inbox/${blocker.id}`);
    expect(html).toContain('Task add-sum reached its Rework cap');
    const form = /<form\b[^>]*action="\/api\/inbox\/[^"]+\/decide"[\s\S]*?<\/form>/.exec(html)?.[0];
    expect(form).toBeDefined();
    expect(form).toContain('name="grant"');
    expect(form).toContain('max="5"');
    expect(form).toMatch(/<button[^>]*value="grant"[^>]*name="option"/);
    expect(form).toMatch(/<button[^>]*value="cancel_job"[^>]*name="option"/);

    // An oversized grant is refused with the runtime's message.
    const big = await dash.postForm(`/api/inbox/${blocker.id}/decide`, {
      expectedVersion: String(blocker.version),
      subjectRef: blocker.subjectRef,
      option: 'grant',
      grant: '9',
    });
    expect(big.status).toBe(400);

    const res = await dash.postForm(`/api/inbox/${blocker.id}/decide`, {
      expectedVersion: String(blocker.version),
      subjectRef: blocker.subjectRef,
      option: 'grant',
      grant: '2',
      comment: 'Restore package.json.',
    });
    expect(res.status, res.body).toBe(303);
    expect(await item(rt, blocker.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'grant', grant: 2, comment: 'Restore package.json.' },
    });
    const done = await waitForJob(rt, job.id, settled, 40_000);
    expect(done.status).toBe('completed');
    expect((await tasks(rt, job.id))[0]?.maxAttempts).toBe(3);
    const page = await dash.html(`/inbox/${blocker.id}`);
    expect(page).toContain('Grant more Attempts');
    expect(page).toContain('+2');
  });
});
