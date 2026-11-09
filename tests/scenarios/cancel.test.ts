/**
 * Cancelling a Job (#12, PRODUCT_SPEC §12). Cancellation stops the running
 * Harness's whole process group, gracefully first (SIGTERM) and then forcibly
 * (SIGKILL after a grace period), so no process of it survives. The Attempt,
 * the Task and the Job record it as events, and the Worktree is preserved.
 */
import { existsSync, readFileSync } from 'node:fs';
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
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput, validTaskResponse } from '../support/scripts.js';
import { groupAlive, killGroupsOnFinish, waitFor } from '../support/processes.js';

interface AttemptBody {
  id: string;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
}

interface WorktreeBody {
  id: string;
  path: string;
  state: string;
}

async function runtimeWith(script: string): Promise<{ rt: RunningRuntime; repoId: string }> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  return { rt, repoId: repo.id };
}

const events = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));

describe('factory job cancel', () => {
  it('stops the Harness process group with SIGTERM, then SIGKILL, and preserves the Worktree', async () => {
    const dir = tempDir('factory-signals-');
    // A step that survives SIGTERM: it notes the signal and keeps going, so only SIGKILL stops it.
    const stubborn = {
      ...validTaskResponse(),
      steps: [
        ...validTaskResponse().steps,
        {
          run: `echo $$ > ${dir}/step.pid; trap 'echo TERM >> ${dir}/signals' TERM; while :; do sleep 0.2; done`,
        },
      ],
    };
    const { rt, repoId } = await runtimeWith(scriptWith({}, { 'add-sum': [stubborn] }));
    const created = await createJob(rt, repoId);
    await waitFor(() => existsSync(join(dir, 'step.pid')), 20_000, 'the step to start');
    const stepPid = Number(readFileSync(join(dir, 'step.pid'), 'utf8'));
    const started = (await events(rt, created.id)).find(
      (e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer',
    );
    const group = started?.payload['pid'];
    expect(typeof group, 'the Harness Run records its process group').toBe('number');

    const t0 = Date.now();
    const res = await rt.home.cli(['job', 'cancel', created.id, '--reason', 'no longer needed']);
    const took = Date.now() - t0;
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`Cancelled Job ${created.id}`);

    expect(readFileSync(join(dir, 'signals'), 'utf8'), 'SIGTERM came first').toContain('TERM');
    expect(took, 'SIGKILL only after the grace period').toBeGreaterThanOrEqual(4_500);
    expect(groupAlive(group as number), 'no process of the group is left').toBe(false);
    expect(groupAlive(stepPid), 'the stubborn step is gone').toBe(false);

    const job = await json<JobBody>(rt.request(`/v1/jobs/${created.id}`));
    expect(job.status).toBe('cancelled');
    expect(job.stageRuns.find((s) => s.stageId === 'execution')?.state).toBe('cancelled');
    const [attempt, more] = await json<AttemptBody[]>(
      rt.request(`/v1/jobs/${created.id}/attempts`),
    );
    expect(more).toBeUndefined();
    expect(attempt).toMatchObject({ state: 'cancelled', exitReason: 'cancelled' });
    const [task] = await json<{ state: string }[]>(rt.request(`/v1/jobs/${created.id}/tasks`));
    expect(task?.state).toBe('cancelled');
    const [worktree] = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`));
    expect(worktree?.state).toBe('preserved');
    expect(existsSync(worktree?.path ?? ''), 'the Worktree is still on disk').toBe(true);

    const types = (await events(rt, created.id)).map((e) => e.type);
    for (const type of [
      'job.cancelled',
      'attempt.cancelled',
      'task.cancelled',
      'worktree.preserved',
    ]) {
      expect(types, type).toContain(type);
    }
    const finished = (await events(rt, created.id)).find(
      (e) => e.type === 'harness_run.finished' && e.payload['role'] === 'developer',
    );
    expect(finished?.payload['exit']).toEqual({ kind: 'cancelled' });
  });

  it('cancels a Job whose proposal Stage is running', async () => {
    const slow = { output: validOutput('triage'), delayMs: 60_000 };
    const { rt, repoId } = await runtimeWith(scriptWith({ triage: [slow] }));
    const created = await createJob(rt, repoId);
    const running = await waitForJob(rt, created.id, (j) =>
      j.stageRuns.some((s) => s.stageId === 'triage' && s.state === 'running'),
    );
    const res = await rt.home.cli(['job', 'cancel', running.id]);
    expect(res.code, res.stderr).toBe(0);
    const job = await json<JobBody>(rt.request(`/v1/jobs/${created.id}`));
    expect(job.status).toBe('cancelled');
    expect(job.stageRuns.find((s) => s.stageId === 'triage')?.state).toBe('cancelled');
    const finished = (await events(rt, created.id)).find((e) => e.type === 'harness_run.finished');
    expect(finished?.payload['exit']).toEqual({ kind: 'cancelled' });
    // Nothing is recorded for the cancelled Stage after its Run ended.
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await json<JobBody>(rt.request(`/v1/jobs/${created.id}`))).stageRuns).toEqual(
      job.stageRuns,
    );
  });
});
