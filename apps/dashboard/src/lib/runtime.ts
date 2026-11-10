/**
 * The dashboard's only way to the factory's state: the runtime HTTP API
 * (CLAUDE.md "One writer"). Server-side only. It reads the API token and the
 * runtime record from the factory home (FACTORY_HOME, default `~/.factory`),
 * so the token never reaches the browser. Every response is parsed against
 * the `@factory/domain` contract, so the pages show only what was persisted
 * and understood. Only GET requests are made: the dashboard is read-only.
 */
import {
  AcceptanceCriterionSchema,
  ActivitySchema,
  AttemptTailSchema,
  AttemptSchema,
  FactoryEventSchema,
  JobSchema,
  JobSummarySchema,
  ReviewSchema,
  TaskSchema,
  type AcceptanceCriterion,
  type Activity,
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

async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
  const rt = connect();
  let res: Response;
  try {
    res = await fetch(rt.url + path, {
      headers: { authorization: `Bearer ${rt.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new RuntimeUnavailable(
      `The factory runtime at ${rt.url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
