/**
 * `factory inbox` and `factory plan show` (ADR-0016). Every decision goes
 * through the runtime API, which refuses one that names a stale version or
 * subject.
 */
import { readFileSync } from 'node:fs';
import {
  QuestionAnswerSchema,
  type AnswerQuestionInput,
  type Approval,
  type DecideInput,
  type DeferInput,
  type PlanView,
  type QuestionAnswer,
} from '@factory/domain';
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

/** `factory inbox decide <id> <option> --expect-version <n> [--grant <n>]`. */
export async function inboxDecide(
  id: string,
  option: string,
  opts: {
    expectVersion: number;
    subject: string | undefined;
    comment: string | undefined;
    /** A Blocker Approval's grant size (+1 to +5; the runtime's default is +1). */
    grant?: number | undefined;
  },
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
    ...(opts.grant === undefined ? {} : { grant: opts.grant }),
  };
  const decided = await refused(() =>
    api.json<Approval>('POST', `/v1/inbox/${encodeURIComponent(id)}/decide`, { body: input }),
  );
  if (decided === undefined) return 1;
  process.stdout.write(`Decided ${decided.id}: ${option}\n`);
  writeItem(decided);
  return 0;
}

/**
 * `factory inbox answer <id> (--answer <text>... | --file <path>) [--expect-version <n>]`
 * (`answerQuestion`). Each `--answer` is `<question-id>=<answer>`, or a plain
 * answer for the next question in order; an answer equal to one of the
 * question's options is sent as that option, anything else as free text.
 * `--file` holds the answers as JSON (`[{questionId, option | text}]`, or
 * `{answers: […]}`). Without `--expect-version` the version just read is used.
 */
export async function inboxAnswer(
  id: string,
  opts: { answers: string[]; file: string | undefined; expectVersion: number | undefined },
): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const item = await getItem(api, id);
  if (item === undefined) return 1;
  if (item.kind !== 'question' || item.questions === null) {
    process.stderr.write(`factory: ${id} is a ${item.kind} item; decide it with 'inbox decide'\n`);
    return 2;
  }
  let answers: QuestionAnswer[];
  if (opts.file !== undefined) {
    const content = JSON.parse(readFileSync(opts.file, 'utf8')) as unknown;
    const list =
      typeof content === 'object' && content !== null && !Array.isArray(content)
        ? (content as { answers?: unknown }).answers
        : content;
    const parsed = AnswersFileSchema.safeParse(list);
    if (!parsed.success) {
      process.stderr.write(
        `factory: ${opts.file} must hold [{questionId, option | text}] or {answers: [...]}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`,
      );
      return 2;
    }
    answers = parsed.data;
  } else {
    const built = answersFromFlags(item, opts.answers);
    if (typeof built === 'string') {
      process.stderr.write(`factory: ${built}\n`);
      return 2;
    }
    answers = built;
  }
  const input: AnswerQuestionInput = {
    expectedVersion: opts.expectVersion ?? item.version,
    subjectRef: item.subjectRef,
    answers,
  };
  const answered = await refused(() =>
    api.json<Approval>('POST', `/v1/inbox/${encodeURIComponent(id)}/answer`, { body: input }),
  );
  if (answered === undefined) return 1;
  process.stdout.write(
    `Answered ${answered.id}: a fresh Attempt of Task ${answered.taskId ?? '?'} starts with your answers\n`,
  );
  writeItem(answered);
  return 0;
}

const AnswersFileSchema = QuestionAnswerSchema.array();

/** The `--answer` flags as answers, or what is wrong with them. */
function answersFromFlags(item: Approval, flags: readonly string[]): QuestionAnswer[] | string {
  const questions = item.questions ?? [];
  if (flags.length === 0)
    return 'inbox answer needs --answer <text> (one per question) or --file <path>';
  const answers: QuestionAnswer[] = [];
  let next = 0;
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    const named = eq > 0 ? questions.find((q) => q.id === flag.slice(0, eq)) : undefined;
    const question = named ?? questions[next];
    if (question === undefined)
      return `more answers than the ${String(questions.length)} question(s)`;
    if (named === undefined) next++;
    const value = named === undefined ? flag : flag.slice(eq + 1);
    answers.push(
      question.options.includes(value)
        ? { questionId: question.id, option: value }
        : { questionId: question.id, text: value },
    );
  }
  return answers;
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
    ...(i.questions === null
      ? []
      : [
          '  questions (asked by an agent):',
          ...i.questions.flatMap((q) => [
            `    ${q.id.padEnd(6)} ${q.blocking ? 'blocking' : 'optional'}  ${q.text}`,
            ...(q.options.length === 0
              ? ['           answer in free text']
              : [
                  `           options: ${q.options.map((o) => (o === q.recommended ? `${o} [recommended]` : o)).join(' | ')} (or free text)`,
                ]),
          ]),
        ]),
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
      `  decided:    ${i.decision.option}${i.decision.grant === undefined ? '' : ` +${String(i.decision.grant)}`} by ${i.decidedBy ?? '?'} at ${i.decidedAt ?? '?'}` +
        (i.decision.comment === null ? '' : `: ${i.decision.comment}`),
      ...(i.decision.answers ?? []).map(
        (a) =>
          `    ${a.questionId.padEnd(6)} ${a.option !== undefined ? `option ${a.option}` : `text ${a.text ?? ''}`}`,
      ),
    );
  } else if (i.state === 'open' && i.kind === 'question') {
    lines.push(
      `  answer:     factory inbox answer ${i.id} --answer <text> ... --expect-version ${String(i.version)}`,
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
