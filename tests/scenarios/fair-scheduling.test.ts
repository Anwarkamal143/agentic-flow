/**
 * Fair scheduling across Projects (#99, ROADMAP exit test D2, ADR-0050,
 * ADR-0058): five Jobs in three Projects under `concurrency.perProjectJobs: 1`,
 * with the Fake Harness at fixed durations. Every Project makes progress: each
 * has a Job executing before any Project starts executing its second, and the
 * longest mean ready-wait of any Project is at most twice the shortest.
 * Asserted through the CLI and the runtime API (the event log) only.
 */
import { describe, expect, it } from 'vitest';
import { createProject, json, jobSettled, post, waitForJob, type JobBody } from '../support/api.js';
import {
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import { scriptWith, validOutput, validTaskResponse } from '../support/scripts.js';

const PROPOSAL_STAGES = ['triage', 'discovery', 'specification', 'planning'];
/** Fixed Fake Harness durations: each proposal Stage, and the one developer Attempt. */
const PROPOSAL_MS = 250;
const TASK_MS = 1_000;

interface TimedEvent {
  seq: number;
  ts: string;
  type: string;
  entityKind: string;
  entityId: string;
  payload: Record<string, unknown>;
}

async function cliOk(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

/** Registers a fresh `tiny-ts` in a new Project `name`; returns the Repository id. */
async function projectWithRepo(rt: RunningRuntime, name: string): Promise<string> {
  await createProject(rt, name);
  await cliOk(rt, ['repo', 'add', tinyTsRepo(), '--project', name, '--yes']);
  const repos = await json<{ id: string; projectId: string }[]>(rt.request('/v1/repositories'));
  const projects = await json<{ id: string; name: string }[]>(rt.request('/v1/projects'));
  const projectId = projects.find((p) => p.name === name)?.id;
  const repo = repos.find((r) => r.projectId === projectId);
  if (repo === undefined) throw new Error(`no Repository in ${name}`);
  return repo.id;
}

/** Each claim of the Job's work, and how long it waited to be claimed after it became ready. */
function readyWaits(events: TimedEvent[]): number[] {
  const waits: number[] = [];
  const readySince = new Map<string, number>();
  for (const e of events) {
    const at = Date.parse(e.ts);
    const stageId = String(e.payload['stageId'] ?? '');
    if (e.entityKind === 'stage_run' && PROPOSAL_STAGES.includes(stageId)) {
      if (e.type === 'stage_run.queued') readySince.set(e.entityId, at);
      if (e.type === 'stage_run.running') {
        const since = readySince.get(e.entityId);
        if (since !== undefined) waits.push(at - since);
      }
    }
    if (e.entityKind === 'task') {
      if (e.type === 'task.created' || e.type === 'task.ready') readySince.set(e.entityId, at);
      if (e.type === 'task.claimed') {
        const since = readySince.get(e.entityId);
        if (since !== undefined) waits.push(at - since);
      }
    }
  }
  return waits;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('D2: five Jobs across three Projects, perProjectJobs 1', { timeout: 90_000 }, () => {
  it('runs a Job of every Project before any Project its second, with no Project starved', async () => {
    const home = await initializedHome();
    const timed = <T extends object>(response: T) => ({ ...response, delayMs: PROPOSAL_MS });
    useFakeHarness(
      home,
      scriptWith(
        Object.fromEntries(
          PROPOSAL_STAGES.map((stage) => [stage, [timed({ output: validOutput(stage) })]]),
        ),
        { 'add-sum': [{ ...validTaskResponse(), delayMs: TASK_MS }] },
      ),
    );
    const rt = await startRuntime(home);

    // The limit and the plan-approval skip are set at the Factory Level, so every Project inherits them.
    const set = await cliOk(rt, ['config', 'set', 'concurrency.perProjectJobs', '1']);
    expect(set).toContain('concurrency.perProjectJobs = 1');
    expect(set).toContain('from their next claim');
    await cliOk(rt, ['config', 'set', 'planApproval', 'skip']);
    const show = await cliOk(rt, ['config', 'show']);
    expect(show).toMatch(/concurrency\.perProjectJobs +1 +\(factory\)/);
    expect(show).toMatch(/scheduling\.agingStep +0\.5 +\(default\)/);
    expect(show).toMatch(/scheduling\.agingIntervalSeconds +60 +\(default\)/);

    const repos = {
      alpha: await projectWithRepo(rt, 'alpha'),
      beta: await projectWithRepo(rt, 'beta'),
      gamma: await projectWithRepo(rt, 'gamma'),
    };
    // The worst order for first-come scheduling: a Project's Jobs back to back.
    const order: (keyof typeof repos)[] = ['alpha', 'alpha', 'beta', 'beta', 'gamma'];
    const jobs: { project: string; id: string }[] = [];
    for (const [i, project] of order.entries()) {
      const res = await post(rt, '/v1/jobs', {
        repositoryId: repos[project],
        title: `Job ${String(i + 1)} of ${project}`,
      });
      expect(res.status, 'create Job').toBe(201);
      jobs.push({ project, id: ((await res.json()) as JobBody).id });
    }

    // Every Project makes progress: every Job completes.
    for (const job of jobs) {
      const settled = await waitForJob(rt, job.id, jobSettled, 80_000);
      expect(settled.status, `${job.project} ${job.id}`).toBe('completed');
    }

    const logs = new Map<string, TimedEvent[]>();
    for (const job of jobs) {
      logs.set(job.id, await json<TimedEvent[]>(rt.request(`/v1/jobs/${job.id}/events`)));
    }
    // When each Job started executing: its first Task claim (global order by seq).
    const started = jobs
      .map((job) => ({
        ...job,
        seq: logs.get(job.id)?.find((e) => e.type === 'task.claimed')?.seq ?? Number.NaN,
      }))
      .sort((a, b) => a.seq - b.seq);
    expect(started.every((s) => Number.isFinite(s.seq))).toBe(true);
    // Each Project has a Job executing before any Project starts executing its second.
    expect(new Set(started.slice(0, 3).map((s) => s.project))).toEqual(
      new Set(['alpha', 'beta', 'gamma']),
    );
    // No Project starves: the longest mean ready-wait is at most twice the shortest.
    const byProject = new Map<string, number[]>();
    for (const job of jobs) {
      const waits = readyWaits(logs.get(job.id) ?? []);
      byProject.set(job.project, [...(byProject.get(job.project) ?? []), ...waits]);
    }
    const means = [...byProject.entries()].map(([project, waits]) => ({
      project,
      mean: mean(waits),
    }));
    const longest = Math.max(...means.map((m) => m.mean));
    const shortest = Math.min(...means.map((m) => m.mean));
    expect(shortest, JSON.stringify(means)).toBeGreaterThan(0);
    expect(longest, JSON.stringify(means)).toBeLessThanOrEqual(2 * shortest);
  });
});

describe('a Job waiting on a human', { timeout: 60_000 }, () => {
  it('holds no Project slot: the next Job of a Project limited to one goes on', async () => {
    const home = await initializedHome();
    useFakeHarness(home, scriptWith({}));
    const rt = await startRuntime(home);
    const repositoryId = await projectWithRepo(rt, 'solo');
    const set = await cliOk(rt, [
      'project',
      'config',
      'set',
      'solo',
      'concurrency.perProjectJobs',
      '1',
    ]);
    expect(set).toContain('solo: concurrency.perProjectJobs = 1');
    expect(set).toContain('from their next claim');

    // Plan approval is required (the default), so each Job stops at plan_approval for a human.
    const atApproval = (job: JobBody) =>
      job.stageRuns.some((s) => s.stageId === 'plan_approval' && s.state === 'waiting_human');
    const create = async (title: string) => {
      const res = await post(rt, '/v1/jobs', { repositoryId, title });
      expect(res.status, 'create Job').toBe(201);
      return ((await res.json()) as JobBody).id;
    };
    const first = await create('First');
    await waitForJob(rt, first, atApproval, 30_000);
    const second = await create('Second');
    const waiting = await waitForJob(rt, second, atApproval, 30_000);
    expect(waiting.status).toBe('waiting_human');
    const firstJob = await json<JobBody>(rt.request(`/v1/jobs/${first}`));
    expect(firstJob.status).toBe('waiting_human');
  });
});
