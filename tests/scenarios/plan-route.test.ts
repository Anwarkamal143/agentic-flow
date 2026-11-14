/**
 * The `plan` Fault Origin route (#46, ARCHITECTURE §4.6, ROADMAP B4). A
 * blocking review Finding that blames the Plan cancels the raising Task and
 * its dependents at once (their Worktrees preserved), then asks for a Replan
 * like `requestReplan` does: planning waits for the Attempts in flight, the
 * new Plan is approved again, and the Job continues. Past `maxReplans` the
 * Job waits on a `replan_cap_reached` Blocker Approval. Asserted through the
 * API and the CLI.
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
  cancelReason: string | null;
  planArtifactId: string;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  subjectRef: string;
  state: string;
  version: number;
  options: { id: string }[];
}
interface RouteJobBody extends JobBody {
  replanRequested: boolean;
  replans: { used: number; max: number };
  stageRuns: (JobBody['stageRuns'][number] & { blocker?: { reason: string } | null })[];
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

const PROBLEM = 'docs/a.md and docs/b.md describe one thing; the Plan splits it in two.';

/** A review that requests changes with one blocking Finding blaming the Plan. */
const PLAN_FINDING = {
  output: {
    outcome: 'changes_requested',
    summary: 'The Plan is wrong.',
    findings: [
      {
        severity: 'high',
        faultOrigin: 'plan',
        location: 'docs/a.md',
        problem: PROBLEM,
        why: 'Two Tasks will write overlapping documents.',
        recommendation: 'Plan one Task for both.',
        blocking: true,
      },
    ],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
  },
};

async function runtimeWith(script: string) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt, { planApproval: 'required' });
  return { rt, repo };
}

async function createJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Write the docs' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const jobOf = (rt: RunningRuntime, id: string) => json<RouteJobBody>(rt.request(`/v1/jobs/${id}`));
const tasksOf = (rt: RunningRuntime, id: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${id}/tasks`));
const eventsOf = (rt: RunningRuntime, id: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${id}/events`));
const openItems = (rt: RunningRuntime) => json<ItemBody[]>(rt.request('/v1/inbox'));
const byKey = (tasks: TaskBody[], key: string) => tasks.filter((t) => t.key === key);

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

describe('the plan Fault Origin route', () => {
  it('B4: cancels the raising Task and its dependents, replans once nothing is in flight, re-approves and completes', async () => {
    const gate = tempDir('plan-route-gate-');
    // b depends on a; c is independent and still running when a's review blames the Plan.
    const firstPlan = { tasks: [docTask('a'), docTask('b', ['a']), docTask('c')] };
    const secondPlan = { tasks: [docTask('a', [], 'Write docs/a.md for both'), docTask('c')] };
    const script = scriptWith(
      { planning: [{ output: firstPlan }, { output: secondPlan }] },
      {
        a: [docRun('a'), docRun('a')],
        c: [docRun('c', [waitFor(join(gate, 'c'))])],
      },
      { a: [PLAN_FINDING, APPROVE], c: [APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    const job = await createJob(rt, repo.id);
    const plan1 = await approveOpenPlan(rt, job.id, 1);

    // a's review blames the Plan: a and its dependent b are cancelled straight away,
    // while c (in flight) runs on; planning waits for it.
    const cancelled = await until(
      () => tasksOf(rt, job.id),
      (ts) => ['a', 'b'].every((k) => byKey(ts, k)[0]?.state === 'cancelled'),
      'a and b cancelled',
    );
    const id = (key: string) => byKey(cancelled, key)[0]?.id;
    expect(byKey(cancelled, 'c')[0]?.state).toBe('running');
    // The Tasks API says why each was cancelled; the CLI shows it beside the state.
    expect(cancelled.map((t) => [t.key, t.cancelReason])).toEqual([
      ['a', 'replan'],
      ['b', 'replan'],
      ['c', null],
    ]);
    const shownTasks = await rt.home.cli(['job', 'show', job.id]);
    expect(shownTasks.stdout).toMatch(/^ {2}a +cancelled \(replan\) /m);
    expect(shownTasks.stdout).toMatch(/^ {2}c +running +Write docs\/c\.md/m);
    const waiting = await jobOf(rt, job.id);
    expect(waiting).toMatchObject({ replanRequested: true, replans: { used: 1, max: 2 } });
    // Planning waits for c: the Job is still active in execution.
    expect([waiting.status, waiting.currentStage]).toEqual(['active', 'execution']);
    expect(waiting.stageRuns.filter((s) => s.stageId === 'planning')).toHaveLength(1);
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const oldTree = worktrees.find((w) => w.taskId === id('a'));
    expect(oldTree?.state).toBe('preserved');
    expect(worktrees.find((w) => w.taskId === id('b'))).toBeUndefined();

    // One event per cancelled Task, in the transaction that ended a's Attempt.
    const early = await eventsOf(rt, job.id);
    const cancels = early.filter((e) => e.type === 'task.cancelled');
    expect(cancels.map((e) => [e.entityId, e.payload['cancelReason']])).toEqual([
      [id('a'), 'replan'],
      [id('b'), 'replan'],
    ]);
    const attemptEnd = early.find(
      (e) => e.type === 'attempt.failed' && e.payload['exitReason'] === 'changes_requested',
    );
    const asked = early.find((e) => e.type === 'job.replan_requested');
    // One transaction: the events from a's Attempt ending to the request are contiguous,
    // with nothing of c's in between.
    const from = attemptEnd?.seq ?? Number.NaN;
    const to = asked?.seq ?? Number.NaN;
    expect(cancels.every((e) => e.seq > from && e.seq < to)).toBe(true);
    const between = early.filter((e) => e.seq >= from && e.seq <= to);
    expect(between).toHaveLength(to - from + 1);
    expect(between.some((e) => e.entityId === id('c'))).toBe(false);
    expect(asked).toMatchObject({ actor: 'system:scheduler', payload: { replansUsed: 1 } });
    expect(String(asked?.payload['feedback'])).toContain(PROBLEM);

    // c ends: nothing is in flight, so planning runs with the Finding as feedback.
    writeFileSync(join(gate, 'c'), '');
    const replanned = await until(
      () => eventsOf(rt, job.id),
      (es) => es.some((e) => e.type === 'job.replanning'),
      'planning to start again',
    );
    // The Job returns to planning: in the transaction that starts it, execution is
    // superseded and a new planning Stage Run queued, so planning is the current Stage.
    const started = replanned.find((e) => e.type === 'job.replanning');
    const execRun = waiting.stageRuns.filter((s) => s.stageId === 'execution').at(-1);
    const moves = replanned.filter(
      (e) =>
        e.entityKind === 'stage_run' &&
        e.type !== 'stage_run.created' &&
        e.seq > (asked?.seq ?? Number.NaN) &&
        e.seq < (started?.seq ?? Number.NaN),
    );
    expect(moves.map((e) => [e.type, e.payload['stageId']])).toEqual([
      ['stage_run.superseded', 'execution'],
      ['stage_run.queued', 'planning'],
    ]);
    expect(moves[0]?.entityId).toBe(execRun?.id);
    // Planning ran again, so the Job now waits on the new Plan's approval.
    const awaiting = await until(
      () => jobOf(rt, job.id),
      (j) => j.currentStage === 'plan_approval',
      'the Job to wait on its new Plan',
    );
    expect(awaiting.status).toBe('waiting_human');
    expect(awaiting.stageRuns.filter((s) => s.stageId === 'planning').map((s) => s.state)).toEqual([
      'succeeded',
      'succeeded',
    ]);
    const plan2 = await approveOpenPlan(rt, job.id, 2);
    expect(plan2).not.toBe(plan1);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');

    // c carries over approved with its id; a is re-planned as a new Task on a new branch;
    // the old a keeps its branch on record.
    const tasks = await tasksOf(rt, job.id);
    expect(byKey(tasks, 'c').map((t) => [t.id, t.state, t.planArtifactId])).toEqual([
      [id('c'), 'approved', plan2],
    ]);
    const [oldA, newA] = byKey(tasks, 'a');
    expect([oldA?.id, oldA?.state]).toEqual([id('a'), 'cancelled']);
    expect(newA).toMatchObject({ state: 'approved', title: 'Write docs/a.md for both' });
    expect(byKey(tasks, 'b').map((t) => [t.id, t.state])).toEqual([[id('b'), 'cancelled']]);
    const after = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(after.find((w) => w.taskId === newA?.id)?.branch).not.toBe(oldTree?.branch);

    const events = await eventsOf(rt, job.id);
    const runs = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect(runs).toHaveLength(2);
    const replan = runs[1]?.payload['replan'] as { planArtifactId: string; feedback: string };
    expect(replan.planArtifactId).toBe(plan1);
    expect(replan.feedback).toContain(PROBLEM);
    const cApproved = events.find((e) => e.entityId === id('c') && e.type === 'task.approved');
    expect(runs[1]?.seq).toBeGreaterThan(cApproved?.seq ?? Number.NaN);
    const final = await jobOf(rt, job.id);
    expect(final.replans).toEqual({ used: 1, max: 2 });
  });

  it('B4: past maxReplans the Job waits on replan_cap_reached; +1 replan continues it', async () => {
    const script = scriptWith(
      {
        planning: [
          { output: { tasks: [docTask('a')] } },
          { output: { tasks: [docTask('a', [], 'Write docs/a.md, again')] } },
        ],
      },
      { a: [docRun('a'), docRun('a')] },
      { a: [PLAN_FINDING, APPROVE] },
    );
    const { rt, repo } = await runtimeWith(script);
    const config = await post(rt, `/v1/projects/${repo.projectId}/config`, {
      planApproval: 'skip',
      maxReplans: 0,
    });
    expect(config.status).toBe(200);
    const job = await createJob(rt, repo.id);

    const waiting = await waitForJob(rt, job.id, (j) => j.status === 'waiting_human', 30_000);
    expect(waiting.status, rt.output()).toBe('waiting_human');
    const shown = await jobOf(rt, job.id);
    expect(shown).toMatchObject({ replanRequested: false, replans: { used: 0, max: 0 } });
    const execution = shown.stageRuns.filter((s) => s.stageId === 'execution').at(-1);
    expect(execution).toMatchObject({
      state: 'waiting_human',
      blocker: { kind: 'human', reason: 'replan_cap_reached' },
    });
    const [first] = await tasksOf(rt, job.id);
    expect(first?.state).toBe('cancelled');
    const [item] = await openItems(rt);
    expect(item).toMatchObject({ kind: 'blocker', taskId: null, state: 'open' });
    expect(item?.options.map((o) => o.id)).toEqual(['grant_replan', 'cancel_job']);
    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toMatch(/replan_cap_reached/);

    // Nothing loops while it waits: one developer Run, one planning Run.
    await new Promise((r) => setTimeout(r, 1_500));
    const quiet = await eventsOf(rt, job.id);
    expect(
      quiet.filter((e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning'),
    ).toHaveLength(1);

    const granted = await rt.home.cli([
      'inbox',
      'decide',
      item?.id ?? '',
      'grant_replan',
      '--expect-version',
      String(item?.version),
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.key, t.state])).toEqual([
      ['a', 'cancelled'],
      ['a', 'approved'],
    ]);
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 1, max: 1 });
  });
});
