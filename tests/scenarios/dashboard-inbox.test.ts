/**
 * The dashboard Inbox and plan view (#37, ADR-0022). The built dashboard runs
 * against a real runtime and is spoken to over HTTP like a browser that runs
 * no scripts: its pages show the persisted Inbox Items and Plan, and its only
 * write path, the Inbox's forms, reaches the runtime API server-side as
 * `user:local`. Every mutation checks the loopback `Host` and the dashboard's
 * own `Origin`, and names the item's version, so a stale decision is refused
 * with the runtime's message.
 */
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createJob,
  json,
  jobSettled,
  registeredRepo,
  waitForJob,
  type JobBody,
} from '../support/api.js';
import { startDashboard, type RunningDashboard } from '../support/dashboard.js';
import { scriptWith, VALID_SCRIPT, validOutput } from '../support/scripts.js';

interface ItemBody {
  id: string;
  jobId: string;
  jobTitle: string;
  projectId: string;
  repositoryId: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  question: string;
  why: string;
  options: { id: string; label: string; description: string }[];
  recommended: string | null;
  evidence: string[];
  state: string;
  deferred: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decision: { option: string; comment: string | null } | null;
  version: number;
}

interface PlanViewBody {
  planArtifactId: string;
  triageRisk: string | null;
  repositories: { id: string; name: string }[];
  tasks: { key: string; title: string; objective: string; risk: string; dependsOn: string[] }[];
  parallel: string[][];
  decisionPoints: { description: string }[];
  estimate: {
    taskCount: number;
    attempts: { min: number; max: number; label: string };
    cost: { value: string; reason: string };
  };
}

/** A Job whose Plan waits on its `plan` Inbox Item, and the dashboard over it. */
async function waitingForPlan(script = VALID_SCRIPT): Promise<{
  rt: RunningRuntime;
  dash: RunningDashboard;
  job: JobBody;
  item: ItemBody;
}> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt, { planApproval: 'required' });
  const created = await createJob(rt, repo.id, 'Add sum() to math');
  const job = await waitForJob(rt, created.id, jobSettled);
  expect(job.status).toBe('waiting_human');
  const [item] = await json<ItemBody[]>(rt.request('/v1/inbox'));
  if (item === undefined) throw new Error('no Inbox Item opened');
  const dash = await startDashboard(home);
  return { rt, dash, job, item };
}

const getItem = (rt: RunningRuntime, id: string) => json<ItemBody>(rt.request(`/v1/inbox/${id}`));

/** The text a browser shows: tags removed, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** The form fields a decision on `item` sends, as the page renders them. */
function decision(item: ItemBody, option: string): Record<string, string> {
  return {
    expectedVersion: String(item.version),
    subjectRef: item.subjectRef,
    option,
    comment: '',
  };
}

describe('the dashboard Inbox', () => {
  it('lists an open item with everything PRODUCT_SPEC §10 lists, and its options as forms', async () => {
    const { rt, dash, item } = await waitingForPlan();
    const plan = await json<PlanViewBody>(rt.request(`/v1/jobs/${item.jobId}/plan`));
    const [repo] = await json<{ id: string; name: string }[]>(rt.request('/v1/repositories'));

    const html = await dash.html('/inbox');
    const page = text(html);
    expect(html).toContain(`href="/jobs/${item.jobId}"`);
    expect(page).toContain(item.jobTitle);
    expect(page).toContain(item.projectId);
    expect(page).toContain(repo?.name);
    expect(page).toContain(`Stage ${String(item.stageId)}`);
    expect(page).toContain(`Requested by ${item.requestedBy}`);
    expect(page).toContain(item.question);
    expect(page).toContain(item.why);
    for (const o of item.options) {
      expect(page).toContain(o.label);
      expect(page).toContain(o.description);
    }
    expect(page).toContain(`Recommended: ${item.recommended ?? 'none'}`);
    // A plan item's risks are its Plan's: the triage risk and each Task's.
    expect(page).toContain(`Triage risk ${String(plan.triageRisk)}`);
    for (const t of plan.tasks) expect(page).toContain(`${t.key}: ${t.risk}`);
    for (const a of item.evidence) expect(html).toContain(`href="/artifacts/${a}"`);
    expect(page).toContain('Stays pending until a human decides; never auto-approved');
    expect(page).toContain(`Version ${String(item.version)}`);

    // A form posting to the dashboard, never to the runtime: a button per option, the
    // version and the subject the page shows, and an optional comment.
    const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
    const decide = forms.filter((f) => f.includes(`action="/api/inbox/${item.id}/decide"`));
    expect(decide).toHaveLength(1);
    const form = decide[0] ?? '';
    const buttons = [...form.matchAll(/<button\b[^>]*\bname="option"[^>]*>/g)].map((m) => m[0]);
    expect(buttons.map((b) => /\bvalue="([^"]+)"/.exec(b)?.[1])).toEqual(
      item.options.map((o) => o.id),
    );
    expect(form).toContain(`name="expectedVersion" value="${String(item.version)}"`);
    expect(form).toContain(`name="subjectRef" value="${item.subjectRef}"`);
    expect(form).toContain('name="comment"');
    expect(form).toMatch(/method="post"/);
    expect(html).not.toContain(rt.url);
    expect(html).not.toContain(rt.home.token());
  });

  it('approves a Plan from the Inbox as user:local: execution starts', async () => {
    const { rt, dash, job, item } = await waitingForPlan();

    const res = await dash.postForm(`/api/inbox/${item.id}/decide`, decision(item, 'approve'));
    expect(res.status, res.body).toBe(303);
    expect(res.location).toMatch(new RegExp(`/inbox/${item.id}$`));

    const decided = await getItem(rt, item.id);
    expect(decided).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'approve' },
    });
    const done = await waitForJob(
      rt,
      job.id,
      (j) => j.status !== 'waiting_human' && jobSettled(j),
      30_000,
    );
    expect(done.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe('succeeded');
    expect(done.stageRuns.find((s) => s.stageId === 'execution')?.state).not.toBe('pending');

    // The item's page shows the persisted decision, with no form left.
    const page = await dash.html(`/inbox/${item.id}`);
    expect(text(page)).toContain('Decided: Approve by user:local');
    expect(page).not.toMatch(/<form\b/);
  });

  it('rejects a Plan with a comment: the Job ends rejected', async () => {
    const { rt, dash, job, item } = await waitingForPlan();

    const res = await dash.postForm(`/api/inbox/${item.id}/decide`, {
      ...decision(item, 'reject'),
      comment: 'Split the work differently',
    });
    expect(res.status, res.body).toBe(303);
    expect(await getItem(rt, item.id)).toMatchObject({
      state: 'decided',
      decision: { option: 'reject', comment: 'Split the work differently' },
    });
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).status).toBe('rejected');
    expect(text(await dash.html('/inbox'))).toContain('Nothing needs you');
  });

  it('requests changes to a Plan with feedback: the planner re-plans and a new Plan waits', async () => {
    const replanned = { ...validOutput('planning') };
    const script = scriptWith({
      planning: [{ output: validOutput('planning') }, { output: replanned }],
    });
    const { rt, dash, job, item } = await waitingForPlan(script);
    const feedback = 'Name the Task after the sum() helper.';

    // The form says the comment is the feedback a "Request changes" needs.
    const html = await dash.html(`/inbox/${item.id}`);
    expect(text(html)).toContain(
      'Comment (optional; required with “Request changes”, as the planner’s feedback)',
    );

    // Without feedback the runtime refuses, and its message is shown; nothing changes.
    const bare = await dash.postForm(
      `/api/inbox/${item.id}/decide`,
      decision(item, 'request_changes'),
    );
    expect(bare.status).toBe(400);
    expect(text(bare.body)).toContain('request changes needs feedback for the planner');
    expect(await getItem(rt, item.id)).toMatchObject({ state: 'open', version: item.version });

    const res = await dash.postForm(`/api/inbox/${item.id}/decide`, {
      ...decision(item, 'request_changes'),
      comment: feedback,
    });
    expect(res.status, res.body).toBe(303);
    expect(await getItem(rt, item.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'request_changes', comment: feedback },
    });

    // A Replan: planning runs again with the Plan and the feedback, then a new plan item opens.
    const next = await waitForJob(
      rt,
      job.id,
      (j) =>
        j.stageRuns.filter((s) => s.stageId === 'plan_approval').at(-1)?.state ===
          'waiting_human' && j.stageRuns.filter((s) => s.stageId === 'planning').length === 2,
      30_000,
    );
    expect(next.status, rt.output()).toBe('waiting_human');
    const events = await json<{ type: string; payload: Record<string, unknown> }[]>(
      rt.request(`/v1/jobs/${job.id}/events`),
    );
    const runs = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'planning',
    );
    expect(runs[1]?.payload['replan']).toEqual({ planArtifactId: item.subjectRef, feedback });
    const [open] = await json<ItemBody[]>(rt.request('/v1/inbox'));
    expect(open).toMatchObject({ kind: 'plan', state: 'open' });
    expect(open?.subjectRef).not.toBe(item.subjectRef);
    expect(await dash.html('/inbox')).toContain(`action="/api/inbox/${String(open?.id)}/decide"`);
  });

  it('defers an item out of the default view and undefers it back', async () => {
    const { rt, dash, item } = await waitingForPlan();

    const deferred = await dash.postForm(`/api/inbox/${item.id}/defer`, {
      expectedVersion: String(item.version),
    });
    expect(deferred.status, deferred.body).toBe(303);
    const after = await getItem(rt, item.id);
    expect(after).toMatchObject({ state: 'open', deferred: true });
    // Hidden from the default view, shown with every item.
    expect(await dash.html('/inbox')).not.toContain(`/inbox/${item.id}`);
    const all = await dash.html('/inbox?all=true');
    expect(all).toContain(`action="/api/inbox/${item.id}/undefer"`);
    expect(text(all)).toContain('Deferred');

    const undeferred = await dash.postForm(`/api/inbox/${item.id}/undefer`, {
      expectedVersion: String(after.version),
    });
    expect(undeferred.status, undeferred.body).toBe(303);
    expect(await getItem(rt, item.id)).toMatchObject({ state: 'open', deferred: false });
    expect(await dash.html('/inbox')).toContain(`action="/api/inbox/${item.id}/decide"`);
  });

  it('refuses a decision from a foreign Origin, or with none, and changes nothing', async () => {
    const { rt, dash, item } = await waitingForPlan();
    const fields = decision(item, 'approve');

    for (const origin of ['http://attacker.example', 'http://127.0.0.1:1', 'null', null]) {
      const res = await dash.postForm(`/api/inbox/${item.id}/decide`, fields, { origin });
      expect(res.status, String(origin)).toBe(403);
      expect(res.body).toContain('forbidden_origin');
    }
    expect(await getItem(rt, item.id)).toMatchObject({ state: 'open', version: item.version });
  });

  it('refuses a decision addressed to a foreign Host, even with a matching Origin', async () => {
    const { rt, dash, item } = await waitingForPlan();

    const res = await dash.postForm(`/api/inbox/${item.id}/decide`, decision(item, 'approve'), {
      host: 'attacker.example',
      origin: 'http://attacker.example',
    });
    expect(res.status).toBe(403);
    expect(await getItem(rt, item.id)).toMatchObject({ state: 'open', version: item.version });
  });

  it('refuses a stale version with the runtime’s message', async () => {
    const { rt, dash, item } = await waitingForPlan();
    // Someone else defers it first: the page's version is now stale.
    const first = await dash.postForm(`/api/inbox/${item.id}/defer`, {
      expectedVersion: String(item.version),
    });
    expect(first.status).toBe(303);

    const res = await dash.postForm(`/api/inbox/${item.id}/decide`, decision(item, 'approve'));
    expect(res.status).toBe(409);
    const shown = text(res.body);
    expect(shown).toContain(
      `the item is at version ${String(item.version + 1)}, not ${String(item.version)}`,
    );
    expect(res.body).toContain(`href="/inbox/${item.id}"`);
    expect(await getItem(rt, item.id)).toMatchObject({ state: 'open', decision: null });
  });

  it('refuses a malformed request before it reaches the runtime', async () => {
    const { dash, item } = await waitingForPlan();
    for (const [path, fields] of [
      [`/api/inbox/${item.id}/decide`, { expectedVersion: 'x', subjectRef: 'a', option: 'b' }],
      [`/api/inbox/${item.id}/decide`, { expectedVersion: '1' }],
      [`/api/inbox/${item.id}/explode`, { expectedVersion: '1' }],
      ['/api/inbox/..%2Fjobs/decide', { expectedVersion: '1' }],
    ] as const) {
      const res = await dash.postForm(path, fields);
      expect([400, 404], path).toContain(res.status);
    }
    expect((await dash.request(`/api/inbox/${item.id}/decide`)).status).toBe(405);
  });
});

describe('the plan view', () => {
  it('shows the Plan read-only on the Job page, with everything PRODUCT_SPEC §7 lists', async () => {
    const { rt, dash, job } = await waitingForPlan();
    const plan = await json<PlanViewBody>(rt.request(`/v1/jobs/${job.id}/plan`));

    const html = await dash.html(`/jobs/${job.id}`);
    const section = /data-testid="plan"[\s\S]*?data-testid="plan-end"/.exec(html)?.[0] ?? '';
    const page = text(section);
    expect(page).toContain(plan.planArtifactId);
    // The Specification it implements.
    expect(page).toContain('Specification');
    expect(page).toContain('There is no way to sum two numbers.');
    // The DAG: each Task with what it depends on.
    for (const t of plan.tasks) {
      expect(page).toContain(t.title);
      expect(page).toContain(t.objective);
      expect(page).toContain(
        `${t.key} depends on ${t.dependsOn.length === 0 ? 'nothing' : t.dependsOn.join(', ')}`,
      );
    }
    for (const r of plan.repositories) expect(page).toContain(r.name);
    plan.parallel.forEach((wave, i) => {
      expect(page).toContain(`Wave ${String(i + 1)}: ${wave.join(', ')}`);
    });
    expect(page).toContain(`Triage risk ${String(plan.triageRisk)}`);
    for (const d of plan.decisionPoints) expect(page).toContain(d.description);
    const { estimate } = plan;
    expect(page).toContain(`${String(estimate.taskCount)} Task`);
    expect(page).toContain(
      `${String(estimate.attempts.min)}–${String(estimate.attempts.max)} Attempts (${estimate.attempts.label})`,
    );
    expect(page).toContain(`Cost unknown: ${estimate.cost.reason}`);
    // Read-only, and it says where the decision is made.
    expect(html).not.toMatch(/<(form|button|input|textarea|select)\b/);
    expect(section).toContain('href="/inbox/');
  });

  it('says there is no Plan yet for a Job that has none', async () => {
    const home = await initializedHome();
    const rt = await startRuntime(home);
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id); // no Harness: it stays queued
    const dash = await startDashboard(home);
    expect(text(await dash.html(`/jobs/${job.id}`))).toContain('No Plan yet');
  });

  it('shows an Evidence Artifact read-only', async () => {
    const { rt, dash, item } = await waitingForPlan();
    const id = item.evidence[0] ?? item.subjectRef;
    const meta = await json<{ kind: string; contentHash: string }>(
      rt.request(`/v1/artifacts/${id}`),
    );
    const page = text(await dash.html(`/artifacts/${id}`));
    expect(page).toContain(meta.kind);
    expect(page).toContain(meta.contentHash);
    await dash.html('/artifacts/art_does_not_exist', 404);
  });
});
