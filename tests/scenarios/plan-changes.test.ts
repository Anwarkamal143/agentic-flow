/**
 * Plan Edit and "request changes" at `plan_approval` (ARCHITECTURE §4.7,
 * PRODUCT_SPEC §4, §7, ADR-0019). An edit is the operator's whole replacement
 * Plan, checked by the planner's validator with no re-prompt; it supersedes the
 * plan Inbox Item and is not a Replan. Request changes is a Replan: the planner
 * runs again with the current Plan and the feedback, bounded by `maxReplans`.
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
  createJob,
  json,
  jobSettled,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface ItemBody {
  id: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  state: string;
  version: number;
  options: { id: string }[];
  decision: { option: string; comment: string | null } | null;
  decidedBy: string | null;
}

interface PlanViewBody {
  planArtifactId: string;
  planAuthoredBy: string;
  replans: { used: number; max: number };
  tasks: { key: string; title: string }[];
  approval: ItemBody | null;
}

interface TaskBody {
  key: string;
  title: string;
  state: string;
}

/** The planner's second Plan: the same Task, renamed as the feedback asks. */
function replannedPlan(): Record<string, unknown> {
  const plan = validOutput('planning') as { tasks: Record<string, unknown>[] };
  const [task] = plan.tasks;
  return { tasks: [{ ...task, title: 'Add the sum() helper (replanned)' }] };
}

/** Planning answers the first Plan, then the replanned one. */
const REPLAN_SCRIPT = scriptWith({
  planning: [{ output: validOutput('planning') }, { output: replannedPlan() }],
});

async function waitingForPlan(
  config: Record<string, unknown> = {},
): Promise<{ rt: RunningRuntime; job: JobBody; item: ItemBody }> {
  const home = await initializedHome();
  useFakeHarness(home, REPLAN_SCRIPT);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt, { planApproval: 'required' });
  if (Object.keys(config).length > 0) {
    const res = await post(rt, `/v1/projects/${repo.projectId}/config`, {
      planApproval: 'required',
      ...config,
    });
    expect(res.status, 'set the Project config').toBe(200);
  }
  const created = await createJob(rt, repo.id);
  const job = await waitForJob(rt, created.id, jobSettled, 20_000);
  expect(job.status).toBe('waiting_human');
  const [item] = await json<ItemBody[]>(rt.request('/v1/inbox'));
  if (item === undefined) throw new Error('no plan Inbox Item opened');
  return { rt, job, item };
}

const planView = (rt: RunningRuntime, jobId: string) =>
  json<PlanViewBody>(rt.request(`/v1/jobs/${jobId}/plan`));

const tasksOf = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));

const eventsOf = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));

/** Waits until the Job waits on a plan item other than `item`. */
async function nextPlanItem(rt: RunningRuntime, jobId: string, item: ItemBody): Promise<ItemBody> {
  const job = await waitForJob(
    rt,
    jobId,
    (j) => jobSettled(j) && j.stageRuns.filter((s) => s.stageId === 'planning').length === 2,
    20_000,
  );
  expect(job.status, JSON.stringify(job.stageRuns.map((s) => s.failure))).toBe('waiting_human');
  const open = await json<ItemBody[]>(rt.request('/v1/inbox'));
  expect(open).toHaveLength(1);
  const next = open[0] as ItemBody;
  expect(next.id).not.toBe(item.id);
  return next;
}

/** The Plan the operator edits: the current one, with the Task retitled. */
async function editedPlanFile(rt: RunningRuntime, jobId: string): Promise<string> {
  const raw = await rt.home.cli(['plan', 'show', jobId, '--raw']);
  expect(raw.code, raw.stderr).toBe(0);
  const plan = JSON.parse(raw.stdout) as { tasks: Record<string, unknown>[] };
  expect(plan.tasks.map((t) => t.key)).toEqual(['add-sum']);
  const [task] = plan.tasks;
  const file = join(tempDir('plan-edit-'), 'plan.json');
  writeFileSync(
    file,
    JSON.stringify({ tasks: [{ ...task, title: 'Add sum() (edited)', priority: 'high' }] }),
  );
  return file;
}

describe('Plan Edit', () => {
  it('a valid edit becomes a new plan Artifact by user:local and supersedes the item', async () => {
    const { rt, job, item } = await waitingForPlan();
    const file = await editedPlanFile(rt, job.id);

    const res = await rt.home.cli(['plan', 'edit', job.id, '--file', file]);
    expect(res.code, res.stderr + rt.output()).toBe(0);

    const view = await planView(rt, job.id);
    expect(view.planArtifactId).not.toBe(item.subjectRef);
    expect(view.planAuthoredBy).toBe('user:local');
    expect(view.tasks.map((t) => t.title)).toEqual(['Add sum() (edited)']);
    // An edit is not a Replan.
    expect(view.replans).toEqual({ used: 0, max: 2 });

    // The old item is kept, superseded; a new one decides the new Plan.
    expect(await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`))).toMatchObject({
      state: 'superseded',
      decision: null,
    });
    expect(view.approval).toMatchObject({
      state: 'open',
      version: 0,
      subjectRef: view.planArtifactId,
      stageId: 'plan_approval',
    });
    const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
    expect(all.map((i) => i.state)).toEqual(['superseded', 'open']);

    const events = await eventsOf(rt, job.id);
    const created = events.find(
      (e) => e.type === 'artifact.created' && e.entityId === view.planArtifactId,
    );
    expect(created).toMatchObject({ actor: 'user:local', payload: { kind: 'plan' } });
    expect(events.find((e) => e.type === 'approval.superseded')).toMatchObject({
      entityId: item.id,
      actor: 'user:local',
    });
    // No planner ran for the edit.
    expect(
      events.filter((e) => e.type === 'harness_run.started' && e.payload.stageId === 'planning'),
    ).toHaveLength(1);

    // The replaced Plan's Task never ran: it is cancelled; the new Plan's Task waits.
    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.title, t.state])).toEqual([
      ['Add sum() to math.ts', 'cancelled'],
      ['Add sum() (edited)', 'ready'],
    ]);
    const after = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(after.stageRuns.map((s) => [s.stageId, s.state]).slice(4)).toEqual([
      ['planning', 'succeeded'],
      ['plan_approval', 'waiting_human'],
      ['execution', 'pending'],
      ['closure', 'pending'],
    ]);

    // Approving the edited Plan runs it.
    const approve = await post(rt, `/v1/jobs/${job.id}/plan/approve`, {
      expectedVersion: 0,
      planArtifactId: view.planArtifactId,
    });
    expect(approve.status).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 20_000);
    expect(done.status).toBe('completed');
  });

  it('an invalid edit is refused with the validator errors, and nothing changes', async () => {
    const { rt, job, item } = await waitingForPlan();
    const before = await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    const plan = validOutput('planning') as { tasks: Record<string, unknown>[] };
    const [task] = plan.tasks;

    // maxAttempts may only narrow the configured cap (3).
    const res = await post(rt, `/v1/jobs/${job.id}/plan/edit`, {
      expectedVersion: 0,
      planArtifactId: item.subjectRef,
      plan: { tasks: [{ ...task, maxAttempts: 9 }] },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_plan');
    expect(body.message).toContain('plan.max_attempts_narrow');

    // A Plan that fails the schema is refused through the CLI too.
    const file = join(tempDir('plan-edit-'), 'plan.json');
    writeFileSync(file, JSON.stringify({ tasks: [] }));
    const cli = await rt.home.cli(['plan', 'edit', job.id, '--file', file]);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('invalid_plan');
    expect(cli.stderr).toContain('[schema]');

    expect(await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`))).toMatchObject({
      state: 'open',
      version: 0,
    });
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/artifacts`))).toEqual(before);
    // No re-prompt: the errors go back to the human, never to the planner.
    const events = await eventsOf(rt, job.id);
    expect(
      events.filter((e) => e.type === 'harness_run.started' && e.payload.stageId === 'planning'),
    ).toHaveLength(1);
    expect((await planView(rt, job.id)).replans).toEqual({ used: 0, max: 2 });
  });
});

describe('request changes', () => {
  it('re-runs planning with the current Plan and the feedback, then waits on the new Plan', async () => {
    const { rt, job, item } = await waitingForPlan();
    const feedback = 'Call the Task "Add the sum() helper".';

    const res = await post(rt, `/v1/jobs/${job.id}/plan/request-changes`, {
      expectedVersion: 0,
      planArtifactId: item.subjectRef,
      feedback,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: item.id,
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'request_changes', comment: feedback },
    });

    const next = await nextPlanItem(rt, job.id, item);
    expect(next.subjectRef).not.toBe(item.subjectRef);
    const view = await planView(rt, job.id);
    expect(view).toMatchObject({
      planArtifactId: next.subjectRef,
      planAuthoredBy: 'system:scheduler',
      replans: { used: 1, max: 2 },
    });
    expect(view.tasks.map((t) => t.title)).toEqual(['Add the sum() helper (replanned)']);

    const replanned = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(replanned.stageRuns.map((s) => [s.stageId, s.state]).slice(4)).toEqual([
      ['planning', 'succeeded'],
      ['planning', 'succeeded'],
      ['plan_approval', 'superseded'],
      ['plan_approval', 'waiting_human'],
      ['execution', 'pending'],
      ['closure', 'pending'],
    ]);

    // The planner was given the current Plan and the feedback.
    const events = await eventsOf(rt, job.id);
    const runs = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload.stageId === 'planning',
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]?.payload.replan).toBeUndefined();
    expect(runs[1]?.payload.replan).toEqual({ planArtifactId: item.subjectRef, feedback });
    expect(events.find((e) => e.type === 'job.replanned')).toMatchObject({
      actor: 'user:local',
      payload: { replansUsed: 1, maxReplans: 2, planArtifactId: item.subjectRef },
    });

    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.title, t.state])).toEqual([
      ['Add sum() to math.ts', 'cancelled'],
      ['Add the sum() helper (replanned)', 'ready'],
    ]);

    // The new Plan runs once approved.
    const approve = await rt.home.cli([
      'inbox',
      'decide',
      next.id,
      'approve',
      '--expect-version',
      String(next.version),
    ]);
    expect(approve.code, approve.stderr).toBe(0);
    const done = await waitForJob(rt, job.id, jobSettled, 20_000);
    expect(done.status).toBe('completed');
  });

  it('is refused at maxReplans, while edit, approve and reject remain', async () => {
    const { rt, job, item } = await waitingForPlan({ maxReplans: 1 });

    const first = await rt.home.cli([
      'plan',
      'request-changes',
      job.id,
      '--feedback',
      'rename the Task',
    ]);
    expect(first.code, first.stderr).toBe(0);
    const next = await nextPlanItem(rt, job.id, item);

    const capped = await rt.home.cli(['plan', 'request-changes', job.id, '--feedback', 'again']);
    expect(capped.code).toBe(1);
    expect(capped.stderr).toContain('replan_limit_reached');
    expect(capped.stderr).toContain('1 of 1');
    const viaInbox = await post(rt, `/v1/inbox/${next.id}/decide`, {
      expectedVersion: next.version,
      subjectRef: next.subjectRef,
      option: 'request_changes',
      comment: 'again',
    });
    expect(viaInbox.status).toBe(409);
    expect(await viaInbox.json()).toMatchObject({ error: 'replan_limit_reached' });
    // Feedback is required before anything else is checked.
    const empty = await post(rt, `/v1/inbox/${next.id}/decide`, {
      expectedVersion: next.version,
      subjectRef: next.subjectRef,
      option: 'request_changes',
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: 'feedback_required' });

    // Nothing changed, and the item still offers its options.
    expect(await json<ItemBody>(rt.request(`/v1/inbox/${next.id}`))).toMatchObject({
      state: 'open',
      version: next.version,
    });
    expect((await planView(rt, job.id)).replans).toEqual({ used: 1, max: 1 });

    // An edit still works at the cap, and doesn't count.
    const file = await editedPlanFile(rt, job.id);
    const edit = await rt.home.cli(['plan', 'edit', job.id, '--file', file]);
    expect(edit.code, edit.stderr).toBe(0);
    const edited = await planView(rt, job.id);
    expect(edited.replans).toEqual({ used: 1, max: 1 });
    expect(edited.planAuthoredBy).toBe('user:local');

    // So does reject.
    const reject = await post(rt, `/v1/jobs/${job.id}/plan/reject`, {
      expectedVersion: 0,
      planArtifactId: edited.planArtifactId,
    });
    expect(reject.status).toBe(200);
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).status).toBe('rejected');
  });
});

describe('a decision on a replaced Plan', () => {
  it('is refused: the old item is closed and the new one names another Plan', async () => {
    const { rt, job, item } = await waitingForPlan();
    const file = await editedPlanFile(rt, job.id);
    const edit = await rt.home.cli(['plan', 'edit', job.id, '--file', file]);
    expect(edit.code, edit.stderr).toBe(0);
    const view = await planView(rt, job.id);
    const current = view.approval as ItemBody;

    // Deciding the superseded item.
    const old = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'approve',
    });
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: 'item_not_open' });

    // Naming the replaced Plan on the Job's operations, at the current item's version.
    const named = { expectedVersion: current.version, planArtifactId: item.subjectRef };
    for (const [path, body] of [
      ['approve', named],
      ['reject', named],
      ['request-changes', { ...named, feedback: 'x' }],
      ['edit', { ...named, plan: validOutput('planning') }],
    ] as const) {
      const res = await post(rt, `/v1/jobs/${job.id}/plan/${path}`, body);
      expect(res.status, path).toBe(409);
      expect(await res.json(), path).toMatchObject({ error: 'subject_mismatch' });
    }

    // Nothing changed.
    expect(await json<ItemBody>(rt.request(`/v1/inbox/${current.id}`))).toMatchObject({
      state: 'open',
      version: current.version,
    });
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).status).toBe('waiting_human');
  });
});
