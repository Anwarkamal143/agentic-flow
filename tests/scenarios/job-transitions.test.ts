import { describe, expect, it } from 'vitest';
import { startRuntime } from '../support/factory.js';
import {
  createJob,
  json,
  post,
  registeredRepo,
  type EventBody,
  type JobBody,
} from '../support/api.js';

/** The last event for each Stage Run, by Stage id. */
function lastStageEvents(events: EventBody[]): Map<string, EventBody> {
  const last = new Map<string, EventBody>();
  for (const e of events)
    if (e.entityKind === 'stage_run') last.set(String(e.payload['stageId']), e);
  return last;
}

describe('Job transitions', () => {
  it('records each state change of a new Job as an event, in order', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(events.map((e) => e.type)).toEqual([
      'job.created',
      'stage_run.queued',
      'job.status_changed',
    ]);
    expect(events.every((e) => e.jobId === job.id && e.actor === 'user:local')).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events[1]?.payload).toMatchObject({ stageId: 'triage', from: 'pending', to: 'queued' });
    expect(events[2]?.payload).toMatchObject({ from: 'draft', to: 'active' });
  });

  it('cancels a Job seen at its current version; a stale version changes nothing', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);
    const eventsBefore = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));

    const stale = await post(rt, `/v1/jobs/${job.id}/cancel`, {
      expectedVersion: job.version - 1,
    });
    expect(stale.status, 'a stale version is rejected').toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'version_conflict' });
    expect(await json<JobBody>(rt.request(`/v1/jobs/${job.id}`)), 'the Job is unchanged').toEqual(
      job,
    );
    expect(
      await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`)),
      'no event was written',
    ).toEqual(eventsBefore);

    const ok = await post(rt, `/v1/jobs/${job.id}/cancel`, {
      expectedVersion: job.version,
      reason: 'changed my mind',
    });
    expect(ok.status).toBe(200);
    const cancelled = (await ok.json()) as JobBody;
    expect(cancelled.status, 'status is derived from the Stage Runs').toBe('cancelled');
    expect(cancelled.version).toBeGreaterThan(job.version);
    expect(cancelled.stageRuns.map((s) => [s.stageId, s.state])).toEqual([
      ['intake', 'succeeded'],
      ...['triage', 'discovery', 'specification', 'planning', 'execution', 'closure'].map((id) => [
        id,
        'cancelled',
      ]),
    ]);

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const added = events.slice(eventsBefore.length);
    expect(added.map((e) => e.type)).toEqual([
      ...Array<string>(6).fill('stage_run.cancelled'),
      'job.cancelled',
      'job.status_changed',
    ]);
    expect(added.at(-1)?.payload).toMatchObject({ from: 'active', to: 'cancelled' });
    // Every Stage Run's state is the one its last event moved it to.
    const last = lastStageEvents(events);
    for (const run of cancelled.stageRuns.filter((s) => s.stageId !== 'intake')) {
      expect(last.get(run.stageId)?.payload['to'], run.stageId).toBe(run.state);
    }

    const again = await post(rt, `/v1/jobs/${job.id}/cancel`, {
      expectedVersion: cancelled.version,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'job_terminal' });
    expect(
      await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`)),
      'a refused operation writes nothing, not even its version bump',
    ).toEqual(events);
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).version).toBe(cancelled.version);
  });

  it('cancels from the CLI', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);

    const res = await rt.home.cli(['job', 'cancel', job.id, '--reason', 'not needed']);

    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/status: +cancelled/);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(events.find((e) => e.type === 'job.cancelled')?.payload).toEqual({
      reason: 'not needed',
      v: 1,
    });
  });

  it('exposes explicit operations only: there is no way to set a state directly', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);
    for (const [method, path] of [
      ['POST', `/v1/jobs/${job.id}/state`],
      ['PUT', `/v1/jobs/${job.id}`],
      ['PATCH', `/v1/jobs/${job.id}`],
    ] as const) {
      const res = await rt.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).status).toBe('active');
    expect((await rt.request('/v1/jobs/job_missing/events')).status).toBe(404);
  });
});
