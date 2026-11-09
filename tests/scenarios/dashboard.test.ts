/**
 * The read-only dashboard (#15). The built dashboard runs against a real
 * runtime and is read over HTTP like a browser that runs no scripts: the
 * server-rendered pages must show the persisted Job, Tasks, Attempts,
 * Evidence and review, label unknown usage and the Tier 0 guardrail honestly,
 * and offer no write action. Its event stream passes the runtime's through
 * and resumes without gaps or duplicates.
 */
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, type RunningRuntime } from '../support/factory.js';
import {
  createJob,
  json,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { claudeStub, useClaudeCode } from '../support/claude.js';
import { startDashboard } from '../support/dashboard.js';
import { killGroupsOnFinish } from '../support/processes.js';
import { openStream } from '../support/sse.js';

interface AttemptBody {
  id: string;
  n: number;
  tier: string;
  usage: { costTag?: string; inputTokens: number | null } | null;
  evidence: { verdict: string; criterionCode: string | null; verificationKey: string | null }[];
}
interface ReviewBody {
  outcome: string;
  summary: string;
  findings: { problem: string }[];
}
interface TaskBody {
  title: string;
  state: string;
}

/** A Job completed by the Claude Code adapter against its stand-in CLI (subscription billing). */
async function completedJob(): Promise<{ rt: RunningRuntime; job: JobBody }> {
  const stub = claudeStub();
  const home = await initializedHome();
  useClaudeCode(home, stub.command);
  const rt = await startRuntime(home);
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  const created = await createJob(rt, repo.id, 'Add sum() to math');
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 30_000);
  expect(job.status, 'the Job completes').toBe('completed');
  return { rt, job };
}

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

describe('the read-only dashboard', () => {
  it('renders the job detail of a Job persisted through the API: Tasks, Attempts, Evidence, review, timeline', async () => {
    const { rt, job } = await completedJob();
    const dash = await startDashboard(rt.home);

    const html = await dash.html(`/jobs/${job.id}`);
    const page = text(html);
    const [task] = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    const [review] = await json<ReviewBody[]>(rt.request(`/v1/jobs/${job.id}/reviews`));
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    if (task === undefined || attempt === undefined || review === undefined) {
      throw new Error('the Job has no Task, Attempt or review');
    }

    // The Job, as persisted.
    expect(page).toContain('Add sum() to math');
    expect(page).toContain(job.id);
    expect(page).toContain('completed');
    // Its Task and Attempt.
    expect(page).toContain(task.title);
    expect(page).toContain(`Attempt ${String(attempt.n)}`);
    // Evidence: every row, with its verdict.
    const evidenceRows = /data-testid="evidence"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(attempt.evidence.length).toBeGreaterThan(0);
    for (const e of attempt.evidence) {
      expect(text(evidenceRows)).toContain(
        `${String(e.criterionCode ?? e.verificationKey)} ${e.verdict}`,
      );
    }
    // The review and its Findings.
    expect(page).toContain('Independent review');
    expect(page).toContain(review.outcome);
    expect(page).toContain(review.summary);
    for (const f of review.findings) expect(page).toContain(f.problem);
    // The timeline: each persisted event once, in order.
    const seqs = [...html.matchAll(/data-seq="(\d+)"/g)].map((m) => Number(m[1]));
    expect(seqs).toEqual(events.map((e) => e.seq));
  });

  it('labels a subscription cost as unknown and the local tier as a guardrail, never a sandbox', async () => {
    const { rt, job } = await completedJob();
    const dash = await startDashboard(rt.home);
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempt?.tier).toBe('local');
    expect(attempt?.usage?.costTag).toBe('unknown/subscription');

    const page = text(await dash.html(`/jobs/${job.id}`));
    expect(page).toContain('Cost unknown (subscription)');
    expect(page).toContain('Tier 0 · local guardrail');
    expect(page).toContain('without isolation');
    expect(page.toLowerCase()).not.toContain('sandbox');
  });

  it('lists the persisted Jobs, each linking to its detail', async () => {
    const { rt, job } = await completedJob();
    const dash = await startDashboard(rt.home);

    const html = await dash.html('/');
    expect(html).toContain(`href="/jobs/${job.id}"`);
    expect(text(html)).toContain('Add sum() to math');
  });

  it('offers no write action, and keeps the API token on the server', async () => {
    const { rt, job } = await completedJob();
    const dash = await startDashboard(rt.home);

    for (const path of ['/', `/jobs/${job.id}`]) {
      const html = await dash.html(path);
      expect(html, path).not.toMatch(/<(form|button|input|textarea|select)\b/);
      expect(html, path).not.toContain(rt.home.token());
    }
    // The event stream is GET only.
    const res = await dash.request('/api/events/stream', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('says so when the runtime is not running, and 404s an unknown Job', async () => {
    const home = await initializedHome();
    const dash = await startDashboard(home);
    expect(text(await dash.html('/'))).toContain('The factory runtime is not running');

    const rt = await startRuntime(home);
    await dash.html('/jobs/job_does_not_exist', 404);
    expect(text(await dash.html('/'))).toContain('No Jobs yet');
    await rt.stop();
  });

  it('refuses a request addressed to a host other than loopback (DNS rebinding)', async () => {
    const home = await initializedHome();
    await startRuntime(home);
    const dash = await startDashboard(home);
    expect(await dash.getWithHost('/', `127.0.0.1:${String(dash.port)}`)).toBe(200);
    expect(await dash.getWithHost('/', `localhost:${String(dash.port)}`)).toBe(200);
    expect(await dash.getWithHost('/', 'attacker.example')).toBe(403);
    expect(await dash.getWithHost('/api/events/stream', 'attacker.example:80')).toBe(403);
  });

  it('streams events live and resumes after a reload or reconnect without gaps or duplicates', async () => {
    // No Harness: a Job stays queued, so its events are only the ones this test causes.
    const home = await initializedHome();
    const rt = await startRuntime(home);
    const dash = await startDashboard(home);
    const repo = await registeredRepo(rt);
    const first = await createJob(rt, repo.id, 'First');

    // A page rendered now shows the Job's events up to here; it streams from the last one.
    const shown = await json<EventBody[]>(rt.request(`/v1/jobs/${first.id}/events`));
    const lastShown = shown.at(-1)?.seq ?? 0;
    const page = await dash.html(`/jobs/${first.id}`);
    expect([...page.matchAll(/data-seq="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(
      shown.map((e) => e.seq),
    );

    // Live: the cancel's events arrive through the dashboard's stream.
    const live = await openStream(
      dash,
      `/api/events/stream?job=${first.id}&after=${String(lastShown)}`,
    );
    expect(live.status).toBe(200);
    const cancel = await post(rt, `/v1/jobs/${first.id}/cancel`, {
      expectedVersion: first.version,
    });
    expect(cancel.status).toBe(200);
    const all = await json<EventBody[]>(rt.request(`/v1/jobs/${first.id}/events`));
    const expected = all.filter((e) => e.seq > lastShown).map((e) => e.seq);
    expect(expected.length).toBeGreaterThan(0);
    const got = await live.until((m) => Number(m.id) === expected.at(-1));
    expect(got.map((m) => Number(m.id))).toEqual(expected);
    expect(got.map((m) => (JSON.parse(m.data) as EventBody).seq)).toEqual(expected);

    // Disconnect after the first of them, then reconnect as EventSource does (Last-Event-ID).
    live.close();
    const resumed = await openStream(dash, `/api/events/stream?job=${first.id}&after=0`, {
      lastEventId: String(expected[0]),
    });
    const replay = await resumed.until((m) => Number(m.id) === expected.at(-1));
    expect(replay.map((m) => Number(m.id))).toEqual(expected.slice(1));

    // Every Job's events (the list page's stream): a Job created while connected arrives.
    const head = (await json<EventBody[]>(rt.request('/v1/events?limit=1000'))).at(-1)?.seq ?? 0;
    const everything = await openStream(dash, `/api/events/stream?after=${String(head)}`);
    const second = await createJob(rt, repo.id, 'Second');
    const created = await everything.until(
      (m) => (JSON.parse(m.data) as EventBody).jobId === second.id,
    );
    expect(created.map((m) => (JSON.parse(m.data) as EventBody).jobId)).toContain(second.id);
  });
});
