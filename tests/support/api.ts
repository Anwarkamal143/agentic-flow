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

/** Settled: nothing queued or running except `execution`, which waits for the Task scheduler. */
export function proposalStagesSettled(job: JobBody): boolean {
  return (
    job.status !== 'active' ||
    job.stageRuns.every(
      (s) => s.stageId === 'execution' || (s.state !== 'queued' && s.state !== 'running'),
    )
  );
}
