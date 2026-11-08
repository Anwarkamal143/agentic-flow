import { describe, expect, it } from 'vitest';
import { startRuntime, type RunningRuntime } from '../support/factory.js';
import {
  createJob,
  json,
  post,
  registeredRepo,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { openStream, type SseMessage } from '../support/sse.js';

function toEvents(messages: SseMessage[]): EventBody[] {
  return messages.map((m) => {
    const event = JSON.parse(m.data) as EventBody;
    expect(m.id, 'the SSE id is the event seq').toBe(String(event.seq));
    return event;
  });
}

async function allEvents(rt: RunningRuntime, query = ''): Promise<EventBody[]> {
  return json<EventBody[]>(rt.request(`/v1/events?after=0${query}`));
}

describe('event stream (SSE)', () => {
  it('A6: resumes from Last-Event-ID with no gaps and no duplicates', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const first = await createJob(rt, repo.id, 'first');

    // Connect, read a few events, disconnect.
    const before = await openStream(rt, '/v1/events/stream?after=0');
    expect(before.status).toBe(200);
    const seen = toEvents([await before.next(), await before.next(), await before.next()]);
    before.close();

    // Generate events while no client is connected.
    const second = await createJob(rt, repo.id, 'second');
    await post(rt, `/v1/projects/${repo.projectId}/config`, { maxAttempts: 4 });
    await post(rt, `/v1/jobs/${first.id}/cancel`, { expectedVersion: first.version });
    const third = await createJob(rt, repo.id, 'third');
    const log = await allEvents(rt);
    const end = log.at(-1)?.seq ?? 0;

    // Reconnect from the last event the client saw.
    const after = await openStream(rt, '/v1/events/stream', {
      lastEventId: String(seen.at(-1)?.seq),
    });
    seen.push(...toEvents(await after.until((m) => m.id === String(end))));

    expect(
      seen.map((e) => e.seq),
      'every event exactly once, in order',
    ).toEqual(log.map((e) => e.seq));
    expect(seen, 'SSE delivers the same events the list API returns').toEqual(log);
    expect(new Set(seen.map((e) => e.jobId))).toEqual(
      new Set([null, first.id, second.id, third.id]),
    );

    // Still connected: a new event arrives live.
    const live = await createJob(rt, repo.id, 'live');
    const [arrived] = toEvents([await after.next()]);
    expect(arrived).toMatchObject({ seq: end + 1, type: 'job.created', jobId: live.id });
  });

  it("streams one Job's events, matching that Job's list-events API", async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id, 'watched');
    await createJob(rt, repo.id, 'other');
    await post(rt, `/v1/jobs/${job.id}/cancel`, { expectedVersion: job.version });

    const list = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const end = String(list.at(-1)?.seq);
    const stream = await openStream(rt, `/v1/events/stream?job=${job.id}&after=0`);
    const streamed = toEvents(await stream.until((m) => m.id === end));

    expect(streamed).toEqual(list);
    expect(list.map((e) => e.type)).toContain('job.cancelled');
    expect((await openStream(rt, '/v1/events/stream?job=job_missing')).status).toBe(404);
  });

  it('starts at the end of the log without Last-Event-ID, and rejects a malformed one', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    await createJob(rt, repo.id, 'old');

    const stream = await openStream(rt, '/v1/events/stream');
    const fresh = await createJob(rt, repo.id, 'new');
    const [firstMessage] = toEvents([await stream.next()]);
    expect(firstMessage).toMatchObject({ type: 'job.created', jobId: fresh.id });

    const bad = await openStream(rt, '/v1/events/stream', { lastEventId: 'abc' });
    expect(bad.status).toBe(400);
    expect((await rt.request('/v1/events/stream', { token: null })).status).toBe(401);
  });

  it('resumes across a runtime restart: the log and the cursor survive', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);
    const stream = await openStream(rt, `/v1/events/stream?after=0`);
    const end = String((await allEvents(rt)).at(-1)?.seq);
    const seen = toEvents(await stream.until((m) => m.id === end));
    await rt.stop();

    const restarted = await startRuntime(rt.home);
    const current = await json<JobBody>(restarted.request(`/v1/jobs/${job.id}`));
    expect(current.status, 'the Job is still there').toBe('active');
    await post(restarted, `/v1/jobs/${job.id}/cancel`, { expectedVersion: current.version });
    const log = await allEvents(restarted);
    const resumed = await openStream(restarted, '/v1/events/stream', {
      lastEventId: String(seen.at(-1)?.seq),
    });
    seen.push(...toEvents(await resumed.until((m) => m.id === String(log.at(-1)?.seq))));

    expect(seen).toEqual(log);
    expect(log.map((e) => e.type)).toEqual(
      expect.arrayContaining(['runtime.stopped', 'runtime.started', 'job.cancelled']),
    );
  });
});
