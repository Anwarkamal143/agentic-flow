/**
 * The `spec` Fault Origin route (#47, ARCHITECTURE §4.6, Phase B decisions
 * Q11 and Q18). A blocking review Finding that blames the Specification
 * re-runs `specification` with the Finding: a new spec Artifact (the old one
 * kept), counted against `maxReplans`, waiting on a `spec_change` Approval.
 * Approve → the raising Task is cancelled and the Job replans under the new
 * spec, through `plan_approval`. Request changes → the specifier runs again
 * with the comment. Reject → the new spec is discarded (kept on record) and
 * the Finding waits on a Blocker: Rework with guidance (against
 * `maxAttempts`), replan under the current spec, or cancel. Asserted through
 * the API, the CLI and the dashboard.
 */
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  useFakeHarness,
  type RunningRuntime,
  type TestHome,
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
import { startDashboard } from '../support/dashboard.js';
import {
  scriptWith,
  SUM_SOURCE,
  validOutput,
  validReviewResponse,
  validTaskResponse,
} from '../support/scripts.js';

interface TaskBody {
  id: string;
  key: string;
  state: string;
  maxAttempts: number;
  blocker: { kind: string; reason: string; attemptId: string } | null;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  stageId: string | null;
  subjectRef: string;
  question: string;
  why: string;
  state: string;
  version: number;
  evidence: string[];
  options: { id: string; label: string }[];
  decidedBy: string | null;
  decision: { option: string; comment: string | null } | null;
}
interface ArtifactBody {
  id: string;
  kind: string;
  stageRunId: string | null;
}
interface CriterionBody {
  code: string;
  text: string;
}
interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  packet: { context: { guidance: { text: string }[] } };
}
interface RouteJobBody extends JobBody {
  replans: { used: number; max: number };
  stageRuns: (JobBody['stageRuns'][number] & { attempt: number })[];
}

const PROBLEM = 'The Specification never says what sum() returns for negative numbers.';

/** A review that requests changes with one blocking Finding blaming the Specification. */
function specFinding() {
  const review = validReviewResponse();
  review.output.outcome = 'changes_requested';
  review.output.findings = [
    {
      severity: 'high',
      faultOrigin: 'spec',
      location: 'spec AC-01',
      problem: PROBLEM,
      why: 'The developer had to guess.',
      recommendation: 'Say that sum(-2, -3) returns -5.',
      blocking: true,
    },
  ];
  return review;
}

/** The valid Specification with AC-01's text replaced, to tell the versions apart. */
function specVersion(ac01: string) {
  const spec = validOutput('specification') as {
    acceptanceCriteria: { code: string; text: string }[];
  };
  const [first] = spec.acceptanceCriteria;
  if (first !== undefined) first.text = ac01;
  return { output: spec };
}

/** A second developer response: a Rework in the same Worktree must commit something new. */
function reworkResponse() {
  const response = validTaskResponse();
  response.steps = [
    {
      write: {
        path: 'src/math.ts',
        content: `${SUM_SOURCE}\n// sum() handles negative numbers too.\n`,
      },
    },
    { commit: 'Note that sum() handles negative numbers' },
  ];
  return response;
}

const V1 = 'sum(2, 3) returns 5.';
const V2 = 'sum(2, 3) returns 5 and sum(-2, -3) returns -5.';
const V3 = 'sum(a, b) returns a + b for every pair of numbers, negative ones included.';

/** A script: these Specifications, two Plans, two developer Runs, then the review responses. */
function script(specs: (string | object)[], reviews: unknown[], plans = 2) {
  const plan = { output: validOutput('planning') };
  return scriptWith(
    {
      specification: specs.map((s) => (typeof s === 'string' ? specVersion(s) : s)),
      planning: Array.from({ length: plans }, () => plan),
    },
    { 'add-sum': [validTaskResponse(), reworkResponse()] },
    { 'add-sum': reviews },
  );
}

async function runtimeWith(
  text: string,
  config: Record<string, unknown> = {},
): Promise<{ rt: RunningRuntime; repo: { id: string; projectId: string }; home: TestHome }> {
  const home = await initializedHome();
  useFakeHarness(home, text);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  const res = await post(rt, `/v1/projects/${repo.projectId}/config`, {
    planApproval: 'skip',
    ...config,
  });
  expect(res.status, 'the Project config').toBe(200);
  return { rt, repo, home };
}

const jobOf = (rt: RunningRuntime, id: string) => json<RouteJobBody>(rt.request(`/v1/jobs/${id}`));
const tasksOf = (rt: RunningRuntime, id: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${id}/tasks`));
const eventsOf = (rt: RunningRuntime, id: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${id}/events`));
const specsOf = async (rt: RunningRuntime, id: string) =>
  (await json<ArtifactBody[]>(rt.request(`/v1/jobs/${id}/artifacts`))).filter(
    (a) => a.kind === 'spec',
  );
const criteriaOf = (rt: RunningRuntime, id: string) =>
  json<CriterionBody[]>(rt.request(`/v1/jobs/${id}/acceptance-criteria`));
const attemptsOf = (rt: RunningRuntime, id: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${id}/attempts`));
const itemOf = (rt: RunningRuntime, id: string) => json<ItemBody>(rt.request(`/v1/inbox/${id}`));
const openItems = (rt: RunningRuntime) => json<ItemBody[]>(rt.request('/v1/inbox'));
const specRuns = async (rt: RunningRuntime, id: string) =>
  (await eventsOf(rt, id)).filter(
    (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'specification',
  );

/** Polls `read` until `done` holds (at most 30 s). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}; last seen ${JSON.stringify(last)}`);
}

/** Waits for the open item of `kind` (and `not` a known one). */
async function openItem(rt: RunningRuntime, kind: string, not?: string): Promise<ItemBody> {
  const found = await until(
    async () => (await openItems(rt)).find((i) => i.kind === kind && i.id !== not),
    (i) => i !== undefined,
    `an open ${kind} item`,
  ).catch(async (err: unknown) => {
    const jobs = await json<{ id: string }[]>(rt.request('/v1/jobs'));
    const events = await Promise.all(jobs.map((j) => eventsOf(rt, j.id)));
    throw new Error(
      `${String(err)}\n${rt.output().slice(-3000)}\n${events
        .flat()
        .map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`)
        .join('\n')}`,
    );
  });
  if (found === undefined) throw new Error('unreachable');
  return found;
}

async function decide(
  rt: RunningRuntime,
  item: ItemBody,
  option: string,
  comment?: string,
): Promise<Response> {
  return post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
    ...(comment === undefined ? {} : { comment }),
  });
}

/** Waits for the Job's open plan item and approves it. */
async function approveOpenPlan(rt: RunningRuntime, jobId: string, not?: string): Promise<string> {
  const item = await openItem(rt, 'plan', not);
  const res = await post(rt, `/v1/jobs/${jobId}/plan/approve`, {
    expectedVersion: item.version,
    planArtifactId: item.subjectRef,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return item.id;
}

describe('the spec Fault Origin route', () => {
  it('re-specifies with the Finding, keeps the old spec, never regenerates it, and on approve replans under the new spec', async () => {
    const { rt, repo, home } = await runtimeWith(
      script([V1, V2], [specFinding(), validReviewResponse()]),
      {
        planApproval: 'required',
      },
    );
    const job = await createJob(rt, repo.id);
    const firstPlanItem = await approveOpenPlan(rt, job.id);

    // The review blames the Specification: specification re-runs with the Finding.
    const item = await openItem(rt, 'spec_change');
    const [oldSpec, newSpec] = await specsOf(rt, job.id);
    expect(oldSpec).toBeDefined();
    expect(item).toMatchObject({
      stageId: 'specification',
      subjectRef: newSpec?.id,
      evidence: [oldSpec?.id, newSpec?.id],
      state: 'open',
    });
    expect(item.options.map((o) => o.id)).toEqual(['approve', 'request_changes', 'reject']);
    const [task] = await tasksOf(rt, job.id);
    expect(item.taskId).toBe(task?.id);
    expect(task).toMatchObject({
      state: 'blocked',
      blocker: { kind: 'human', reason: 'fault_origin_spec' },
    });
    const waiting = await jobOf(rt, job.id);
    expect(waiting.replans).toEqual({ used: 1, max: 2 });
    expect(waiting.status).toBe('waiting_human');
    expect(
      waiting.stageRuns.filter((s) => s.stageId === 'specification').map((s) => s.state),
    ).toEqual(['succeeded', 'waiting_human']);
    const runs = await specRuns(rt, job.id);
    expect(runs).toHaveLength(2);
    const respec = runs[1]?.payload['respec'] as { specArtifactId: string; feedback: string };
    expect(respec.specArtifactId).toBe(oldSpec?.id);
    expect(respec.feedback).toContain(PROBLEM);
    // Until it is approved, the Job's Acceptance Criteria are the current spec's.
    expect((await criteriaOf(rt, job.id)).find((c) => c.code === 'AC-01')?.text).toBe(V1);

    // A restart regenerates nothing: the item still waits, and no specifier Run starts.
    await rt.stop();
    const again = await startRuntime(home);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await specRuns(again, job.id)).toHaveLength(2);
    expect((await itemOf(again, item.id)).state).toBe('open');

    const approved = await decide(again, item, 'approve');
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await itemOf(again, item.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'approve' },
    });
    await approveOpenPlan(again, job.id, firstPlanItem);
    const done = await waitForJob(again, job.id, jobSettled, 30_000);
    expect(done.status, again.output()).toBe('completed');

    // The raising Task was cancelled, a new one ran under the new spec; both specs are kept.
    const tasks = await tasksOf(again, job.id);
    expect(tasks.map((t) => [t.id === task?.id, t.state])).toEqual([
      [true, 'cancelled'],
      [false, 'approved'],
    ]);
    expect((await specsOf(again, job.id)).map((a) => a.id)).toEqual([oldSpec?.id, newSpec?.id]);
    expect((await criteriaOf(again, job.id)).find((c) => c.code === 'AC-01')?.text).toBe(V2);
    const events = await eventsOf(again, job.id);
    const planner = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect(planner).toHaveLength(2);
    const replan = planner[1]?.payload['replan'] as { feedback: string };
    expect(replan.feedback).toContain(newSpec?.id);
    // The re-specification was the one Replan: approving it cost nothing more.
    expect((await jobOf(again, job.id)).replans).toEqual({ used: 1, max: 2 });
    expect(await specRuns(again, job.id)).toHaveLength(2);
  });

  it('request changes re-runs the specifier with the comment, counted, and is refused without feedback or at the cap', async () => {
    const { rt, repo } = await runtimeWith(
      script([V1, V2, V3], [specFinding(), validReviewResponse()]),
    );
    const job = await createJob(rt, repo.id);
    const first = await openItem(rt, 'spec_change');

    const bare = await decide(rt, first, 'request_changes');
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain('feedback_required');

    const asked = await rt.home.cli([
      'inbox',
      'decide',
      first.id,
      'request_changes',
      '--comment',
      'Cover every pair of numbers, not only one example.',
      '--expect-version',
      String(first.version),
    ]);
    expect(asked.code, asked.stderr).toBe(0);
    const second = await openItem(rt, 'spec_change', first.id);
    const specs = await specsOf(rt, job.id);
    expect(specs).toHaveLength(3);
    expect(second.subjectRef).toBe(specs[2]?.id);
    expect(second.evidence).toEqual([specs[1]?.id, specs[2]?.id]);
    const runs = await specRuns(rt, job.id);
    expect(runs).toHaveLength(3);
    expect(runs[2]?.payload['respec']).toMatchObject({
      specArtifactId: specs[1]?.id,
      feedback: 'Cover every pair of numbers, not only one example.',
    });
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 2, max: 2 });
    expect(
      (await jobOf(rt, job.id)).stageRuns
        .filter((s) => s.stageId === 'specification')
        .map((s) => s.state),
    ).toEqual(['succeeded', 'superseded', 'waiting_human']);

    // At maxReplans, request changes is refused; approve, reject and cancel remain.
    const capped = await decide(rt, second, 'request_changes', 'Once more.');
    expect(capped.status).toBe(409);
    expect(await capped.text()).toContain('replan_limit_reached');

    expect((await decide(rt, second, 'approve')).status).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect((await criteriaOf(rt, job.id)).find((c) => c.code === 'AC-01')?.text).toBe(V3);
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 2, max: 2 });
  });

  it('reject keeps the current spec and opens a Blocker; Rework with guidance runs a new Attempt', async () => {
    const { rt, repo } = await runtimeWith(
      script([V1, V2], [specFinding(), validReviewResponse()], 1),
    );
    const job = await createJob(rt, repo.id);
    const change = await openItem(rt, 'spec_change');
    const rejected = await rt.home.cli([
      'inbox',
      'decide',
      change.id,
      'reject',
      '--expect-version',
      String(change.version),
    ]);
    expect(rejected.code, rejected.stderr).toBe(0);

    const blocker = await openItem(rt, 'blocker');
    const [task] = await tasksOf(rt, job.id);
    expect(blocker).toMatchObject({ taskId: task?.id, subjectRef: task?.blocker?.attemptId });
    expect(blocker.question).toBe('Task add-sum has a Specification Finding to decide');
    expect(blocker.why).toContain(PROBLEM);
    expect(blocker.options.map((o) => o.id)).toEqual(['rework', 'replan', 'cancel_job']);
    expect(task?.blocker?.reason).toBe('spec_finding_unresolved');
    const shown = await jobOf(rt, job.id);
    expect(
      shown.stageRuns.filter((s) => s.stageId === 'specification').map((s) => s.state),
    ).toEqual(['succeeded', 'superseded']);
    expect(shown.status).toBe('waiting_human');
    // The new spec is discarded but kept on record; the current one still holds.
    expect(await specsOf(rt, job.id)).toHaveLength(2);
    expect((await criteriaOf(rt, job.id)).find((c) => c.code === 'AC-01')?.text).toBe(V1);

    const rework = await decide(rt, blocker, 'rework', 'Keep the spec; add a JSDoc comment.');
    expect(rework.status, await rework.clone().text()).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    const attempts = await attemptsOf(rt, job.id);
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'initial', 'failed'],
      [2, 'rework', 'passed'],
    ]);
    expect(attempts[1]?.packet.context.guidance.map((g) => g.text)).toEqual([
      'Keep the spec; add a JSDoc comment.',
    ]);
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 1, max: 2 });
  });

  it('after a reject, Rework with no Attempt left waits on the Rework cap instead; replan goes under the current spec', async () => {
    const { rt, repo } = await runtimeWith(
      script([V1, V2], [specFinding(), validReviewResponse()]),
      { maxAttempts: 1 },
    );
    const job = await createJob(rt, repo.id);
    const change = await openItem(rt, 'spec_change');
    expect((await decide(rt, change, 'reject')).status).toBe(200);
    const blocker = await openItem(rt, 'blocker');

    // No option escapes a cap: the Rework would be Attempt 2 of at most 1.
    expect((await decide(rt, blocker, 'rework', 'Try again.')).status).toBe(200);
    const capped = await openItem(rt, 'blocker', blocker.id);
    expect(capped.question).toBe('Task add-sum reached its Rework cap');
    expect(capped.options.map((o) => o.id)).toEqual(['grant', 'replan', 'cancel_job']);
    expect((await tasksOf(rt, job.id))[0]?.blocker?.reason).toBe('rework_cap_reached');
    expect(await attemptsOf(rt, job.id)).toHaveLength(1);

    // Replan under the current spec: a counted Replan, the Task re-planned.
    expect((await decide(rt, capped, 'replan', 'Plan it again.')).status).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect((await tasksOf(rt, job.id)).map((t) => t.state)).toEqual(['cancelled', 'approved']);
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 2, max: 2 });
    expect((await criteriaOf(rt, job.id)).find((c) => c.code === 'AC-01')?.text).toBe(V1);
  });

  it('past maxReplans the Job waits on replan_cap_reached; +1 replan starts the re-specification', async () => {
    const { rt, repo } = await runtimeWith(
      script([V1, V2], [specFinding(), validReviewResponse()]),
      { maxReplans: 0 },
    );
    const job = await createJob(rt, repo.id);
    const held = await openItem(rt, 'blocker');
    expect(held).toMatchObject({ taskId: null, state: 'open' });
    expect(held.options.map((o) => o.id)).toEqual(['grant_replan', 'cancel_job']);
    const waiting = await waitForJob(rt, job.id, (j) => j.status === 'waiting_human', 30_000);
    expect(waiting.status).toBe('waiting_human');
    const execution = (await jobOf(rt, job.id)).stageRuns
      .filter((s) => s.stageId === 'execution')
      .at(-1) as { blocker?: { reason: string } | null } | undefined;
    expect(execution?.blocker?.reason).toBe('replan_cap_reached');
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await specRuns(rt, job.id)).toHaveLength(1);

    const granted = await decide(rt, held, 'grant_replan');
    expect(granted.status, await granted.clone().text()).toBe(200);
    const change = await openItem(rt, 'spec_change');
    expect(await specRuns(rt, job.id)).toHaveLength(2);
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 1, max: 1 });
    expect((await decide(rt, change, 'approve')).status).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect((await jobOf(rt, job.id)).replans).toEqual({ used: 1, max: 1 });
  });

  it('a failed re-specification leaves the Finding to the operator on its Blocker', async () => {
    const invalid = { output: { problem: 'only a problem' } };
    const { rt, repo } = await runtimeWith(script([V1, invalid, invalid], [specFinding()], 1));
    const job = await createJob(rt, repo.id);
    const blocker = await openItem(rt, 'blocker');
    expect(blocker.options.map((o) => o.id)).toEqual(['rework', 'replan', 'cancel_job']);
    expect(blocker.why).toContain('the re-specification failed (invalid_output');
    expect(blocker.why).toContain(PROBLEM);
    expect(await specRuns(rt, job.id)).toHaveLength(3);
    expect(await specsOf(rt, job.id)).toHaveLength(1);
    const specification = (await jobOf(rt, job.id)).stageRuns.filter(
      (s) => s.stageId === 'specification',
    );
    // It no longer counts: the Job goes on under the current Specification.
    expect(specification.map((s) => s.state)).toEqual(['succeeded', 'superseded']);
    const superseded = (await eventsOf(rt, job.id)).find(
      (e) => e.type === 'stage_run.superseded' && e.entityId === specification[1]?.id,
    );
    expect(String(superseded?.payload['reason'])).toContain('the re-specification failed');
    expect((await tasksOf(rt, job.id))[0]?.blocker?.reason).toBe('spec_finding_unresolved');

    expect((await decide(rt, blocker, 'cancel_job')).status).toBe(200);
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status).toBe('cancelled');
  });

  it('the dashboard shows the spec_change item with both specs and decides it as user:local', async () => {
    const { rt, repo } = await runtimeWith(
      script([V1, V2], [specFinding(), validReviewResponse()]),
    );
    const job = await createJob(rt, repo.id);
    const change = await openItem(rt, 'spec_change');
    const dash = await startDashboard(rt.home);

    const html = await dash.html(`/inbox/${change.id}`);
    expect(html).toContain(change.question);
    for (const id of change.evidence) expect(html).toContain(`/artifacts/${id}`);
    const form = /<form\b[^>]*action="\/api\/inbox\/[^"]+\/decide"[\s\S]*?<\/form>/.exec(html)?.[0];
    for (const option of ['approve', 'request_changes', 'reject']) {
      expect(form).toMatch(new RegExp(`<button[^>]*value="${option}"[^>]*name="option"`));
    }
    const list = await dash.html('/inbox');
    expect(list).toContain(change.question);

    const res = await dash.postForm(`/api/inbox/${change.id}/decide`, {
      expectedVersion: String(change.version),
      subjectRef: change.subjectRef,
      option: 'approve',
    });
    expect(res.status, res.body).toBe(303);
    expect(await itemOf(rt, change.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'approve' },
    });
    const done = await waitForJob(rt, job.id, jobSettled, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    const page = await dash.html(`/inbox/${change.id}`);
    expect(page).toContain('Decided: Approve the change');
  });
});
