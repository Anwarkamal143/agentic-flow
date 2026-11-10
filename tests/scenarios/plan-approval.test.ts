/**
 * `plan_approval` and the Inbox (ADR-0016): every new Plan waits for the
 * operator, who approves it (execution starts) or rejects it (the Job ends
 * `rejected`, every Artifact kept: **B6**). Decisions name the item's version
 * and subject; a stale one is refused.
 */
import { createHash } from 'node:crypto';
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
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { VALID_SCRIPT } from '../support/scripts.js';

interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  state: string;
  deferred: boolean;
  version: number;
  options: { id: string }[];
  decision: { option: string; comment: string | null } | null;
  decidedBy: string | null;
  expiresPolicy: string;
}

interface ArtifactBody {
  id: string;
  kind: string;
  contentHash: string;
}

async function waitingForPlan(): Promise<{ rt: RunningRuntime; job: JobBody; item: ItemBody }> {
  const home = await initializedHome();
  useFakeHarness(home, VALID_SCRIPT);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt, { planApproval: 'required' });
  const created = await createJob(rt, repo.id);
  const job = await waitForJob(rt, created.id, jobSettled);
  const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
  expect(items).toHaveLength(1);
  return { rt, job, item: items[0] as ItemBody };
}

const plan = async (rt: RunningRuntime, jobId: string) =>
  (await json<ArtifactBody[]>(rt.request(`/v1/jobs/${jobId}/artifacts`))).find(
    (a) => a.kind === 'plan',
  ) as ArtifactBody;

describe('plan_approval', () => {
  it('stops every new Plan at plan_approval, waiting on a plan Inbox Item', async () => {
    const { rt, job, item } = await waitingForPlan();

    expect(job).toMatchObject({ status: 'waiting_human', currentStage: 'plan_approval' });
    expect(job.stageRuns.map((s) => [s.stageId, s.state]).slice(4)).toEqual([
      ['planning', 'succeeded'],
      ['plan_approval', 'waiting_human'],
      ['execution', 'pending'],
      ['closure', 'pending'],
    ]);
    expect(item).toMatchObject({
      jobId: job.id,
      kind: 'plan',
      stageId: 'plan_approval',
      subjectRef: (await plan(rt, job.id)).id,
      state: 'open',
      deferred: false,
      version: 0,
      expiresPolicy: 'remain_pending',
      options: [{ id: 'approve' }, { id: 'reject' }, { id: 'request_changes' }],
    });
    // No Task runs while the Plan waits.
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/attempts`))).toEqual([]);
    const tasks = await json<{ state: string }[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.map((t) => t.state)).toEqual(['ready']);
  });

  it('factory plan show prints the Plan with its derived decision points and estimate', async () => {
    const { rt, job, item } = await waitingForPlan();

    const show = await rt.home.cli(['plan', 'show', job.id]);
    expect(show.code, show.stderr).toBe(0);
    for (const text of [
      `Plan ${item.subjectRef}`,
      'Specification:',
      'AC-01 mandatory sum(2, 3) returns 5.',
      'Repositories: tiny-ts',
      'Tasks (DAG):',
      'add-sum',
      'wave 1: add-sum',
      'triage: low',
      'plan_approval (plan)',
      'execution (blocker)',
      // 1 Task: maxAttempts 3 + maxRetries 2 + maxQuestions 3
      'attempts: 1–8 (bounds, not a forecast)',
      'cost:     unknown (the configured Harness reports no cost)',
      `factory inbox decide ${item.id} approve|reject --expect-version 0`,
    ]) {
      expect(show.stdout).toContain(text);
    }
  });

  it('approve: execution starts and the Job completes', async () => {
    const { rt, job, item } = await waitingForPlan();

    const show = await rt.home.cli(['inbox', 'show', item.id]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/version: +0/);

    const res = await post(rt, `/v1/jobs/${job.id}/plan/approve`, {
      expectedVersion: 0,
      planArtifactId: item.subjectRef,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'decided',
      version: 1,
      decidedBy: 'user:local',
      decision: { option: 'approve', comment: null },
    });

    const done = await waitForJob(rt, job.id, jobSettled, 20_000);
    expect(done.status).toBe('completed');
    expect(done.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe('succeeded');
    expect(await json<unknown[]>(rt.request('/v1/inbox'))).toEqual([]);
    const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
    expect(all.map((i) => [i.id, i.state])).toEqual([[item.id, 'decided']]);
  });

  it('refuses a decision on a stale version or another subject, and an unknown option', async () => {
    const { rt, job, item } = await waitingForPlan();

    const stale = await post(rt, `/v1/jobs/${job.id}/plan/approve`, {
      expectedVersion: 7,
      planArtifactId: item.subjectRef,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'version_conflict' });

    const other = await post(rt, `/v1/jobs/${job.id}/plan/approve`, {
      expectedVersion: 0,
      planArtifactId: 'art_another_plan',
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'subject_mismatch' });

    const option = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: 0,
      subjectRef: item.subjectRef,
      option: 'replan',
    });
    expect(option.status).toBe(400);

    const cli = await rt.home.cli(['inbox', 'decide', item.id, 'approve', '--expect-version', '3']);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('version_conflict');
    expect(cli.stderr).toContain('version 0, not 3');

    // Nothing changed.
    const now = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
    expect(now).toMatchObject({ state: 'open', version: 0 });
    const still = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(still.status).toBe('waiting_human');
  });

  it('B6: reject ends the Job rejected, keeps every Artifact, and runs nothing', async () => {
    const { rt, job, item } = await waitingForPlan();
    const before = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));

    const res = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'reject',
      '--expect-version',
      '0',
      '--comment',
      'not now',
    ]);
    expect(res.code, res.stderr).toBe(0);

    const rejected = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(rejected).toMatchObject({ status: 'rejected', currentStage: 'plan_approval' });
    expect(rejected.stageRuns.map((s) => [s.stageId, s.state]).slice(4)).toEqual([
      ['planning', 'succeeded'],
      ['plan_approval', 'rejected'],
      ['execution', 'pending'],
      ['closure', 'pending'],
    ]);
    const tasks = await json<{ state: string }[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.map((t) => t.state)).toEqual(['cancelled']);
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/attempts`))).toEqual([]);

    const after = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    expect(after).toEqual(before);
    expect(after.map((a) => a.kind)).toEqual(['triage', 'discovery', 'spec', 'plan']);
    for (const artifact of after) {
      const bytes = Buffer.from(
        await (await rt.request(`/v1/artifacts/${artifact.id}/content`)).arrayBuffer(),
      );
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
        artifact.contentHash,
      );
    }

    const decided = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
    expect(decided).toMatchObject({
      state: 'decided',
      decision: { option: 'reject', comment: 'not now' },
    });
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['approval.opened', 'approval.decided', 'stage_run.rejected']),
    );
    // Terminal: a cancel is refused.
    const cancel = await post(rt, `/v1/jobs/${job.id}/cancel`, {
      expectedVersion: rejected.version,
    });
    expect(cancel.status).toBe(409);
  });

  it('defer hides an item from the default Inbox view until undefer', async () => {
    const { rt, item } = await waitingForPlan();

    const defer = await rt.home.cli(['inbox', 'defer', item.id]);
    expect(defer.code, defer.stderr).toBe(0);
    expect(await json<unknown[]>(rt.request('/v1/inbox'))).toEqual([]);
    const all = await rt.home.cli(['inbox', '--all']);
    expect(all.stdout).toContain(item.id);
    expect(all.stdout).toContain('open (deferred)');

    const undefer = await rt.home.cli(['inbox', 'undefer', item.id]);
    expect(undefer.code, undefer.stderr).toBe(0);
    const list = await rt.home.cli(['inbox']);
    expect(list.stdout).toContain(item.id);
    expect(list.stdout).toContain('v2');
  });

  it('cancelling the Job cancels its open Inbox Item', async () => {
    const { rt, job, item } = await waitingForPlan();
    const res = await rt.home.cli(['job', 'cancel', job.id]);
    expect(res.code, res.stderr).toBe(0);
    expect(await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`))).toMatchObject({
      state: 'cancelled',
    });
  });

  it('planApproval: skip ends the Stage Run skipped, with the reason in its event', async () => {
    const home = await initializedHome();
    useFakeHarness(home, VALID_SCRIPT);
    const rt = await startRuntime(home);
    const repo = await registeredRepo(rt, { planApproval: 'skip' });
    const created = await createJob(rt, repo.id);
    expect(created.effectiveConfig).toMatchObject({
      planApproval: { value: 'skip', source: 'project' },
    });

    const job = await waitForJob(rt, created.id, jobSettled, 20_000);
    expect(job.status).toBe('completed');
    expect(job.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe('skipped');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(events.find((e) => e.type === 'stage_run.skipped')?.payload).toMatchObject({
      stageId: 'plan_approval',
      reason: 'planApproval: skip (from project)',
    });
    expect(await json<unknown[]>(rt.request('/v1/inbox?all=true'))).toEqual([]);
  });
});
