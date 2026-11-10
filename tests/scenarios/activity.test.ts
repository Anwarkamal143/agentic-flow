/**
 * Live activity (#49, PRODUCT_SPEC §11 "What's running right now?"). The
 * runtime lists every running Attempt with its Job, Task, Harness, model,
 * Repository, security tier, heartbeat and port block, and serves a redacted
 * tail of the process it waits on, read from the spool. `factory activity`
 * shows the same, and so does the dashboard's live activity page. A secret
 * the Harness prints is never in the tail, and the tier is never a sandbox.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  tempDir,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import { createJob, json, post, registeredRepo, type JobBody } from '../support/api.js';
import { startDashboard } from '../support/dashboard.js';
import { filesUnder } from '../support/files.js';
import { killGroupsOnFinish, waitFor } from '../support/processes.js';
import { scriptWith, validTaskResponse } from '../support/scripts.js';

interface ActivityBody {
  at: string;
  attempts: {
    attemptId: string;
    n: number;
    state: string;
    job: { id: string; title: string };
    task: { id: string; key: string; title: string };
    harness: { id: string; version: string | null };
    model: string | null;
    repository: { id: string; name: string };
    tier: string;
    tierLabel: string;
    startedAt: string;
    heartbeat: { at: string; ageMs: number } | null;
    ports: { base: number; size: number };
  }[];
}

interface TailBody {
  attemptId: string;
  running: boolean;
  process: { kind: string; label: string } | null;
  lines: string[];
  truncated: boolean;
  heartbeat: { at: string; ageMs: number } | null;
}

const LINES = 300;

/**
 * A Job whose developer Harness Run prints 300 numbered lines and two
 * secrets, then keeps running until the test cancels it.
 */
async function runningAttempt(): Promise<{
  rt: RunningRuntime;
  job: JobBody;
  secret: string;
  patternSecret: string;
}> {
  const secret = `s3cr3t-${randomBytes(12).toString('hex')}`;
  const patternSecret = `ghp_${randomBytes(18).toString('hex')}`;
  const marker = tempDir('factory-activity-');
  const task = {
    ...validTaskResponse(),
    steps: [
      ...validTaskResponse().steps,
      {
        run:
          `i=1; while [ $i -le ${String(LINES)} ]; do echo "line $i"; i=$((i+1)); done; ` +
          `echo "token ${secret} and ${patternSecret}"; touch ${marker}/printed; ` +
          'while :; do sleep 0.2; done',
      },
    ],
  };
  const home = await initializedHome();
  useFakeHarness(home, scriptWith({}, { 'add-sum': [task] }));
  const rt = await startRuntime(home, { env: { GH_TOKEN: secret } });
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  const job = await createJob(rt, repo.id, 'Add sum() live');
  await waitFor(
    () => filesUnder(marker).length > 0,
    20_000,
    'the Harness to print its output and keep running',
  );
  return { rt, job, secret, patternSecret };
}

async function cancel(rt: RunningRuntime, jobId: string): Promise<void> {
  const job = await json<JobBody>(rt.request(`/v1/jobs/${jobId}`));
  const res = await post(rt, `/v1/jobs/${jobId}/cancel`, { expectedVersion: job.version });
  expect(res.status).toBe(200);
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

describe('live activity', () => {
  it('lists the running Attempt with its Job, Task, Harness, model, Repository, tier, heartbeat and ports', async () => {
    const { rt, job } = await runningAttempt();
    const activity = await json<ActivityBody>(rt.request('/v1/activity'));
    const [repo] = await json<{ id: string; name: string }[]>(rt.request('/v1/repositories'));
    const [worktree] = await json<{ portBase: number }[]>(
      rt.request(`/v1/jobs/${job.id}/worktrees`),
    );
    const [attempt] = await json<{ id: string }[]>(rt.request(`/v1/jobs/${job.id}/attempts`));

    expect(activity.attempts).toHaveLength(1);
    const a = activity.attempts[0];
    expect(a).toMatchObject({
      attemptId: attempt?.id,
      n: 1,
      state: 'running',
      job: { id: job.id, title: 'Add sum() live' },
      task: { key: 'add-sum' },
      harness: { id: 'fake' },
      // The Fake reports no model.
      model: null,
      repository: { id: repo?.id, name: repo?.name },
      tier: 'local',
      tierLabel: 'Tier 0 · local guardrail',
      ports: { base: worktree?.portBase, size: 10 },
    });
    // The Task lease's heartbeat, renewed by the runtime.
    expect(a?.heartbeat).not.toBeNull();
    expect(a?.heartbeat?.ageMs).toBeGreaterThanOrEqual(0);
    expect(a?.heartbeat?.ageMs).toBeLessThan(90_000);

    // Once cancelled, nothing is running.
    await cancel(rt, job.id);
    expect((await json<ActivityBody>(rt.request('/v1/activity'))).attempts).toEqual([]);
  });

  it('serves the last 200 lines of the running process, with every secret redacted', async () => {
    const { rt, job, secret, patternSecret } = await runningAttempt();
    const [attempt] = await json<{ id: string }[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    const id = attempt?.id ?? '';

    // The spool itself holds the raw output: the tail is what redacts it.
    const spool = filesUnder(rt.home.dir + '/run').map((f) => readFileSync(f, 'utf8'));
    expect(spool.join('')).toContain(secret);

    const res = await rt.request(`/v1/attempts/${id}/tail`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(patternSecret);
    const tail = JSON.parse(raw) as TailBody;
    expect(tail).toMatchObject({
      attemptId: id,
      running: true,
      process: { kind: 'harness', label: 'developer-1' },
      truncated: true,
    });
    expect(tail.lines).toHaveLength(200);
    expect(tail.lines.at(-1)).toBe('token [REDACTED:GH_TOKEN] and [REDACTED:github_token]');
    expect(tail.lines.at(-2)).toBe(`line ${String(LINES)}`);
    expect(tail.lines[0]).toBe(`line ${String(LINES - 198)}`);

    // An unknown Attempt is a 404; an ended one has no tail (see `factory logs`).
    expect((await rt.request('/v1/attempts/att_nope/tail')).status).toBe(404);
    await cancel(rt, job.id);
    expect(await json<TailBody>(rt.request(`/v1/attempts/${id}/tail`))).toMatchObject({
      running: false,
      process: null,
      lines: [],
    });
  });

  it('factory activity shows the same, redacted, and says when nothing runs', async () => {
    const { rt, job, secret } = await runningAttempt();
    const [repo] = await json<{ name: string }[]>(rt.request('/v1/repositories'));

    const res = await rt.home.cli(['activity']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(job.id);
    expect(res.stdout).toContain('add-sum');
    expect(res.stdout).toContain('Attempt 1');
    expect(res.stdout).toContain('fake');
    expect(res.stdout).toContain('model unknown (not reported by the Harness)');
    expect(res.stdout).toContain(repo?.name);
    expect(res.stdout).toContain('Tier 0 · local guardrail');
    expect(res.stdout).toMatch(/heartbeat \d+s ago/);
    expect(res.stdout).toMatch(/ports \d+–\d+/);
    expect(res.stdout).toContain('token [REDACTED:GH_TOKEN]');
    expect(res.stdout).not.toContain(secret);
    expect(res.stdout.toLowerCase()).not.toContain('sandbox');

    const asJson = await rt.home.cli(['activity', '--json']);
    expect(asJson.code, asJson.stderr).toBe(0);
    const parsed = JSON.parse(asJson.stdout) as {
      attempts: (ActivityBody['attempts'][number] & { tail: TailBody })[];
    };
    expect(parsed.attempts[0]?.job.id).toBe(job.id);
    expect(parsed.attempts[0]?.tail.lines.at(-1)).toContain('[REDACTED:GH_TOKEN]');
    expect(asJson.stdout).not.toContain(secret);

    await cancel(rt, job.id);
    const idle = await rt.home.cli(['activity']);
    expect(idle.code, idle.stderr).toBe(0);
    expect(idle.stdout).toContain('Nothing is running');
  });

  it('the dashboard page shows the running Attempt and its redacted tail, the tier as a guardrail', async () => {
    const { rt, job, secret, patternSecret } = await runningAttempt();
    const dash = await startDashboard(rt.home);
    const [attempt] = await json<{ id: string }[]>(rt.request(`/v1/jobs/${job.id}/attempts`));

    const html = await dash.html('/activity');
    const page = text(html);
    expect(page).toContain('Live activity');
    expect(html).toContain(`href="/jobs/${job.id}"`);
    expect(page).toContain('add-sum');
    expect(page).toContain('Attempt 1');
    expect(page).toContain('unknown (not reported by the Harness)');
    expect(page).toContain('Tier 0 · local guardrail');
    expect(page).toContain('without isolation');
    expect(page).toContain('token [REDACTED:GH_TOKEN] and [REDACTED:github_token]');
    expect(page).toContain(`line ${String(LINES)}`);
    expect(html).not.toContain(secret);
    expect(html).not.toContain(patternSecret);
    expect(page.toLowerCase()).not.toContain('sandbox');
    expect(html).not.toMatch(/<(form|button|input|textarea|select)\b/);
    expect(html).not.toContain(rt.home.token());

    // The tail the page polls: through the dashboard, redacted, GET only.
    const tail = await dash.request(`/api/attempts/${attempt?.id ?? ''}/tail`);
    expect(tail.status).toBe(200);
    const body = await tail.text();
    expect(body).not.toContain(secret);
    expect((JSON.parse(body) as TailBody).lines.at(-1)).toContain('[REDACTED:GH_TOKEN]');
    expect((await dash.request('/api/attempts/bad id/tail')).status).toBe(400);
    expect(
      (await dash.request(`/api/attempts/${attempt?.id ?? ''}/tail`, { method: 'POST' })).status,
    ).toBe(405);

    await cancel(rt, job.id);
    expect(text(await dash.html('/activity'))).toContain('Nothing is running');
  });
});
