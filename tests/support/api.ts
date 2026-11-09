/** Typed helpers over the runtime HTTP API for the Job scenarios. */
import { expect } from 'vitest';
import { tinyTsRepo, type RunningRuntime } from './factory.js';

export interface StageRunBody {
  id: string;
  stageId: string;
  state: string;
  version: number;
  failure: { reason: string; message: string; issues: { rule: string; message: string }[] } | null;
}

export interface JobBody {
  id: string;
  projectId: string;
  repositoryId: string;
  title: string;
  description: string;
  type: string;
  status: string;
  currentStage: string;
  version: number;
  createdBy: string;
  workflowSnapshot: { recipeId: string; recipeVersion: number; stages: { id: string }[] };
  effectiveConfig: { maxAttempts: { value: number; source: string } };
  stageRuns: StageRunBody[];
}

export interface EventBody {
  seq: number;
  type: string;
  entityKind: string;
  entityId: string;
  jobId: string | null;
  actor: string;
  payload: Record<string, unknown>;
}

export const PHASE_A_FEATURE_STAGES = [
  'intake',
  'triage',
  'discovery',
  'specification',
  'planning',
  'execution',
  'closure',
];

export async function registeredRepo(
  rt: RunningRuntime,
): Promise<{ id: string; projectId: string }> {
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = (await (await rt.request('/v1/repositories')).json()) as [
    { id: string; projectId: string },
  ];
  return repo;
}

/**
 * Sets the Project's `maxAttempts` (Effective Configuration), so a scenario about one
 * Attempt's verdict ends at the Rework cap instead of starting Rework it didn't script.
 * Call before creating the Job: its configuration is frozen at creation.
 */
export async function capAttempts(
  rt: RunningRuntime,
  projectId: string,
  maxAttempts: number,
): Promise<void> {
  const res = await post(rt, `/v1/projects/${projectId}/config`, { maxAttempts });
  if (!res.ok) throw new Error(`setting maxAttempts failed: ${String(res.status)}`);
}

/** The Job's one Attempt; fails the test when there is not exactly one. */
export async function onlyAttempt<T>(rt: RunningRuntime, jobId: string): Promise<T> {
  const attempts = await json<T[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
  expect(attempts, 'exactly one Attempt').toHaveLength(1);
  return attempts[0] as T;
}

/** Asserts the Job stopped at the Rework cap: `waiting_human`, its Task blocked by a human Blocker. */
export async function expectStoppedAtCap(rt: RunningRuntime, job: JobBody): Promise<void> {
  expect(job.status).toBe('waiting_human');
  const tasks = await json<{ state: string; blocker: { kind: string; reason: string } | null }[]>(
    rt.request(`/v1/jobs/${job.id}/tasks`),
  );
  expect(tasks.map((t) => [t.state, t.blocker?.kind, t.blocker?.reason])).toEqual([
    ['blocked', 'human', 'rework_cap_reached'],
  ]);
}

export async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

export function post(rt: RunningRuntime, path: string, body: unknown): Promise<Response> {
  return rt.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function createJob(rt: RunningRuntime, repositoryId: string, title = 'Add sum()') {
  const res = await post(rt, '/v1/jobs', { repositoryId, title, description: 'in math.ts' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

/** Polls a Job until `done` holds, failing with the last state seen after `timeoutMs`. */
export async function waitForJob(
  rt: RunningRuntime,
  id: string,
  done: (job: JobBody) => boolean,
  timeoutMs = 10_000,
): Promise<JobBody> {
  const deadline = Date.now() + timeoutMs;
  let job: JobBody | undefined;
  while (Date.now() < deadline) {
    job = await json<JobBody>(rt.request(`/v1/jobs/${id}`));
    if (done(job)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Job ${id} did not reach the expected state; last seen: ${JSON.stringify(job?.stageRuns.map((s) => [s.stageId, s.state]))}\n${rt.output()}`,
  );
}

/** Settled: the Job is no longer `active` (it finished, or waits on something). */
export function jobSettled(job: JobBody): boolean {
  return job.status !== 'active';
}
