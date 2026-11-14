import type {
  AcceptanceCriterion,
  Artifact,
  Attempt,
  DeliveryReport,
  Worktree,
  CancelJobInput,
  CreateJobInput,
  Job,
  JobSummary,
  Repository,
  Review,
  Task,
} from '@factory/domain';
import { API_KEY_BILLING_NOTE, costTagOf, SECURITY_TIER_LABELS } from '@factory/domain';
import { resolveHome } from '@factory/home';
import { ApiRequestError, findRuntime, type RuntimeClient } from '../client.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

export function client(): RuntimeClient | undefined {
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
  /** Overrides of the Job's concurrency limits (the runtime checks the range). */
  concurrency?: CreateJobInput['concurrency'];
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
    ...(opts.concurrency === undefined || Object.keys(opts.concurrency).length === 0
      ? {}
      : { concurrency: opts.concurrency }),
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
  const [criteria, tasks, attempts, worktrees, artifacts, reviews] = await Promise.all([
    api.json<AcceptanceCriterion[]>('GET', `${path}/acceptance-criteria`),
    api.json<Task[]>('GET', `${path}/tasks`),
    api.json<Attempt[]>('GET', `${path}/attempts`),
    api.json<Worktree[]>('GET', `${path}/worktrees`),
    api.json<Artifact[]>('GET', `${path}/artifacts`),
    api.json<Review[]>('GET', `${path}/reviews`),
  ]);
  writeJob(job);
  writePlan(criteria, tasks);
  writeAttempts(tasks, attempts, worktrees, reviews);
  const report = artifacts.find((a) => a.kind === 'report');
  if (report !== undefined) {
    writeDelivery(
      await api.json<DeliveryReport>(
        'GET',
        `/v1/artifacts/${encodeURIComponent(report.id)}/content`,
      ),
    );
  }
  return 0;
}

/** `factory job cancel`: cancels the Job as it is now; refused if it changes meanwhile. */
/**
 * Waits for the runtime to stop the work in flight: its processes get SIGTERM,
 * then SIGKILL after a 5 s grace period (#12).
 */
const CANCEL_TIMEOUT_MS = 30_000;
/** A Job in flight changes version as its work moves on; the cancel re-reads it this often. */
const CANCEL_TRIES = 3;

export async function jobCancel(id: string, opts: { reason: string | undefined }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  for (let attempt = 1; ; attempt++) {
    const job = await getJob(api, id);
    if (job === undefined) return 1;
    const input: CancelJobInput = {
      expectedVersion: job.version,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    };
    try {
      const cancelled = await api.json<Job>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {
        body: input,
        timeoutMs: CANCEL_TIMEOUT_MS,
      });
      process.stdout.write(`Cancelled Job ${cancelled.id}\n`);
      writeJob(cancelled);
      return 0;
    } catch (err) {
      const conflict = err instanceof ApiRequestError && err.body?.error === 'version_conflict';
      if (!conflict || attempt >= CANCEL_TRIES) throw err;
    }
  }
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
  type Config = Job['effectiveConfig'];
  type Setting = Config[Exclude<keyof Config, 'concurrency'>] | Config['concurrency']['perJob'];
  const { concurrency, ...settings } = job.effectiveConfig;
  const entries: [string, Setting][] = [
    ...Object.entries(settings),
    ...Object.entries(concurrency).map(([key, v]): [string, Setting] => [`concurrency.${key}`, v]),
  ];
  const config = entries
    .map(([key, v]) =>
      typeof v.value === 'object'
        ? `${key} (from ${v.source})`
        : `${key}=${String(v.value)} (from ${v.source})`,
    )
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
        (s.failure === null ? '' : `: ${s.failure.reason}: ${s.failure.message}`) +
        (s.blocker === null ? '' : `: ${s.blocker.kind} Blocker ${s.blocker.reason}`),
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
      if (t.blocker !== null) {
        lines.push(
          `    blocker    ${t.blocker.kind} ${t.blocker.reason}: ${t.blocker.detail}`,
          `    to clear:  ${t.blocker.requiredAction}`,
        );
      }
    }
  }
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
}

/** Usage with its honest tags: `usage 1200 in / 80 out tokens (actual), cost unknown/subscription`. */
function describeUsage(usage: Attempt['usage']): string {
  if (usage === null) return 'usage not recorded';
  const tokens =
    usage.inputTokens === null || usage.outputTokens === null
      ? `tokens ${usage.tag}`
      : `${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out tokens (${usage.tag})`;
  const costTag = costTagOf(usage);
  const cost =
    usage.costUsd === null ? `cost ${costTag}` : `cost $${usage.costUsd.toFixed(4)} (${costTag})`;
  const billing = usage.billing === 'api_key' ? `, ${API_KEY_BILLING_NOTE}` : '';
  return `usage ${tokens}, ${cost}${billing}`;
}

function writeAttempts(
  tasks: Task[],
  attempts: Attempt[],
  worktrees: Worktree[],
  reviews: Review[],
): void {
  if (attempts.length === 0) return;
  const lines = ['Attempts:'];
  for (const a of attempts) {
    const task = tasks.find((t) => t.id === a.taskId);
    const wt = worktrees.find((w) => w.id === a.worktreeId);
    lines.push(
      `  ${task?.key ?? a.taskId} attempt ${String(a.n)}  ${a.state}` +
        (a.cause === 'rework' ? ' [rework]' : '') +
        (a.exitReason === null
          ? ''
          : ` (${a.exitReason}${a.exitDetail === null ? '' : `: ${a.exitDetail}`})`),
      `    harness:   ${a.harness.id} ${a.harness.version ?? '?'}, template ${a.promptTemplate.id}, ${describeUsage(a.usage)}`,
      ...(a.sessionRef === null ? [] : [`    session:   ${a.sessionRef}`]),
      `    tier:      ${SECURITY_TIER_LABELS[a.tier].label} (${SECURITY_TIER_LABELS[a.tier].detail})`,
      `    worktree:  ${wt === undefined ? a.worktreeId : `${wt.path} (${wt.state}) on ${wt.branch}`}`,
      `    commits:   ${a.baseSha.slice(0, 12)}..${a.headSha?.slice(0, 12) ?? '?'} (${String(a.commits.length)})` +
        (a.wipCommit === null ? '' : `, WIP commit ${a.wipCommit.slice(0, 12)} by the factory`),
    );
    for (const v of a.protocolViolations) lines.push(`    violation: [${v.rule}] ${v.message}`);
    for (const f of a.findings.filter((x) => x.source === 'gate')) {
      lines.push(
        `    gate         ${String(f.rule)}  ${f.paths.length > 0 ? f.paths.join(', ') : f.location}  ${f.problem}`,
      );
    }
    if (a.packet.context.priorFindings.length > 0) {
      lines.push(
        `    carries:   ${String(a.packet.context.priorFindings.length)} Finding(s) of attempt ${String(a.n - 1)}`,
      );
    }
    for (const e of a.evidence) {
      const run = a.verificationRuns.find((r) => r.id === e.verificationRunId);
      lines.push(
        e.kind === 'verification'
          ? `    ${String(e.verificationKey).padEnd(12)} ${e.verdict.padEnd(10)} exit ${String(run?.exitCode ?? 'none')}`
          : `    ${String(e.criterionCode).padEnd(12)} ${e.verdict.padEnd(10)} ${e.source}: ${e.detail}`,
      );
    }
    for (const r of reviews.filter((x) => x.attemptId === a.id)) {
      lines.push(
        `    review       ${r.outcome}  on ${r.headSha.slice(0, 12)} (base ${r.baseSha.slice(0, 12)}), ${r.reviewer.harnessId} in Session ${r.sessionRef ?? '?'}: ${r.summary}`,
      );
      for (const f of r.findings) {
        lines.push(
          `      ${f.severity.padEnd(8)} ${f.faultOrigin.padEnd(14)} ${f.location}  ${f.blocking ? 'BLOCKING ' : ''}${f.problem}`,
        );
      }
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function writeDelivery(report: DeliveryReport): void {
  const version: number = report.reportVersion;
  if (version < 3) {
    // A report written before v3 (ADR-0028) has no branch list: show where it is.
    process.stdout.write(
      `Delivery: a v${String(version)} Delivery Report; read its report Artifact.\n`,
    );
    return;
  }
  const lines = [
    'Delivery (local branches in the Factory Clone):',
    `  ${report.statement}`,
    `  clone: ${report.repository.clonePath}`,
  ];
  for (const b of report.branches) {
    const state = b.cancelReason === null ? b.state : `${b.state} (${b.cancelReason})`;
    lines.push(
      `  ${b.key}: ${state}${b.leaf ? ', leaf' : ''}` +
        (b.branch === null ? ', no branch' : `, ${b.branch}`) +
        (b.headSha === null ? '' : ` at ${b.headSha.slice(0, 12)}`),
    );
    if (b.fetchCommand !== null) lines.push(`    fetch from your checkout: ${b.fetchCommand}`);
  }
  lines.push(...report.notes.map((n) => `  ${n}`));
  if (report.knownLimitations.length > 0) {
    lines.push('Known limitations:', ...report.knownLimitations.map((l) => `  - ${l}`));
  }
  process.stdout.write(lines.join('\n') + '\n');
}
