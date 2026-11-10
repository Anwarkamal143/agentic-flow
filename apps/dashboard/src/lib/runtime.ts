/**
 * The dashboard's only way to the factory's state: the runtime HTTP API
 * (CLAUDE.md "One writer"). Server-side only. It reads the API token and the
 * runtime record from the factory home (FACTORY_HOME, default `~/.factory`),
 * so the token never reaches the browser. Every response is parsed against
 * the `@factory/domain` contract, so the pages show only what was persisted
 * and understood. Reads are GET requests. The only writes are the Inbox's
 * ({@link changeInboxItem}), made as `user:local`, the actor the token stands
 * for (ADR-0022).
 */
import {
  AcceptanceCriterionSchema,
  ActivitySchema,
  ApiErrorSchema,
  ApprovalSchema,
  ArtifactSchema,
  PlanViewSchema,
  ProjectSchema,
  RepositorySchema,
  AttemptTailSchema,
  AttemptSchema,
  FactoryEventSchema,
  JobSchema,
  JobSummarySchema,
  ReviewSchema,
  TaskSchema,
  type AcceptanceCriterion,
  type Activity,
  type Approval,
  type Artifact,
  type PlanView,
  type Project,
  type Repository,
  type AttemptTail,
  type Attempt,
  type FactoryEvent,
  type Job,
  type JobSummary,
  type Review,
  type Task,
} from '@factory/domain';
import {
  isProcessAlive,
  readRuntimeRecord,
  readToken,
  resolveHome,
  runtimeUrl,
} from '@factory/home';
import { z } from 'zod';

/** Why the runtime could not answer: the reason is shown as is. */
export class RuntimeUnavailable extends Error {
  override readonly name = 'RuntimeUnavailable';
}

/** The runtime answered with an error status. */
export class RuntimeApiError extends Error {
  override readonly name = 'RuntimeApiError';
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GET ${path} failed: HTTP ${String(status)}`);
  }
}

export interface RuntimeConnection {
  readonly url: string;
  readonly token: string;
}

/** Finds the running runtime of this factory home, or throws {@link RuntimeUnavailable}. */
export function connect(): RuntimeConnection {
  const home = resolveHome();
  const token = readToken(home);
  if (token === undefined) {
    throw new RuntimeUnavailable(
      `The factory home ${home.root} has no API token. Run: factory init`,
    );
  }
  const record = readRuntimeRecord(home);
  if (record === undefined || !isProcessAlive(record.pid)) {
    throw new RuntimeUnavailable(
      'The factory runtime is not running. Start it with: factory start',
    );
  }
  return { url: runtimeUrl(record), token };
}

async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
  const rt = connect();
  try {
    return await fetch(rt.url + path, {
      method: init.method,
      headers: {
        authorization: `Bearer ${rt.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new RuntimeUnavailable(
      `The factory runtime at ${rt.url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const res = await call(path, { method: 'GET' });
  if (!res.ok) throw new RuntimeApiError(res.status, path);
  return schema.parse(await res.json());
}

export function listJobs(): Promise<JobSummary[]> {
  return get('/v1/jobs', z.array(JobSummarySchema));
}

/** Everything the job detail page shows, read in one go. */
export interface JobDetail {
  job: Job;
  criteria: AcceptanceCriterion[];
  tasks: Task[];
  attempts: Attempt[];
  reviews: Review[];
  events: FactoryEvent[];
}

export async function jobDetail(id: string): Promise<JobDetail> {
  const base = `/v1/jobs/${encodeURIComponent(id)}`;
  // The Job first: an unknown id is a 404 before anything else is asked.
  const job = await get(base, JobSchema);
  const [criteria, tasks, attempts, reviews, events] = await Promise.all([
    get(`${base}/acceptance-criteria`, z.array(AcceptanceCriterionSchema)),
    get(`${base}/tasks`, z.array(TaskSchema)),
    get(`${base}/attempts`, z.array(AttemptSchema)),
    get(`${base}/reviews`, z.array(ReviewSchema)),
    jobEvents(base),
  ]);
  return { job, criteria, tasks, attempts, reviews, events };
}

/**
 * Every event of the Job, in `seq` order, page by page at the runtime's own
 * page size, until a page comes back empty.
 */
async function jobEvents(base: string): Promise<FactoryEvent[]> {
  const all: FactoryEvent[] = [];
  for (;;) {
    const after = all.at(-1)?.seq ?? 0;
    const page = await get(`${base}/events?after=${String(after)}`, z.array(FactoryEventSchema));
    if (page.length === 0) return all;
    all.push(...page);
  }
}

/** The running Attempts (ADR-0018). */
export function activity(): Promise<Activity> {
  return get('/v1/activity', ActivitySchema);
}

/** The redacted tail of the process an Attempt waits on (ADR-0018). */
export function attemptTail(attemptId: string): Promise<AttemptTail> {
  return get(`/v1/attempts/${encodeURIComponent(attemptId)}/tail`, AttemptTailSchema);
}

/** The open Inbox Items, or every item with `all` (deferred and closed ones too). ADR-0016. */
export function inbox(all: boolean): Promise<Approval[]> {
  return get(`/v1/inbox${all ? '?all=true' : ''}`, z.array(ApprovalSchema));
}

export function inboxItem(id: string): Promise<Approval> {
  return get(`/v1/inbox/${encodeURIComponent(id)}`, ApprovalSchema);
}

/** The Job's plan approval view, or `null` while it has no Plan (`no_plan`). */
export async function planView(jobId: string): Promise<PlanView | null> {
  const path = `/v1/jobs/${encodeURIComponent(jobId)}/plan`;
  const res = await call(path, { method: 'GET' });
  if (res.status === 404) {
    const body = ApiErrorSchema.safeParse(await res.json());
    if (body.success && body.data.error === 'no_plan') return null;
  }
  if (!res.ok) throw new RuntimeApiError(res.status, path);
  return PlanViewSchema.parse(await res.json());
}

export function projects(): Promise<Project[]> {
  return get('/v1/projects', z.array(ProjectSchema));
}

export function repositories(): Promise<Repository[]> {
  return get('/v1/repositories', z.array(RepositorySchema));
}

/** An Artifact's record and its content (JSON, redacted when it was stored). */
export async function artifact(id: string): Promise<{ artifact: Artifact; content: unknown }> {
  const base = `/v1/artifacts/${encodeURIComponent(id)}`;
  const meta = await get(base, ArtifactSchema);
  const content = await get(`${base}/content`, z.unknown());
  return { artifact: meta, content };
}

export type InboxAction = 'decide' | 'answer' | 'defer' | 'undefer';

/** What the runtime said to a change: the item as it now is, or its refusal. */
export type InboxChangeResult =
  { ok: true; item: Approval } | { ok: false; status: number; error: string; message: string };

/**
 * Decides, answers, defers or undefers an Inbox Item through the runtime API, as
 * `user:local`. The body names the version (and, to decide, the subject and
 * option) the operator saw; the runtime refuses a stale one (ADR-0016).
 */
export async function changeInboxItem(
  id: string,
  action: InboxAction,
  body: {
    expectedVersion: number;
    subjectRef?: string;
    option?: string;
    comment?: string;
    /** `decide` on a Blocker Approval's `grant` option only: its size (ADR-0026). */
    grant?: number;
    /** `answer` only: one per answered question (ADR-0023). */
    answers?: { questionId: string; option?: string; text?: string }[];
  },
): Promise<InboxChangeResult> {
  const res = await call(`/v1/inbox/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body,
  });
  const json: unknown = await res.json();
  if (res.ok) return { ok: true, item: ApprovalSchema.parse(json) };
  const err = ApiErrorSchema.safeParse(json);
  return {
    ok: false,
    status: res.status,
    error: err.success ? err.data.error : 'unknown',
    message:
      err.success && err.data.message !== undefined
        ? err.data.message
        : `the runtime answered HTTP ${String(res.status)}`,
  };
}

/** The names an Inbox Item's ids stand for, and the plan views of its `plan` items' Jobs. */
export interface InboxContext {
  projects: ReadonlyMap<string, string>;
  repositories: ReadonlyMap<string, string>;
  plans: ReadonlyMap<string, PlanView | null>;
}

export async function inboxContext(items: readonly Approval[]): Promise<InboxContext> {
  const planJobs = [...new Set(items.filter((i) => i.kind === 'plan').map((i) => i.jobId))];
  const [ps, rs, plans] = await Promise.all([
    projects(),
    repositories(),
    Promise.all(planJobs.map(async (id) => [id, await planView(id)] as const)),
  ]);
  return {
    projects: new Map(ps.map((p) => [p.id, p.name])),
    repositories: new Map(rs.map((r) => [r.id, r.name])),
    plans: new Map(plans),
  };
}
