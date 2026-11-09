/**
 * Crash recovery without double execution (#13, ROADMAP exit test A5,
 * ADR-0012). The runtime is killed (SIGKILL: no shutdown runs) while an
 * Attempt is running and started again on the same home. A Harness process
 * that survived is re-attached; a dead one makes the Attempt `interrupted`,
 * and the Task gets a Retry (not counted as Rework) only if its Worktree is
 * clean. Otherwise the Task gets a recovery Blocker. No second Harness
 * process is ever started for the same Attempt, and stored proposal
 * Artifacts are never regenerated.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validTaskResponse } from '../support/scripts.js';
import { groupAlive, killGroup, killGroupsOnFinish, waitFor } from '../support/processes.js';

interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
}

interface ArtifactBody {
  id: string;
  kind: string;
  contentHash: string;
  stageRunId: string | null;
}

interface TaskBody {
  state: string;
  blocker: { kind: string; reason: string; attemptId: string } | null;
}

const settled = (job: JobBody) =>
  ['completed', 'failed', 'cancelled', 'waiting_human', 'blocked'].includes(job.status);

async function setup(
  script: string,
  config?: Record<string, number>,
): Promise<{ rt: RunningRuntime; jobId: string }> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  if (config !== undefined) {
    const res = await post(rt, `/v1/projects/${repo.projectId}/config`, config);
    expect(res.status).toBe(200);
  }
  const job = await createJob(rt, repo.id);
  return { rt, jobId: job.id };
}

const events = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));

/** Waits for the developer Harness Run of Attempt `n` to start; returns its process group. */
async function developerStarted(rt: RunningRuntime, jobId: string, n = 1): Promise<number> {
  let pid: unknown;
  await waitFor(
    async () => {
      const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
      const attempt = attempts.find((a) => a.n === n);
      const started = (await events(rt, jobId)).find(
        (e) =>
          e.type === 'harness_run.started' &&
          e.payload['role'] === 'developer' &&
          e.payload['attemptId'] === attempt?.id,
      );
      pid = started?.payload['pid'];
      return typeof pid === 'number';
    },
    20_000,
    `the developer Run of Attempt ${String(n)}`,
  );
  return pid as number;
}

/** Developer `harness_run.started` events per Attempt id. */
async function developerStarts(rt: RunningRuntime, jobId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const e of await events(rt, jobId)) {
    if (e.type !== 'harness_run.started' || e.payload['role'] !== 'developer') continue;
    const id = String(e.payload['attemptId']);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** `harness_run.started` events per `<attempt id>/<role>`, for every Harness Run of an Attempt. */
async function harnessStarts(rt: RunningRuntime, jobId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const e of await events(rt, jobId)) {
    const { attemptId, role } = e.payload;
    if (e.type !== 'harness_run.started' || typeof attemptId !== 'string') continue;
    const key = `${attemptId}/${typeof role === 'string' ? role : '?'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const proposals = async (rt: RunningRuntime, jobId: string) =>
  (await json<ArtifactBody[]>(rt.request(`/v1/jobs/${jobId}/artifacts`)))
    .filter((a) => a.stageRunId !== null)
    .map((a) => ({ id: a.id, kind: a.kind, contentHash: a.contentHash }));

const proposalRuns = async (rt: RunningRuntime, jobId: string) =>
  (await events(rt, jobId)).filter(
    (e) => e.type === 'harness_run.started' && e.payload['stageRunId'] !== undefined,
  ).length;

describe('crash recovery (A5)', () => {
  it('re-attaches a Harness process that survived the crash: one start per Attempt, nothing regenerated', async () => {
    // The work is committed, then the Run waits: the runtime dies while it is alive.
    const slow = { ...validTaskResponse(), delayMs: 4_000 };
    const { rt, jobId } = await setup(scriptWith({}, { 'add-sum': [slow] }));
    const group = await developerStarted(rt, jobId);
    const artifactsBefore = await proposals(rt, jobId);
    const proposalRunsBefore = await proposalRuns(rt, jobId);
    expect(artifactsBefore.map((a) => a.kind).sort()).toEqual(
      ['discovery', 'plan', 'spec', 'triage'].sort(),
    );

    await rt.kill();
    expect(groupAlive(group), 'the Harness process outlives the runtime').toBe(true);
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    expect(job.status, again.output()).toBe('completed');

    const [attempt, more] = await json<AttemptBody[]>(again.request(`/v1/jobs/${jobId}/attempts`));
    expect(more, 'no second Attempt').toBeUndefined();
    expect(attempt).toMatchObject({ n: 1, cause: 'initial', state: 'passed' });
    expect(
      [...(await developerStarts(again, jobId)).values()],
      'exactly one developer harness start per Attempt',
    ).toEqual([1]);
    expect(
      Object.fromEntries(await harnessStarts(again, jobId)),
      'no Harness Run of the Attempt, of either Role, was started twice',
    ).toEqual({ [`${attempt?.id ?? ''}/developer`]: 1, [`${attempt?.id ?? ''}/reviewer`]: 1 });
    const reattached = (await events(again, jobId)).find(
      (e) => e.type === 'harness_run.reattached',
    );
    expect(reattached?.payload).toMatchObject({ attemptId: attempt?.id, attached: true });

    expect(await proposals(again, jobId), 'the same proposal Artifacts').toEqual(artifactsBefore);
    expect(await proposalRuns(again, jobId), 'no new proposal Harness Run').toBe(
      proposalRunsBefore,
    );
    expect(
      readdirSafe(join(rt.home.dir, 'run')),
      'no spool (raw output) is left in the factory home',
    ).toEqual([]);
  });

  it('marks the Attempt interrupted when its process died, and retries it in the clean Worktree', async () => {
    const doomed = { ...validTaskResponse(), delayMs: 60_000 };
    const { rt, jobId } = await setup(scriptWith({}, { 'add-sum': [doomed, validTaskResponse()] }));
    const group = await developerStarted(rt, jobId);
    await rt.kill();
    killGroup(group); // the machine lost the Harness too
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    expect(job.status, again.output()).toBe('completed');

    const attempts = await json<AttemptBody[]>(again.request(`/v1/jobs/${jobId}/attempts`));
    expect(attempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'interrupted', 'interrupted'],
      [2, 'retry', 'passed', 'completed'],
    ]);
    expect([...(await developerStarts(again, jobId)).values()]).toEqual([1, 1]);
  });

  it('does not count a Retry toward the Rework cap', async () => {
    const doomed = { ...validTaskResponse(), delayMs: 60_000 };
    // The Retry's work fails the factory's test command; the Rework fixes it.
    const failing = {
      ...validTaskResponse(),
      steps: [
        { write: { path: 'src/math.ts', content: 'export {};\n' } },
        { commit: 'Stub math.ts' },
      ],
    };
    // maxAttempts 2: the initial Attempt and one Rework. The Retry in between is free.
    const { rt, jobId } = await setup(
      scriptWith({}, { 'add-sum': [doomed, failing, validTaskResponse()] }),
      { maxAttempts: 2 },
    );
    const group = await developerStarted(rt, jobId);
    await rt.kill();
    killGroup(group);
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    const attempts = await json<AttemptBody[]>(again.request(`/v1/jobs/${jobId}/attempts`));
    expect(job.status, JSON.stringify(attempts)).toBe('completed');
    expect(attempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'interrupted', 'interrupted'],
      [2, 'retry', 'failed', 'gates_failed'],
      [3, 'rework', 'passed', 'completed'],
    ]);
  });

  it('blocks with a recovery Blocker, and no Retry, when the dead Attempt left uncommitted changes', async () => {
    const dirty = {
      ...validTaskResponse(),
      steps: [{ write: { path: 'src/math.ts', content: 'half done\n' } }],
      delayMs: 60_000,
    };
    const { rt, jobId } = await setup(scriptWith({}, { 'add-sum': [dirty] }));
    const group = await developerStarted(rt, jobId);
    const [active] = await json<{ path: string }[]>(rt.request(`/v1/jobs/${jobId}/worktrees`));
    const file = join(active?.path ?? '', 'src/math.ts');
    await waitFor(
      () => existsSync(file) && readFileSync(file, 'utf8') === 'half done\n',
      20_000,
      'the uncommitted write',
    );
    await rt.kill();
    killGroup(group);
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    expect(job.status, again.output()).toBe('blocked');

    const [attempt, more] = await json<AttemptBody[]>(again.request(`/v1/jobs/${jobId}/attempts`));
    expect(more, 'no Retry').toBeUndefined();
    expect(attempt).toMatchObject({ state: 'interrupted', exitReason: 'interrupted' });
    const [task] = await json<TaskBody[]>(again.request(`/v1/jobs/${jobId}/tasks`));
    expect(task).toMatchObject({
      state: 'blocked',
      blocker: { kind: 'recovery', reason: 'recovery_uncertain', attemptId: attempt?.id },
    });
    const [worktree] = await json<{ path: string; state: string }[]>(
      again.request(`/v1/jobs/${jobId}/worktrees`),
    );
    expect(worktree?.state).toBe('preserved');
    expect(
      readFileSync(join(worktree?.path ?? '', 'src/math.ts'), 'utf8'),
      'the uncommitted work is kept',
    ).toBe('half done\n');
    expect([...(await developerStarts(again, jobId)).values()]).toEqual([1]);
  });

  it('blocks with retry_cap_reached when the Task has no Retry left', async () => {
    const doomed = { ...validTaskResponse(), delayMs: 60_000 };
    const { rt, jobId } = await setup(scriptWith({}, { 'add-sum': [doomed] }), { maxRetries: 0 });
    const group = await developerStarted(rt, jobId);
    await rt.kill();
    killGroup(group);
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    expect(job.status, again.output()).toBe('blocked');
    const [attempt, more] = await json<AttemptBody[]>(again.request(`/v1/jobs/${jobId}/attempts`));
    expect(more, 'no Retry').toBeUndefined();
    expect(attempt?.state).toBe('interrupted');
    const [task] = await json<TaskBody[]>(again.request(`/v1/jobs/${jobId}/tasks`));
    expect(task?.blocker).toMatchObject({ kind: 'recovery', reason: 'retry_cap_reached' });
  });

  it('quarantines a Worktree whose state is unknown after the crash, and never deletes it', async () => {
    const doomed = { ...validTaskResponse(), delayMs: 60_000 };
    const { rt, jobId } = await setup(scriptWith({}, { 'add-sum': [doomed] }));
    const group = await developerStarted(rt, jobId);
    const [active] = await json<{ path: string }[]>(rt.request(`/v1/jobs/${jobId}/worktrees`));
    await rt.kill();
    killGroup(group);
    // git can no longer read it: its link to the Factory Clone is gone.
    rmSync(join(active?.path ?? '', '.git'), { force: true });
    const again = await startRuntime(rt.home);
    const job = await waitForJob(again, jobId, settled, 30_000);
    expect(job.status, again.output()).toBe('blocked');
    const [worktree] = await json<{ path: string; state: string }[]>(
      again.request(`/v1/jobs/${jobId}/worktrees`),
    );
    expect(worktree?.state).toBe('quarantined');
    expect(existsSync(join(worktree?.path ?? '', 'src/math.ts')), 'its files are kept').toBe(true);
    const [task] = await json<TaskBody[]>(again.request(`/v1/jobs/${jobId}/tasks`));
    expect(task?.blocker).toMatchObject({ kind: 'recovery', reason: 'recovery_uncertain' });
    expect([...(await developerStarts(again, jobId)).values()], 'no Retry').toEqual([1]);
  });

  it('resumes a closure cut short after its Delivery Report: no second report, Worktrees removed', async () => {
    const home = await initializedHome();
    useFakeHarness(home, scriptWith({}));
    const rt = await startRuntime(home, { env: { FACTORY_TEST_CRASH_AT: 'closure.after_report' } });
    killGroupsOnFinish(rt);
    const repo = await registeredRepo(rt);
    const created = await createJob(rt, repo.id);
    await rt.exited; // it killed itself once the report was recorded

    const again = await startRuntime(home);
    const job = await waitForJob(again, created.id, settled, 30_000);
    expect(job.status, again.output()).toBe('completed');
    const reports = (
      await json<ArtifactBody[]>(again.request(`/v1/jobs/${created.id}/artifacts`))
    ).filter((a) => a.kind === 'report');
    expect(reports, 'exactly one Delivery Report').toHaveLength(1);
    const worktrees = await json<{ path: string; state: string }[]>(
      again.request(`/v1/jobs/${created.id}/worktrees`),
    );
    expect(worktrees.map((w) => w.state)).toEqual(['removed']);
    expect(existsSync(worktrees[0]?.path ?? '')).toBe(false);
  });
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
