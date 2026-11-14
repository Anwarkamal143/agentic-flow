/**
 * Secret values never reach history (#11). A secret printed by the Fake
 * Harness and by a verification command is redacted before it is stored or
 * streamed: it is absent from the logs API, every Artifact, the events list,
 * the SSE stream, the runtime's log and every file in the factory home.
 * `factory logs <job>` shows the (redacted) Harness and verification output.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, tinyTsRepo, useFakeHarness } from '../support/factory.js';
import {
  json,
  post,
  waitForJob,
  type EventBody,
  type JobBody,
  skipPlanApproval,
} from '../support/api.js';
import { filesUnder } from '../support/files.js';
import { openStream } from '../support/sse.js';
import {
  scriptWith,
  validOutput,
  validReviewResponse,
  validTaskResponse,
} from '../support/scripts.js';

interface LogEntryBody {
  artifactId: string;
  attemptId: string;
  attemptN: number;
  taskKey: string;
  content: {
    source: 'harness' | 'verification';
    role?: string;
    key?: string;
    output: string;
  };
}

describe('redaction', () => {
  it('a secret printed by the Harness and by a verification command is never stored or streamed', async () => {
    const secret = `s3cr3t-${randomBytes(12).toString('hex')}`;
    const patternSecret = `ghp_${randomBytes(18).toString('hex')}`;

    const triage = { ...validOutput('triage'), summary: `Add sum(); debug token ${secret}` };
    const planning = validOutput('planning') as { tasks: { verification: unknown[] }[] };
    planning.tasks[0]?.verification.push({
      key: 'leak',
      command: 'cat test/fixture.txt',
      required: true,
    });
    const task = validTaskResponse();
    task.steps.push(
      { write: { path: 'test/fixture.txt', content: `fixture token ${secret}\n` } },
      { commit: 'Add a test fixture' },
      { run: `echo "harness sees ${secret} and ${patternSecret}"` },
    );
    task.result['summary'] = `Added sum(). Token: ${secret}`;
    const review = validReviewResponse();
    (review.output as Record<string, unknown>)['summary'] = `Approved; it printed ${secret}`;

    const home = await initializedHome();
    useFakeHarness(
      home,
      scriptWith(
        { triage: [{ output: triage }], planning: [{ output: planning }] },
        { 'add-sum': [task] },
        { 'add-sum': [review] },
      ),
    );
    const rt = await startRuntime(home, { env: { GH_TOKEN: secret } });
    const added = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
    expect(added.code, added.stderr).toBe(0);
    const [repo] = await json<[{ id: string; projectId: string }]>(rt.request('/v1/repositories'));
    await skipPlanApproval(rt, repo.projectId);
    const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add sum()' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as JobBody;
    const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 20_000);
    expect(job.status).toBe('completed');

    // The logs API: the Harness and verification output, redacted.
    const logs = await json<LogEntryBody[]>(rt.request(`/v1/jobs/${job.id}/logs`));
    const developer = logs.find((l) => l.content.role === 'developer');
    const leak = logs.find((l) => l.content.key === 'leak');
    expect(developer?.content.output).toContain(
      'harness sees [REDACTED:GH_TOKEN] and [REDACTED:github_token]',
    );
    expect(leak?.content.output).toContain('fixture token [REDACTED:GH_TOKEN]');
    expect(
      logs.map((l) => [l.taskKey, l.attemptN, l.content.source, l.content.role ?? l.content.key]),
    ).toEqual([
      ['add-sum', 1, 'harness', 'developer'],
      ['add-sum', 1, 'verification', 'test'],
      ['add-sum', 1, 'verification', 'typecheck'],
      ['add-sum', 1, 'verification', 'leak'],
      ['add-sum', 1, 'harness', 'reviewer'],
    ]);

    // Nowhere else either: Artifacts, events, the SSE stream, the runtime's output.
    const seen: string[] = [JSON.stringify(logs), rt.output()];
    const artifacts = await json<{ id: string }[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    for (const a of artifacts)
      seen.push(await (await rt.request(`/v1/artifacts/${a.id}/content`)).text());
    const events = await json<EventBody[]>(rt.request(`/v1/events?limit=1000`));
    seen.push(JSON.stringify(events));
    const last = events.filter((e) => e.jobId === job.id).at(-1);
    const stream = await openStream(rt, `/v1/events/stream?job=${job.id}&after=0`);
    const streamed = await stream.until((m) => m.id === String(last?.seq));
    seen.push(JSON.stringify(streamed));
    for (const path of [
      '/v1/jobs',
      `/v1/jobs/${job.id}/attempts`,
      `/v1/jobs/${job.id}/reviews`,
      `/v1/jobs/${job.id}/tasks`,
    ]) {
      seen.push(await (await rt.request(path)).text());
    }
    for (const text of seen) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(patternSecret);
    }
    expect(seen.join('\n')).toContain('[REDACTED:GH_TOKEN]');

    // The CLI shows the same redacted output.
    const cli = await rt.home.cli(['logs', job.id]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('developer Harness Run');
    expect(cli.stdout).toContain('harness sees [REDACTED:GH_TOKEN]');
    expect(cli.stdout).toContain('verification leak: cat test/fixture.txt');
    expect(cli.stdout).toContain('fixture token [REDACTED:GH_TOKEN]');
    expect(cli.stdout).not.toContain(secret);

    // No unredacted copy is stored anywhere in the factory home (database, WAL, Artifacts, logs).
    expect(await rt.stop()).toBe(0);
    for (const file of filesUnder(home.dir)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(secret), file).toBe(false);
      expect(bytes.includes(patternSecret), file).toBe(false);
    }
  });

  it('factory logs refuses an unknown Job', async () => {
    const rt = await startRuntime();
    const cli = await rt.home.cli(['logs', 'job_missing']);
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toContain('job_missing');
  });
});
