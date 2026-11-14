/**
 * The Requested Replan and carry-over (#45, ARCHITECTURE §4.7, ADR-0029). The
 * operator asks for a Replan during execution (`factory job replan
 * --feedback`): nothing new is dispatched, planning starts only once every
 * Attempt in flight has settled, and the new Plan keeps the work it doesn't
 * change. Inbox options ("replan" on a cap Blocker or a scope change
 * Question) start the same Replan; at `maxReplans` a `replan_cap_reached`
 * Blocker Approval holds the request. Asserted through the API and the CLI.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  tempDir,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  json,
  jobSettled,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface TaskBody {
  id: string;
  key: string;
  title: string;
  state: string;
  planArtifactId: string;
  blocker: { reason: string } | null;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  subjectRef: string;
  state: string;
  version: number;
  options: { id: string }[];
  decision: { option: string } | null;
}
interface ReplanJobBody extends JobBody {
  replanRequested: boolean;
  replans: { used: number; max: number };
}
interface WorktreeBody {
  taskId: string;
  branch: string;
  state: string;
}

/** A Plan Task writing one file, `docs/<key>.md`. */
function docTask(key: string, dependsOn: string[] = [], title = `Write docs/${key}.md`) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title,
    scope: { writable: [`docs/${key}.md`], forbidden: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: `test -f docs/${key}.md`, criteria: ['AC-01'] }],
  };
}

/** A `run` step that waits (at most 30 s) until the test creates `file`. */
const waitFor = (file: string) =>
  `i=0; while [ ! -f '${file}' ]; do i=$((i+1)); if [ $i -gt 300 ]; then exit 1; fi; sleep 0.1; done`;

/** The developer's response for `key`: optional `run` steps, then the file, committed. */
function docRun(key: string, before: string[] = []) {
  return {
    steps: [
      ...before.map((run) => ({ run })),
      { write: { path: `docs/${key}.md`, content: `# ${key}\n` } },
      { commit: `Write docs/${key}.md` },
    ],
    result: {
      status: 'done',
      summary: `Wrote docs/${key}.md.`,
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the file exists' }],
    },
  };
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'The file is there.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
  },
};

async function runtimeWith(script: string, opts: { planApproval?: 'required' | 'skip' } = {}) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt, { planApproval: opts.planApproval ?? 'required' });
  return { rt, repo };
}

async function setConfig(rt: RunningRuntime, projectId: string, config: Record<string, unknown>) {
  const res = await post(rt, `/v1/projects/${projectId}/config`, config);
  expect(res.status, 'set the Project config').toBe(200);
}

async function createJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Write the docs' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const jobOf = (rt: RunningRuntime, id: string) => json<ReplanJobBody>(rt.request(`/v1/jobs/${id}`));
const tasksOf = (rt: RunningRuntime, id: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${id}/tasks`));
const eventsOf = (rt: RunningRuntime, id: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${id}/events`));
const openItems = (rt: RunningRuntime) => json<ItemBody[]>(rt.request('/v1/inbox'));

/** Polls `read` until `done` holds (at most 30 s). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}; last seen ${JSON.stringify(last)}`);
}

/** Waits for the Job's open plan item and approves it; returns the approved Plan's id. */
async function approveOpenPlan(rt: RunningRuntime, jobId: string, n: number): Promise<string> {
  const item = await until(
    async () => (await openItems(rt)).find((i) => i.kind === 'plan'),
    (i) => i !== undefined,
    `plan item #${String(n)}`,
  );
  if (item === undefined) throw new Error('unreachable');
  const res = await post(rt, `/v1/jobs/${jobId}/plan/approve`, {
    expectedVersion: item.version,
    planArtifactId: item.subjectRef,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return item.subjectRef;
}

const byKey = (tasks: TaskBody[], key: string) => tasks.filter((t) => t.key === key);

describe('requested Replan', () => {
  it('waits for the Attempts in flight, dispatches nothing new, then carries the unaffected work over', async () => {
    const gate = tempDir('replan-gate-');
    const firstPlan = { tasks: [docTask('a'), docTask('b'), docTask('c', ['a'])] };
    // b's definition changes; a and c (and c's chain, a) are identical.
    const secondPlan = {
      tasks: [docTask('a'), docTask('b', [], 'Write docs/b.md, again'), docTask('c', ['a'])],
    };
    const script = scriptWith(
      { planning: [{ output: firstPlan }, { output: secondPlan }] },
      {
        a: [docRun('a', [waitFor(join(gate, 'a'))])],
        b: [docRun('b', [waitFor(join(gate, 'b'))]), docRun('b')],
        c: [docRun('c')],
      },
      { a: [APPROVE], b: [APPROVE, APPROVE], c: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    const job = await createJob(rt, repo.id);
    const plan1 = await approveOpenPlan(rt, job.id, 1);

    // a and b are in flight (each waits on its gate).
    await until(
      () => tasksOf(rt, job.id),
      (ts) => ['a', 'b'].every((k) => byKey(ts, k)[0]?.state === 'running'),
      'a and b running',
    );
    const before = await tasksOf(rt, job.id);
    const feedback = 'Write docs/b.md again, with a better title.';
    const asked = await rt.home.cli(['job', 'replan', job.id, '--feedback', feedback]);
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.stdout).toContain('Replan requested');

    const waiting = await jobOf(rt, job.id);
    expect(waiting).toMatchObject({ replanRequested: true, replans: { used: 1, max: 2 } });
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain('replan requested');

    // a ends: c is ready, but nothing new is dispatched while the Replan waits.
    writeFileSync(join(gate, 'a'), '');
    await until(
      () => tasksOf(rt, job.id),
      (ts) => byKey(ts, 'c')[0]?.state === 'ready' && byKey(ts, 'a')[0]?.state === 'approved',
      'a approved, c ready',
    );
    await new Promise((r) => setTimeout(r, 1_500));
    const held = await tasksOf(rt, job.id);
    expect(byKey(held, 'c')[0]?.state).toBe('ready');
    expect(
      (await jobOf(rt, job.id)).stageRuns.filter((s) => s.stageId === 'planning'),
    ).toHaveLength(1);

    // b ends: no Attempt is in flight, so planning starts, from the request.
    writeFileSync(join(gate, 'b'), '');
    const plan2 = await approveOpenPlan(rt, job.id, 2);
    expect(plan2).not.toBe(plan1);
    const replanned = await jobOf(rt, job.id);
    expect(replanned.replanRequested).toBe(false);
    expect(replanned.stageRuns.map((s) => [s.stageId, s.state]).slice(4)).toEqual([
      ['planning', 'succeeded'],
      ['planning', 'succeeded'],
      ['plan_approval', 'succeeded'],
      ['plan_approval', 'succeeded'],
      ['execution', 'superseded'],
      ['execution', expect.stringMatching(/queued|running|succeeded/)],
      ['closure', expect.any(String)],
    ]);

    // The cancelled b's Worktree is preserved until closure (its branch is kept after).
    const oldBId = byKey(before, 'b')[0]?.id;
    const kept = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(kept.find((w) => w.taskId === oldBId)?.state).toBe('preserved');

    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');

    // Carry-over: a and c keep their ids (a its approval, c its place); b's approved run
    // changed, so it is cancelled with its head on record and re-run as a new Task.
    const tasks = await tasksOf(rt, job.id);
    const id = (key: string) => byKey(before, key)[0]?.id;
    expect(byKey(tasks, 'a').map((t) => [t.id, t.state, t.planArtifactId])).toEqual([
      [id('a'), 'approved', plan2],
    ]);
    expect(byKey(tasks, 'c').map((t) => [t.id, t.state])).toEqual([[id('c'), 'approved']]);
    const [oldB, newB] = byKey(tasks, 'b');
    expect([oldB?.id, oldB?.state, oldB?.planArtifactId]).toEqual([id('b'), 'cancelled', plan1]);
    expect(newB).toMatchObject({ state: 'approved', title: 'Write docs/b.md, again' });
    expect(newB?.id).not.toBe(id('b'));
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const oldTree = worktrees.find((w) => w.taskId === oldB?.id);
    const newTree = worktrees.find((w) => w.taskId === newB?.id);
    expect(newTree?.branch).not.toBe(oldTree?.branch);

    const events = await eventsOf(rt, job.id);
    const seq = (pred: (e: EventBody) => boolean) => events.find(pred)?.seq ?? Number.NaN;
    expect(events.find((e) => e.type === 'job.replan_requested')).toMatchObject({
      actor: 'user:local',
      payload: { feedback, replansUsed: 1, maxReplans: 2 },
    });
    // c was claimed only after the new Plan was approved; a ran once.
    const cClaimed = seq((e) => e.entityId === id('c') && e.type === 'task.claimed');
    const approved2 = seq(
      (e) => e.type === 'approval.decided' && e.payload['subjectRef'] === plan2,
    );
    expect(cClaimed).toBeGreaterThan(approved2);
    expect(events.filter((e) => e.entityId === id('a') && e.type === 'task.claimed')).toHaveLength(
      1,
    );
    // Planning started only once b's Attempt had settled, with the current Plan and the feedback.
    const bApproved = seq((e) => e.entityId === id('b') && e.type === 'task.approved');
    const runs = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect(runs).toHaveLength(2);
    expect(runs[1]?.seq).toBeGreaterThan(bApproved);
    expect(runs[1]?.payload['replan']).toEqual({ planArtifactId: plan1, feedback });
    expect(
      events.find((e) => e.type === 'task.carried_over' && e.entityId === id('a')),
    ).toMatchObject({ payload: { planArtifactId: plan2, from: 'approved', to: 'approved' } });
  });

  it('settles a needs_decision in the window as blocked; a carried-over Task keeps its open Question', async () => {
    const gate = tempDir('replan-gate-');
    const firstPlan = { tasks: [docTask('a')] };
    const secondPlan = { tasks: [docTask('a'), docTask('d')] };
    const asks = {
      steps: [{ run: waitFor(join(gate, 'a')) }],
      result: {
        status: 'needs_decision',
        summary: 'Which heading?',
        commits: [],
        criteria: [],
        questions: [{ text: 'Use an H1 heading?', options: ['yes', 'no'], blocking: true }],
      },
    };
    const script = scriptWith(
      { planning: [{ output: firstPlan }, { output: secondPlan }] },
      { a: [asks, docRun('a')], d: [docRun('d')] },
      { a: [APPROVE], d: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    const job = await createJob(rt, repo.id);
    await approveOpenPlan(rt, job.id, 1);
    await until(
      () => tasksOf(rt, job.id),
      (ts) => ts[0]?.state === 'running',
      'a running',
    );
    const res = await post(rt, `/v1/jobs/${job.id}/replan`, {
      expectedVersion: (await jobOf(rt, job.id)).version,
      feedback: 'Also write docs/d.md.',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ replanRequested: true });

    writeFileSync(join(gate, 'a'), '');
    const plan2 = await approveOpenPlan(rt, job.id, 2);
    const question = (await openItems(rt)).find((i) => i.kind === 'question');
    const [a] = await tasksOf(rt, job.id);
    expect(a).toMatchObject({
      state: 'blocked',
      planArtifactId: plan2,
      blocker: { reason: 'awaiting_human' },
    });
    expect(question).toMatchObject({ taskId: a?.id, state: 'open' });

    // d runs under the new Plan; a waits for its answer, then finishes.
    await until(
      () => tasksOf(rt, job.id),
      (ts) => byKey(ts, 'd')[0]?.state === 'approved',
      'd approved',
    );
    const answered = await post(rt, `/v1/inbox/${question?.id ?? ''}/answer`, {
      expectedVersion: question?.version,
      subjectRef: question?.subjectRef,
      answers: [{ questionId: 'q1', option: 'yes' }],
    });
    expect(answered.status, await answered.clone().text()).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
  });

  it('is refused outside execution and while one is already requested', async () => {
    const gate = tempDir('replan-gate-');
    const script = scriptWith(
      { planning: [{ output: { tasks: [docTask('a')] } }] },
      { a: [docRun('a', [waitFor(join(gate, 'a'))])] },
      { a: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    const job = await createJob(rt, repo.id);
    await until(
      async () => (await openItems(rt)).length,
      (n) => n === 1,
      'the plan item',
    );
    const early = await post(rt, `/v1/jobs/${job.id}/replan`, {
      expectedVersion: (await jobOf(rt, job.id)).version,
      feedback: 'too early',
    });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: 'not_executing' });

    await approveOpenPlan(rt, job.id, 1);
    await until(
      () => tasksOf(rt, job.id),
      (ts) => ts[0]?.state === 'running',
      'a running',
    );
    const first = await rt.home.cli(['job', 'replan', job.id, '--feedback', 'once']);
    expect(first.code, first.stderr).toBe(0);
    const again = await rt.home.cli(['job', 'replan', job.id, '--feedback', 'twice']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('replan_already_requested');
    writeFileSync(join(gate, 'a'), '');
  });
});

describe('the Replan cap', () => {
  it('at maxReplans opens a replan_cap_reached Approval; +1 replan starts it, and cancel still works during the wait', async () => {
    const gate = tempDir('replan-gate-');
    const script = scriptWith(
      { planning: [{ output: { tasks: [docTask('a')] } }] },
      { a: [docRun('a', [waitFor(join(gate, 'a'))])] },
      { a: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    await setConfig(rt, repo.projectId, { planApproval: 'skip', maxReplans: 0 });
    const job = await createJob(rt, repo.id);
    await until(
      () => tasksOf(rt, job.id),
      (ts) => ts[0]?.state === 'running',
      'a running',
    );

    const capped = await rt.home.cli(['job', 'replan', job.id, '--feedback', 'split it']);
    expect(capped.code, capped.stderr).toBe(0);
    expect(capped.stdout).toContain('maxReplans');
    expect((await jobOf(rt, job.id)).replanRequested).toBe(false);
    const [item] = await openItems(rt);
    expect(item).toMatchObject({ kind: 'blocker', taskId: null, state: 'open' });
    expect(item?.options.map((o) => o.id)).toEqual(['grant_replan', 'cancel_job']);

    const granted = await rt.home.cli([
      'inbox',
      'decide',
      item?.id ?? '',
      'grant_replan',
      '--expect-version',
      String(item?.version),
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    expect(await jobOf(rt, job.id)).toMatchObject({
      replanRequested: true,
      replans: { used: 1, max: 1 },
    });
    const audit = await json<{ action: string; before: unknown; after: unknown }[]>(
      rt.request(`/v1/jobs/${job.id}/audit`),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'cap.raised',
        before: { maxReplans: 0 },
        after: { maxReplans: 1 },
      }),
    ]);

    // Cancelling the Job during the wait stops the Attempt; planning never starts.
    const cancel = await rt.home.cli(['job', 'cancel', job.id]);
    expect(cancel.code, cancel.stderr).toBe(0);
    const cancelled = await waitForJob(rt, job.id, jobSettled, 20_000);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stageRuns.filter((s) => s.stageId === 'planning')).toHaveLength(1);
    expect((await tasksOf(rt, job.id)).map((t) => t.state)).toEqual(['cancelled']);
  });
});

describe('the Inbox "replan" options', () => {
  it('a Rework cap Blocker replans with its comment; the blocked Task is cancelled and re-planned as a new Task', async () => {
    const failing = {
      steps: [{ write: { path: 'docs/other.md', content: 'x\n' } }, { commit: 'Wrong file' }],
      result: { status: 'done', summary: 'Done.', commits: [], criteria: [] },
    };
    const script = scriptWith(
      { planning: [{ output: { tasks: [docTask('a')] } }, { output: { tasks: [docTask('a')] } }] },
      { a: [failing, docRun('a')] },
      { a: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script, { planApproval: 'skip' });
    await setConfig(rt, repo.projectId, { planApproval: 'skip', maxAttempts: 1 });
    const job = await createJob(rt, repo.id);
    const blocker = await until(
      async () => (await openItems(rt)).find((i) => i.kind === 'blocker'),
      (i) => i !== undefined,
      'the Rework cap Blocker',
    );
    expect(blocker?.options.map((o) => o.id)).toEqual(['grant', 'replan', 'cancel_job']);
    const [capped] = await tasksOf(rt, job.id);

    const res = await post(rt, `/v1/inbox/${blocker?.id ?? ''}/decide`, {
      expectedVersion: blocker?.version,
      subjectRef: blocker?.subjectRef,
      option: 'replan',
      comment: 'Write docs/a.md, not docs/other.md.',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'decided', decision: { option: 'replan' } });

    const done = await waitForJob(
      rt,
      job.id,
      (j) => j.status === 'completed' || j.status === 'failed',
      30_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.id === capped?.id, t.state])).toEqual([
      [true, 'cancelled'],
      [false, 'approved'],
    ]);
    const events = await eventsOf(rt, job.id);
    const runs = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect((runs[1]?.payload['replan'] as { feedback: string } | undefined)?.feedback).toContain(
      'Write docs/a.md, not docs/other.md.',
    );
  });

  it('a scope change Question offers "replan with this request as feedback"', async () => {
    const scopeAsk = {
      steps: [],
      result: {
        status: 'needs_decision',
        summary: 'I need package.json.',
        commits: [],
        criteria: [],
        scopeChangeRequest: { paths: ['package.json'], reason: 'add a test script' },
      },
    };
    const script = scriptWith(
      { planning: [{ output: { tasks: [docTask('a')] } }, { output: { tasks: [docTask('a')] } }] },
      { a: [scopeAsk, docRun('a')] },
      { a: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script, { planApproval: 'skip' });
    const job = await createJob(rt, repo.id);
    const question = await until(
      async () => (await openItems(rt)).find((i) => i.kind === 'question'),
      (i) => i !== undefined,
      'the scope change Question',
    );
    expect(question?.options.map((o) => o.id)).toEqual(['answer', 'replan']);
    const res = await post(rt, `/v1/inbox/${question?.id ?? ''}/decide`, {
      expectedVersion: question?.version,
      subjectRef: question?.subjectRef,
      option: 'replan',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const done = await waitForJob(
      rt,
      job.id,
      (j) => j.status === 'completed' || j.status === 'failed',
      30_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const events = await eventsOf(rt, job.id);
    const replan = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    )[1]?.payload['replan'] as { feedback: string } | undefined;
    expect(replan?.feedback).toContain('package.json');
    expect(replan?.feedback).toContain('add a test script');
  });
});
