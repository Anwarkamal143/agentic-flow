import type {
  AcceptanceCriterion,
  CancelJobInput,
  CreateJobInput,
  Job,
  JobSummary,
  Repository,
  Task,
} from '@factory/domain';
import { resolveHome } from '@factory/home';
import { ApiRequestError, findRuntime, type RuntimeClient } from '../client.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

function client(): RuntimeClient | undefined {
  const found = findRuntime(resolveHome());
  if (found.kind === 'not_running') {
    process.stderr.write('Runtime: not running. Run: factory start\n');
    return undefined;
  }
  return found.client;
}

export interface JobCreateOptions {
  /** A Repository id or name. */
  repo: string;
  title: string;
  description: string | undefined;
}

/** `factory job create`: records a Job for a registered Repository. */
export async function jobCreate(opts: JobCreateOptions): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const repos = await api.json<Repository[]>('GET', '/v1/repositories');
  const matches = repos.filter((r) => r.id === opts.repo || r.name === opts.repo);
  if (matches.length !== 1) {
    process.stderr.write(
      matches.length === 0
        ? `factory: no Repository '${opts.repo}'. Registered: ${repos.map((r) => `${r.name} (${r.id})`).join(', ') || 'none'}\n`
        : `factory: '${opts.repo}' names several Repositories; use its id: ${matches.map((r) => r.id).join(', ')}\n`,
    );
    return 1;
  }
  const [repo] = matches as [Repository];
  const input: CreateJobInput = {
    repositoryId: repo.id,
    title: opts.title,
    description: opts.description ?? '',
  };
  const job = await api.json<Job>('POST', '/v1/jobs', { body: input });
  process.stdout.write(`Created Job ${job.id} for ${repo.name}\n`);
  writeJob(job);
  return 0;
}

export async function jobList(opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const jobs = await api.json<JobSummary[]>('GET', '/v1/jobs');
  if (opts.json) {
    process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
    return 0;
  }
  if (jobs.length === 0) {
    process.stdout.write('No Jobs.\n');
    return 0;
  }
  for (const job of jobs) {
    process.stdout.write(
      `${job.id}  ${job.status.padEnd(13)} ${job.currentStage.padEnd(13)} ${job.title}\n`,
    );
  }
  return 0;
}

export async function jobShow(id: string, opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const job = await getJob(api, id);
  if (job === undefined) return 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    return 0;
  }
  const path = `/v1/jobs/${encodeURIComponent(id)}`;
  const [criteria, tasks] = await Promise.all([
    api.json<AcceptanceCriterion[]>('GET', `${path}/acceptance-criteria`),
    api.json<Task[]>('GET', `${path}/tasks`),
  ]);
  writeJob(job);
  writePlan(criteria, tasks);
  return 0;
}

/** `factory job cancel`: cancels the Job as it is now; refused if it changes meanwhile. */
export async function jobCancel(id: string, opts: { reason: string | undefined }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const job = await getJob(api, id);
  if (job === undefined) return 1;
  const input: CancelJobInput = {
    expectedVersion: job.version,
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
  };
  const cancelled = await api.json<Job>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {
    body: input,
  });
  process.stdout.write(`Cancelled Job ${cancelled.id}\n`);
  writeJob(cancelled);
  return 0;
}

async function getJob(api: RuntimeClient, id: string): Promise<Job | undefined> {
  try {
    return await api.json<Job>('GET', `/v1/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      process.stderr.write(`factory: no Job ${id}\n`);
      return undefined;
    }
    throw err;
  }
}

function writeJob(job: Job): void {
  const config = Object.entries(job.effectiveConfig)
    .map(([key, v]) => `${key}=${String(v.value)} (from ${v.source})`)
    .join(', ');
  const lines = [
    `Job ${job.id}: ${job.title}`,
    `  status:     ${job.status}`,
    `  stage:      ${job.currentStage}`,
    `  repository: ${job.repositoryId}`,
    `  recipe:     ${job.workflowSnapshot.recipeId} v${String(job.workflowSnapshot.recipeVersion)}`,
    `  config:     ${config}`,
    `  version:    ${String(job.version)}`,
    `  created:    ${job.createdAt} by ${job.createdBy}`,
    'Stages:',
    ...job.stageRuns.map(
      (s) =>
        `  ${s.stageId.padEnd(14)} ${s.state}` +
        (s.failure === null ? '' : `: ${s.failure.reason}: ${s.failure.message}`),
    ),
  ];
  if (job.description !== '') lines.splice(1, 0, `  ${job.description}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function writePlan(criteria: AcceptanceCriterion[], tasks: Task[]): void {
  const lines: string[] = [];
  if (criteria.length > 0) {
    lines.push('Acceptance criteria:');
    for (const c of criteria) {
      lines.push(`  ${c.code} ${c.mandatory ? 'mandatory' : 'optional '} ${c.text}`);
    }
  }
  if (tasks.length > 0) {
    lines.push('Tasks:');
    for (const t of tasks) {
      lines.push(
        `  ${t.key.padEnd(14)} ${t.state.padEnd(10)} ${t.title}`,
        `    writable:  ${t.scope.writable.join(', ')}`,
        `    forbidden: ${t.scope.forbidden.join(', ') || '(none)'}`,
        `    verify:    ${t.verification.map((v) => `${v.key}: ${v.command}`).join('; ')}`,
      );
      if (t.dependsOn.length > 0) lines.push(`    after:     ${t.dependsOn.join(', ')}`);
    }
  }
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
}
