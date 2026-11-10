/**
 * `factory inbox` and `factory plan show` (ADR-0016). Every decision goes
 * through the runtime API, which refuses one that names a stale version or
 * subject.
 */
import type { Approval, DecideInput, DeferInput, PlanView } from '@factory/domain';
import { ApiRequestError, type RuntimeClient } from '../client.js';
import { client } from './job.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

/** `factory inbox [--all]`: open items not deferred, or every item. */
export async function inboxList(opts: { all: boolean; json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const items = await api.json<Approval[]>('GET', `/v1/inbox${opts.all ? '?all=true' : ''}`);
  if (opts.json) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return 0;
  }
  if (items.length === 0) {
    process.stdout.write(opts.all ? 'The Inbox is empty.\n' : 'No open Inbox Items.\n');
    return 0;
  }
  for (const i of items) {
    const state = i.deferred ? `${i.state} (deferred)` : i.state;
    process.stdout.write(
      `${i.id}  ${i.kind.padEnd(11)} ${state.padEnd(18)} v${String(i.version)}  ${i.jobId}  ${i.question}\n`,
    );
  }
  return 0;
}

/** `factory inbox show <id>`: the item, its version and its options. */
export async function inboxShow(id: string, opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await getItem(api, id);
  if (item === undefined) return 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify(item, null, 2) + '\n');
    return 0;
  }
  writeItem(item);
  return 0;
}

/** `factory inbox decide <id> <option> --expect-version <n>`. */
export async function inboxDecide(
  id: string,
  option: string,
  opts: { expectVersion: number; subject: string | undefined; comment: string | undefined },
): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await getItem(api, id);
  if (item === undefined) return 1;
  const input: DecideInput = {
    expectedVersion: opts.expectVersion,
    subjectRef: opts.subject ?? item.subjectRef,
    option,
    ...(opts.comment === undefined ? {} : { comment: opts.comment }),
  };
  const decided = await refused(() =>
    api.json<Approval>('POST', `/v1/inbox/${encodeURIComponent(id)}/decide`, { body: input }),
  );
  if (decided === undefined) return 1;
  process.stdout.write(`Decided ${decided.id}: ${option}\n`);
  writeItem(decided);
  return 0;
}

/** `factory inbox defer|undefer <id>`: hides the item from the default view, or shows it again. */
export async function inboxDefer(id: string, deferred: boolean): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await getItem(api, id);
  if (item === undefined) return 1;
  const input: DeferInput = { expectedVersion: item.version };
  const path = `/v1/inbox/${encodeURIComponent(id)}/${deferred ? 'defer' : 'undefer'}`;
  const changed = await refused(() => api.json<Approval>('POST', path, { body: input }));
  if (changed === undefined) return 1;
  process.stdout.write(`${deferred ? 'Deferred' : 'Undeferred'} ${changed.id}\n`);
  return 0;
}

/** `factory plan show <job>`: the plan approval view. */
export async function planShow(jobId: string, opts: { json: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const view = await refused(() =>
    api.json<PlanView>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/plan`),
  );
  if (view === undefined) return 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify(view, null, 2) + '\n');
    return 0;
  }
  const repoName = (id: string) => view.repositories.find((r) => r.id === id)?.name ?? id;
  const spec = view.specification as {
    objective?: string;
    acceptanceCriteria?: { code: string; mandatory: boolean; text: string }[];
  } | null;
  const lines = [
    `Plan ${view.planArtifactId} for Job ${view.job.id}: ${view.job.title} (${view.job.status})`,
    `  by ${view.planAuthoredBy}; Replans used: ${String(view.replans.used)} of ${String(view.replans.max)}`,
    'Specification:',
    ...(spec === null
      ? ['  (none)']
      : [
          `  objective: ${spec.objective ?? '?'}`,
          ...(spec.acceptanceCriteria ?? []).map(
            (c) => `  ${c.code} ${c.mandatory ? 'mandatory' : 'optional '} ${c.text}`,
          ),
        ]),
    `Repositories: ${view.repositories.map((r) => r.name).join(', ') || '(none)'}`,
    'Tasks (DAG):',
    ...view.tasks.flatMap((t) => [
      `  ${t.key.padEnd(14)} ${t.risk.padEnd(6)} ${repoName(t.repositoryId)}  ${t.title}`,
      `    after:    ${t.dependsOn.join(', ') || '(none)'}`,
      `    writable: ${t.writable.join(', ')}`,
      `    covers:   ${t.acceptance.join(', ') || '(none)'}`,
    ]),
    'Run in parallel:',
    ...view.parallel.map((w, n) => `  wave ${String(n + 1)}: ${w.join(', ')}`),
    'Risks:',
    `  triage: ${view.triageRisk ?? 'unknown'}`,
    ...view.tasks.filter((t) => t.risk !== 'low').map((t) => `  ${t.key}: ${t.risk}`),
    'Human decision points:',
    ...(view.decisionPoints.length === 0
      ? ['  (none)']
      : view.decisionPoints.map((p) => `  ${p.stageId} (${p.kind}): ${p.description}`)),
    'Estimate:',
    `  tasks:    ${String(view.estimate.taskCount)}`,
    `  attempts: ${String(view.estimate.attempts.min)}–${String(view.estimate.attempts.max)} (${view.estimate.attempts.label})`,
    `  cost:     ${view.estimate.cost.value} (${view.estimate.cost.reason})`,
  ];
  if (view.approval !== null) {
    lines.push(
      `Approval: ${view.approval.id} ${view.approval.state}, version ${String(view.approval.version)}`,
    );
    if (view.approval.state === 'open') {
      lines.push(
        `  decide:  factory inbox decide ${view.approval.id} approve|reject --expect-version ${String(view.approval.version)}`,
        `  replan:  factory plan request-changes ${view.job.id} --feedback <text>`,
        `  edit:    factory plan show ${view.job.id} --raw > plan.json; factory plan edit ${view.job.id} --file plan.json`,
      );
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function writeItem(i: Approval): void {
  const lines = [
    `Inbox Item ${i.id} (${i.kind})`,
    `  state:      ${i.state}${i.deferred ? ' (deferred)' : ''}`,
    `  version:    ${String(i.version)}`,
    `  job:        ${i.jobId}: ${i.jobTitle}`,
    `  project:    ${i.projectId}`,
    `  repository: ${i.repositoryId}`,
    `  stage:      ${i.stageId ?? '(none)'}`,
    `  subject:    ${i.subjectRef}`,
    `  requested:  by ${i.requestedBy} at ${i.createdAt}`,
    `  question:   ${i.question}`,
    `  why:        ${i.why}`,
    `  evidence:   ${i.evidence.join(', ') || '(none)'}`,
    `  expiry:     ${i.expiresPolicy} (stays pending; never auto-approves)`,
    '  options:',
    ...i.options.map(
      (o) =>
        `    ${o.id.padEnd(16)} ${o.description}${o.agentProposed ? ' [agent-proposed]' : ''}${i.recommended === o.id ? ' [recommended]' : ''}`,
    ),
  ];
  if (i.decision !== null) {
    lines.push(
      `  decided:    ${i.decision.option} by ${i.decidedBy ?? '?'} at ${i.decidedAt ?? '?'}` +
        (i.decision.comment === null ? '' : `: ${i.decision.comment}`),
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function getItem(api: RuntimeClient, id: string): Promise<Approval | undefined> {
  return refused(() => api.json<Approval>('GET', `/v1/inbox/${encodeURIComponent(id)}`));
}

/** Runs `call`; an API refusal is printed with its code and gives `undefined`. */
export async function refused<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
      process.stderr.write(
        `factory: refused (${err.body?.error ?? String(err.status)}): ${err.message}\n`,
      );
      return undefined;
    }
    throw err;
  }
}
