/**
 * Lease expiry (#41, ROADMAP exit test B8, ADR-0024). The heartbeat is
 * stopped artificially (`FACTORY_TEST_FREEZE_HEARTBEAT=1`) and leases are made
 * short (`FACTORY_TEST_LEASE_TTL_MS`), so a hung Attempt's lease expires while
 * the runtime is up. The sweeper, on a heartbeat tick, kills the Attempt's
 * process group (pid plus start time checked), marks the Attempt
 * `interrupted`, keeps the Worktree `preserved` and releases the lease and the
 * capacity tokens with that change. The Task gets a Retry only when the
 * process is confirmed dead; otherwise it is blocked with `recovery_uncertain`.
 * No Attempt ever has a second Harness start.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, useFakeHarness } from '../support/factory.js';
import {
  createJob,
  json,
  phaseAConfig,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validTaskResponse } from '../support/scripts.js';
import { factoryGroups, groupAlive, killGroupsOnFinish, waitFor } from '../support/processes.js';
import type { RunningRuntime } from '../support/factory.js';

interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
}

interface TaskBody {
  state: string;
  blocker: { kind: string; reason: string; attemptId: string } | null;
}

const settled = (job: JobBody) =>
  ['completed', 'failed', 'cancelled', 'waiting_human', 'blocked'].includes(job.status);

/** A developer Run that does nothing and hangs (the Worktree stays clean): its lease is what ends it. */
const hung = () => ({ ...validTaskResponse(), steps: [], delayMs: 120_000 });

const FROZEN = { FACTORY_TEST_FREEZE_HEARTBEAT: '1' };

async function frozenRuntime(script: string, ttlMs: number): Promise<RunningRuntime> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home, {
    env: { ...FROZEN, FACTORY_TEST_LEASE_TTL_MS: String(ttlMs) },
  });
  killGroupsOnFinish(rt);
  return rt;
}

const events = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));

/** `harness_run.started` events per Attempt id, for every Role. */
async function harnessStarts(rt: RunningRuntime, jobId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const e of await events(rt, jobId)) {
    if (e.type !== 'harness_run.started' || typeof e.payload['attemptId'] !== 'string') continue;
    const id = e.payload['attemptId'];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The first developer `harness_run.started` of the Job, once there is one. */
async function developerStarted(rt: RunningRuntime, jobId: string): Promise<EventBody> {
  let started: EventBody | undefined;
  await waitFor(
    async () => {
      started = (await events(rt, jobId)).find(
        (e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer',
      );
      return started !== undefined;
    },
    20_000,
    'the developer Run',
  );
  if (started === undefined) throw new Error('unreachable');
  return started;
}

describe('lease expiry (B8)', () => {
  it('interrupts an Attempt whose lease expired, retries it once its process is dead, and never runs one twice', async () => {
    const rt = await frozenRuntime(
      scriptWith({}, { 'add-sum': [hung(), hung(), hung(), hung()] }),
      1_500,
    );
    const repo = await registeredRepo(rt);
    // One Task at a time per Repository: a leaked capacity token would stop the next claim.
    const config = phaseAConfig({ maxRetries: 1, concurrency: { perRepository: 1 } });
    expect((await post(rt, `/v1/projects/${repo.projectId}/config`, config)).status).toBe(200);
    const job = await createJob(rt, repo.id);

    const done = await waitForJob(rt, job.id, settled, 45_000);
    expect(done.status, rt.output()).toBe('blocked');
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'interrupted', 'interrupted'],
      [2, 'retry', 'interrupted', 'interrupted'],
    ]);
    expect(
      Object.fromEntries(await harnessStarts(rt, job.id)),
      'exactly one harness start per Attempt id',
    ).toEqual(Object.fromEntries(attempts.map((a) => [a.id, 1])));

    const interrupted = (await events(rt, job.id)).filter((e) => e.type === 'attempt.interrupted');
    expect(interrupted.map((e) => e.payload)).toEqual([
      expect.objectContaining({ cause: 'lease_expired', process: 'dead', decision: 'retry' }),
      expect.objectContaining({ cause: 'lease_expired', process: 'dead', decision: 'blocked' }),
    ]);
    const [task] = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(task).toMatchObject({
      state: 'blocked',
      blocker: { kind: 'recovery', reason: 'retry_cap_reached', attemptId: attempts[1]?.id },
    });
    const [worktree, more] = await json<{ state: string }[]>(
      rt.request(`/v1/jobs/${job.id}/worktrees`),
    );
    expect(more, 'the Retry reused the Worktree').toBeUndefined();
    expect(worktree?.state).toBe('preserved');
    expect(factoryGroups(rt.home.dir), 'no Harness process is left running').toEqual([]);

    // Every token was released: a second Job on the same Repository (limit 1) can start.
    const second = await createJob(rt, repo.id, 'Add sum() again');
    await developerStarted(rt, second.id);
  }, 60_000);

  it('blocks with recovery_uncertain, and kills nothing, when the process cannot be proven dead', async () => {
    const rt = await frozenRuntime(scriptWith({}, { 'add-sum': [hung()] }), 4_000);
    const repo = await registeredRepo(rt);
    const job = await createJob(rt, repo.id);
    const started = await developerStarted(rt, job.id);
    const pid = started.payload['pid'] as number;
    // Its recorded pid is gone: nothing proves the process is still ours, or dead.
    const pidFile = join(
      rt.home.dir,
      'run',
      String(started.payload['attemptId']),
      'developer-1',
      'pid',
    );
    await waitFor(() => existsSync(pidFile), 5_000, 'the spooled pid');
    rmSync(pidFile);

    const done = await waitForJob(rt, job.id, settled, 30_000);
    expect(done.status, rt.output()).toBe('blocked');
    const [attempt, more] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(more, 'no Retry beside a process that may be alive').toBeUndefined();
    expect(attempt).toMatchObject({ state: 'interrupted', exitReason: 'interrupted' });
    const [task] = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(task?.blocker).toMatchObject({ kind: 'recovery', reason: 'recovery_uncertain' });
    const [worktree] = await json<{ state: string }[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(worktree?.state).toBe('preserved');
    expect(groupAlive(pid), 'a process not proven ours is never signalled').toBe(true);
    expect(Object.fromEntries(await harnessStarts(rt, job.id))).toEqual({
      [String(started.payload['attemptId'])]: 1,
    });
  });

  it.each([
    ['FACTORY_TEST_FREEZE_HEARTBEAT', 'sometimes'],
    ['FACTORY_TEST_LEASE_TTL_MS', 'soon'],
    ['FACTORY_TEST_LEASE_TTL_MS', '0'],
  ])('refuses to start with %s=%s', async (name, value) => {
    const home = await initializedHome();
    await expect(startRuntime(home, { env: { [name]: value } })).rejects.toThrow(
      `unknown ${name}: ${value}`,
    );
  });
});
