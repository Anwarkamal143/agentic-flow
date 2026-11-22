import type {
  GitHubState,
  AcceptanceCriterion,
  Approval,
  Artifact,
  Attempt,
  DeliveryReport,
  Worktree,
  CancelJobInput,
  CreateJobInput,
  Job,
  RequestReplanInput,
  JobSummary,
  PullRequestRecord,
  Repository,
  Review,
  Task,
} from '@factory/domain';
import {
  API_KEY_BILLING_NOTE,
  costTagOf,
  emptyDeliveryNote,
  SECURITY_TIER_LABELS,
} from '@factory/domain';
import { resolveHome } from '@factory/home';
import { ApiRequestError, findRuntime, type RuntimeClient } from '../client.js';
import { describePause, EXIT_NOT_RUNNING } from './lifecycle.js';

export function client(): RuntimeClient | undefined {
  const found = findRuntime(resolveHome());
  if (found.kind === 'not_running') {
    process.stderr.write('Runtime: not running. Run: factory start\n');
    return undefined;
  }
  return found.client;
}

export interface JobCreateOptions {
  /** A Project id or name; unset: the Repository's Project, or the only Project. */
  project: string | undefined;
  /** Repository ids or names (several: a multi-repo Job); none: the Project's only Repository. */
  repos: readonly string[];
  title: string;
  description: string | undefined;
  /** Overrides of the Job's concurrency limits (the runtime checks the range). */
  concurrency?: CreateJobInput['concurrency'];
  /** A Merge Policy override; the runtime refuses one looser than the Repository's. */
  mergePolicy?: CreateJobInput['mergePolicy'];
}

/**
 * `factory job create`: records a Job. The runtime infers the Project only when
 * exactly one exists, and the Repository only when the Project has one (ADR-0055).
 */
export async function jobCreate(opts: JobCreateOptions): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const chosen: Repository[] = [];
  if (opts.repos.length > 0) {
    const repos = await api.json<Repository[]>('GET', '/v1/repositories');
    for (const ref of opts.repos) {
      const matches = repos.filter((r) => r.id === ref || r.name === ref);
      const [only] = matches;
      if (only === undefined || matches.length > 1) {
        process.stderr.write(
          matches.length === 0
            ? `factory: no Repository '${ref}'. Registered: ${repos.map((r) => `${r.name} (${r.id})`).join(', ') || 'none'}\n`
            : `factory: '${ref}' names several Repositories; use its id: ${matches.map((r) => r.id).join(', ')}\n`,
        );
        return 1;
      }
      if (chosen.some((r) => r.id === only.id)) {
        process.stderr.write(`factory: Repository '${ref}' is named more than once\n`);
        return 1;
      }
      chosen.push(only);
    }
  }
  const input: CreateJobInput = {
    ...(opts.project === undefined ? {} : { project: opts.project }),
    ...(chosen.length === 0 ? {} : { repositoryIds: chosen.map((r) => r.id) }),
    title: opts.title,
    description: opts.description ?? '',
    ...(opts.concurrency === undefined || Object.keys(opts.concurrency).length === 0
      ? {}
      : { concurrency: opts.concurrency }),
    ...(opts.mergePolicy === undefined ? {} : { mergePolicy: opts.mergePolicy }),
  };
  const job = await api.json<Job>('POST', '/v1/jobs', { body: input });
  process.stdout.write(
    `Created Job ${job.id} for ${job.repositories.map((r) => r.name).join(', ')}\n`,
  );
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
      `${job.id}  ${job.status.padEnd(13)} ${job.currentStage.padEnd(13)} ${job.title}` +
        `  [${job.repositories.map((r) => r.name).join(', ')}]\n`,
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
  const [criteria, tasks, attempts, worktrees, artifacts, reviews, pullRequests, github] =
    await Promise.all([
      api.json<AcceptanceCriterion[]>('GET', `${path}/acceptance-criteria`),
      api.json<Task[]>('GET', `${path}/tasks`),
      api.json<Attempt[]>('GET', `${path}/attempts`),
      api.json<Worktree[]>('GET', `${path}/worktrees`),
      api.json<Artifact[]>('GET', `${path}/artifacts`),
      api.json<Review[]>('GET', `${path}/reviews`),
      api.json<PullRequestRecord[]>('GET', `${path}/pull-requests`),
      api.json<GitHubState>('GET', '/v1/github'),
    ]);
  writeJob(job);
  writePlan(criteria, tasks);
  writeAttempts(tasks, attempts, worktrees, reviews);
  writePullRequests(pullRequests, github);
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
      await writeCleanupItem(api, cancelled.id);
      return 0;
    } catch (err) {
      const conflict = err instanceof ApiRequestError && err.body?.error === 'version_conflict';
      if (!conflict || attempt >= CANCEL_TRIES) throw err;
    }
  }
}

/**
 * `factory job replan <job> --feedback <text>` (`requestReplan`, ADR-0029):
 * asks for a Replan of a Job in execution. Nothing new is dispatched from
 * then on; planning starts once no Attempt is in flight. At `maxReplans` the
 * request waits in a Blocker Approval instead (its id is printed).
 */
export async function jobReplan(id: string, opts: { feedback: string }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  for (let attempt = 1; ; attempt++) {
    const job = await getJob(api, id);
    if (job === undefined) return 1;
    const input: RequestReplanInput = { expectedVersion: job.version, feedback: opts.feedback };
    try {
      const result = await api.json<Job & { capApprovalId?: string }>(
        'POST',
        `/v1/jobs/${encodeURIComponent(id)}/replan`,
        { body: input },
      );
      process.stdout.write(
        result.capApprovalId === undefined
          ? `Replan requested for Job ${result.id} (${String(result.replans.used)} of ${String(result.replans.max)} Replans used). ` +
              'Nothing new is dispatched; planning starts once no Attempt is in flight, and the new Plan waits at plan_approval.\n'
          : `Job ${result.id} has used ${String(result.replans.used)} of ${String(result.replans.max)} Replans (maxReplans): ` +
              `the request waits in Blocker Approval ${result.capApprovalId}. ` +
              `Grant one more Replan with: factory inbox decide ${result.capApprovalId} grant_replan\n`,
      );
      return 0;
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      const conflict = err.body?.error === 'version_conflict';
      if (conflict && attempt < CANCEL_TRIES) continue;
      process.stderr.write(`factory: ${err.body?.error ?? 'error'}: ${err.message}\n`);
      return 1;
    }
  }
}

/**
 * The Job's `cleanup` Inbox Item, opened once the cancel stopped everything
 * (ADR-0027, ADR-0043): its id, each question it asks, and how to answer it,
 * or why there is none.
 */
async function writeCleanupItem(api: RuntimeClient, jobId: string): Promise<void> {
  const items = await api.json<Approval[]>('GET', '/v1/inbox?all=true');
  const item = items.find((i) => i.jobId === jobId && i.kind === 'cleanup');
  if (item === undefined) {
    process.stdout.write(
      'No cleanup Approval: the cancel left no preserved Worktree, open PR or remote branch.\n',
    );
    return;
  }
  const questions = item.questions ?? [];
  if (questions.length === 0) {
    // An item opened before its questions (ADR-0027) is decided keep | discard.
    process.stdout.write(
      [
        `Cleanup Approval ${item.id}: ${item.question} (default: ${item.recommended ?? 'keep'}; Task Branches are always kept)`,
        `  decide: factory inbox decide ${item.id} keep|discard --expect-version ${String(item.version)}`,
        '',
      ].join('\n'),
    );
    return;
  }
  process.stdout.write(
    [
      `Cleanup Approval ${item.id}: ${item.question}`,
      ...questions.map(
        (q) => `  ${q.id}: ${q.text} (${q.options.join('|')}; default: ${q.recommended ?? 'keep'})`,
      ),
      '  Task Branches are always kept; a question you leave unanswered keeps.',
      `  answer: factory inbox answer ${item.id} ${questions
        .map((q) => `--answer ${q.id}=${q.options.find((o) => o !== q.recommended) ?? ''}`)
        .join(' ')} --expect-version ${String(item.version)}`,
      '',
    ].join('\n'),
  );
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

/** The profile command a verification run named, with its arguments (ADR-0051); empty for free shell. */
function profileCommandNote(named: { name: string; args: string[] } | null): string {
  return named === null ? '' : `  profile command ${[named.name, ...named.args].join(' ')}`;
}

/**
 * Untrusted text (a foreign commit's subject or author, ADR-0042) as one
 * printable line: control characters, terminal escapes among them, become spaces.
 */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** A frozen value as one line: `none`, a list, `key=value` pairs, or the value itself. */
function shownValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return value.length === 0 ? 'every check' : value.join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, x]) => (typeof x === 'object' && x !== null ? k : `${k}=${shownValue(x)}`))
      .join(', ');
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One effective value as `job show` prints it: the value, its source and any chain of narrowings. */
function effective(
  key: string,
  v: { value: unknown; source: string; chain?: { source: string; value: string }[] | undefined },
  width: number,
): string {
  const value = shownValue(v.value);
  const chain =
    v.chain === undefined || v.chain.length < 2
      ? ''
      : `; ${v.chain.map((c) => `${c.source}: ${c.value}`).join(' → ')}`;
  return `${key.padEnd(width)}  ${value}  (${v.source}${chain})`;
}

/** The Job's frozen Effective Configuration, each value with its source (ADR-0057). */
function configLines(config: Job['effectiveConfig']): string[] {
  const { concurrency, repositories, mergePolicy, setup, ...settings } = config;
  const jobWide: [string, Parameters<typeof effective>[1]][] = [
    ...Object.entries(settings),
    ...Object.entries(concurrency).map(([key, v]): [string, Parameters<typeof effective>[1]] => [
      `concurrency.${key}`,
      v,
    ]),
  ];
  // A Job from before Phase D froze its one Repository's values at the top level.
  if (mergePolicy !== undefined) jobWide.push(['mergePolicy', mergePolicy]);
  if (setup !== undefined) jobWide.push(['setup', setup]);
  const width = Math.max(...jobWide.map(([key]) => key.length));
  const lines = [
    'Configuration (frozen at creation):',
    ...jobWide.map(([key, v]) => `  ${effective(key, v, width)}`),
  ];
  for (const repo of repositories) {
    const { repositoryId, name, ...values } = repo;
    lines.push(`  Repository ${name} (${repositoryId}):`);
    for (const [key, v] of Object.entries(values)) lines.push(`    ${effective(key, v, 14)}`);
  }
  return lines;
}

function writeJob(job: Job): void {
  const lines = [
    `Job ${job.id}: ${job.title}`,
    `  status:       ${job.status}`,
    `  stage:        ${job.currentStage}`,
    `  repositories: ${job.repositories.map((r) => `${r.name} (${r.id})`).join(', ')}`,
    ...deliveryOrderLines(job),
    `  recipe:       ${job.workflowSnapshot.recipeId} v${String(job.workflowSnapshot.recipeVersion)}`,
    `  replans:      ${String(job.replans.used)} of ${String(job.replans.max)} used${job.replanRequested ? '; replan requested, waiting for the Attempts in flight' : ''}`,
    `  version:      ${String(job.version)}`,
    `  created:      ${job.createdAt} by ${job.createdBy}`,
    ...configLines(job.effectiveConfig),
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

/**
 * The Delivery Order of a Plan over several Repositories (ADR-0052): upstream
 * first, then which Repository waits for which. Nothing for one Repository.
 */
function deliveryOrderLines(job: Job): string[] {
  const order = job.deliveryOrder;
  if (order === null || order.length < 2) return [];
  const name = (id: string) => order.find((e) => e.repositoryId === id)?.name ?? id;
  const waits = order
    .filter((e) => e.after.length > 0)
    .map((e) => `${e.name} after ${e.after.map(name).join(', ')}`);
  return [
    `  delivery order: ${order.map((e) => e.name).join(' → ')}${waits.length === 0 ? '' : ` (${waits.join('; ')})`}`,
  ];
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
        `  ${t.key.padEnd(14)} ${(t.cancelReason === null ? t.state : `${t.state} (${t.cancelReason})`).padEnd(10)} ${t.title}` +
          // The factory's own Task: not part of the Plan, never replanned or edited (ADR-0034).
          (t.kind === 'integration'
            ? '  [Integration Task, factory-created, not in the Plan]'
            : ''),
        `    writable:  ${t.scope.writable.join(', ')}`,
        `    forbidden: ${t.scope.forbidden.join(', ') || '(none)'}`,
        `    verify:    ${t.verification.map((v) => `${v.key}: ${[v.command, ...(v.args ?? [])].join(' ')}`).join('; ')}`,
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
        (a.cause === 'merge' ? ' [merge: the factory merged, no Harness ran]' : '') +
        (a.cause === 'base_merge'
          ? ' [base merge: the factory merged the moved default branch in, no Harness ran]'
          : '') +
        (a.cause === 'foreign_push'
          ? ' [foreign push: someone else pushed to the Integration Branch; the factory fetched and verified it, no Harness ran]'
          : '') +
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
    for (const c of a.foreignCommits) {
      lines.push(
        `    foreign:   ${c.sha.slice(0, 12)} by ${oneLine(c.author)}: ${oneLine(c.subject)}`,
      );
    }
    for (const c of a.droppedCommits) {
      lines.push(
        `    dropped:   ${c.sha.slice(0, 12)} by ${oneLine(c.author)}: ${oneLine(c.subject)} (an adopted rewrite dropped it)`,
      );
    }
    for (const r of a.setupRuns) {
      lines.push(
        `    setup:     ${oneLine(r.command)}  ${r.passed ? 'passed' : `FAILED (${oneLine(r.failure ?? '')})`}, ${(r.durationMs / 1000).toFixed(1)} s, Worktree ${r.diskBytes === null ? 'size unknown' : `${(r.diskBytes / 2 ** 20).toFixed(1)} MiB`}, on ${r.headSha.slice(0, 12)} (log ${r.outputArtifactId})`,
      );
    }
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
          ? `    ${String(e.verificationKey).padEnd(12)} ${e.verdict.padEnd(10)} exit ${String(run?.exitCode ?? 'none')}` +
              profileCommandNote(run?.profileCommand ?? null)
          : `    ${String(e.criterionCode).padEnd(12)} ${e.verdict.padEnd(10)} ${e.source}: ${e.detail}`,
      );
    }
    for (const r of reviews.filter((x) => x.attemptId === a.id)) {
      lines.push(
        r.reanchoredFrom === null
          ? `    review       ${r.outcome}  on ${r.headSha.slice(0, 12)} (base ${r.baseSha.slice(0, 12)}), ${r.reviewer.harnessId} in Session ${r.sessionRef ?? '?'}: ${r.summary}`
          : `    review       ${r.outcome}  on ${r.headSha.slice(0, 12)} (base ${r.baseSha.slice(0, 12)}), re-anchored from review ${r.reanchoredFrom} (the base merge-in left the diff unchanged; no reviewer ran): ${r.summary}`,
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

/**
 * The Job's pull requests, as the runtime recorded them (never read live from
 * GitHub): state, the merge, the Merge Gate the poller last evaluated, each
 * check with its link, and when GitHub was last polled.
 */
function writePullRequests(pullRequests: PullRequestRecord[], github: GitHubState): void {
  if (pullRequests.length === 0) return;
  const lines = [
    'Pull requests (as recorded by the factory):',
    `  GitHub: ${describePause(github)}`,
  ];
  for (const pr of pullRequests) {
    lines.push(
      `  ${pr.owner}/${pr.name}#${String(pr.number)}  ${pr.state.padEnd(7)} ${pr.url}`,
      `    ${pr.headBranch} → ${pr.baseBranch}, head ${pr.headSha.slice(0, 12)} (pushed ${pr.pushedSha.slice(0, 12)})` +
        (pr.adopted ? ', adopted on recovery' : ''),
    );
    if (pr.changedFiles === 0) {
      lines.push(`    flagged: ${emptyDeliveryNote(pr.headSha, pr.baseSha)}`);
    }
    if (pr.replacedByNumber !== null) {
      lines.push(
        `    closed by the factory and replaced by #${String(pr.replacedByNumber)} (a new PR for the rebuilt Integration Branch)`,
      );
    }
    if (pr.mergeSha !== null) lines.push(`    merged on GitHub as ${pr.mergeSha}`);
    lines.push(`    last polled ${pr.lastPolledAt ?? 'never (not polled yet)'}`);
    if (pr.gate !== null) {
      lines.push(
        `    Merge Gate: ${pr.gate.verdict} (evaluated ${pr.gateEvaluatedAt ?? 'never'})`,
        ...pr.gate.conditions.map((c) => `      ${c.status.padEnd(8)} ${c.label}: ${c.reason}`),
      );
    }
    lines.push(
      pr.checks.length === 0
        ? `    Checks on ${pr.headSha.slice(0, 12)}: none reported`
        : `    Checks on ${pr.headSha.slice(0, 12)}:`,
      ...pr.checks.map(
        (c) => `      ${c.name.padEnd(20)} ${c.outcome.padEnd(8)} ${c.url ?? '(no link)'}`,
      ),
    );
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
    version >= 5 && report.pullRequests.length > 0
      ? 'Delivery (a pull request on GitHub; the branches are also in the Factory Clone):'
      : 'Delivery (local branches in the Factory Clone):',
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
  const integration = version >= 4 ? report.integration : null;
  if (integration !== null) {
    lines.push(
      `  Integration Branch ${integration.branch}: ${integration.state}` +
        (integration.headSha === null ? '' : ` at ${integration.headSha.slice(0, 12)}`) +
        (integration.baseSha === null ? '' : ` (base ${integration.baseSha.slice(0, 12)})`),
    );
    if (integration.merged.length > 0) {
      lines.push(`    merged --no-ff: ${integration.merged.map((m) => m.key).join(' → ')}`);
    }
    for (const v of integration.verification) {
      lines.push(
        `    ${v.key.padEnd(12)} ${v.verdict.padEnd(10)} exit ${String(v.exitCode ?? 'none')}  ${v.command}`,
      );
    }
    for (const c of integration.foreignCommits) {
      lines.push(
        `    foreign commit ${c.sha.slice(0, 12)} by ${oneLine(c.author)}: ${oneLine(c.subject)} (verified by attempt ${c.attemptId}: ${c.attemptState})`,
      );
    }
    for (const c of integration.droppedCommits) {
      lines.push(
        `    dropped approved commit ${c.sha.slice(0, 12)} by ${oneLine(c.author)}: ${oneLine(c.subject)} (a rewrite adopted by attempt ${c.attemptId})`,
      );
    }
    if (integration.problem !== null) lines.push(`    problem: ${integration.problem}`);
    if (integration.fetchCommand !== null) {
      lines.push(`    fetch from your checkout: ${integration.fetchCommand}`);
    }
  }
  for (const pr of version >= 5 ? report.pullRequests : []) {
    lines.push(
      `  Pull request ${pr.repository}#${String(pr.number)}: ${pr.state}, ${pr.url}` +
        ` (${pr.headBranch} at ${pr.headSha.slice(0, 12)} → ${pr.baseBranch})` +
        (pr.mergeSha === null
          ? ', awaiting human merge'
          : `, merged as ${pr.mergeSha.slice(0, 12)}`),
    );
    const ci = version >= 6 ? pr.ci : null;
    if (ci !== null) lines.push(`    CI checks: ${ci.status}: ${ci.reason}`);
    if (version >= 7 && pr.mergedBefore.length > 0) {
      lines.push(`    merged out of order, before ${pr.mergedBefore.join(', ')}`);
    }
  }
  const repositories = version >= 7 ? report.repositories : [];
  if (repositories.length > 1) {
    lines.push(`  Repositories, in Delivery Order:`);
    for (const r of repositories) {
      lines.push(
        `    ${r.name}: ${r.status.replaceAll('_', ' ')}` +
          (r.after.length === 0 ? '' : ` (after ${r.after.join(', ')})`) +
          (r.pullRequest === null ? '' : `, ${r.pullRequest}`) +
          (r.integration === null ? '' : `, ${r.integration.branch} (${r.integration.state})`) +
          `, clone ${r.clonePath}`,
      );
      if (r.integration?.fetchCommand != null && r.pullRequest === null) {
        lines.push(`      fetch from your checkout: ${r.integration.fetchCommand}`);
      }
    }
  }
  lines.push(...report.notes.map((n) => `  ${n}`));
  if (report.knownLimitations.length > 0) {
    lines.push('Known limitations:', ...report.knownLimitations.map((l) => `  - ${l}`));
  }
  process.stdout.write(lines.join('\n') + '\n');
}
