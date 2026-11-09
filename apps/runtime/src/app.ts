import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CancelJobInputSchema,
  CreateJobInputSchema,
  InspectRepositoryInputSchema,
  ProjectConfigSchema,
  RegisterRepositoryInputSchema,
  type ApiError,
  type JobLogEntry,
} from '@factory/domain';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import type { DoctorReport } from './doctor.js';
import type { Outbox } from './outbox.js';
import { MAX_EVENT_PAGE } from './events.js';
import { ApiFailure } from './errors.js';
import type { JobService } from './jobs.js';
import type { RepositoryService } from './repositories.js';

export interface RuntimeStatus {
  state: 'running' | 'stopping';
  pid: number;
  version: string;
  startedAt: string;
  uptimeMs: number;
  host: string;
  port: number;
  home: string;
  workspaceRoot: string;
  database: { journalMode: string; migrations: number };
  /** The Harness chosen by runtime configuration, or `null` when none is. */
  harness: { id: string; version: string | null; installed: boolean } | null;
}

export interface AppDeps {
  token: string;
  status(): RuntimeStatus;
  /** Runs the environment checks (tools, credential presence). */
  doctor(): Promise<DoctorReport>;
  repositories: RepositoryService;
  jobs: JobService;
  artifacts: ArtifactStore;
  /** The (redacted) Harness and verification output of a Job's Attempts. */
  logs(jobId: string): JobLogEntry[];
  outbox: Outbox;
  /** Begins a graceful shutdown after the response is sent. */
  requestShutdown(): void;
}

/**
 * The runtime HTTP API. Every route, without exception, requires the bearer
 * token from the factory home (ARCHITECTURE §1).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const expected = digest(deps.token);

  app.use('*', async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '');
    if (match?.[1] === undefined || !timingSafeEqual(digest(match[1]), expected)) {
      return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
    }
    await next();
  });

  app.get('/v1/status', (c) => c.json(deps.status()));

  app.get('/v1/doctor', async (c) => c.json(await deps.doctor()));

  app.get('/v1/projects', (c) => c.json(deps.repositories.listProjects()));
  app.post('/v1/projects/:id/config', async (c) => {
    const config = await parseBody(c, ProjectConfigSchema);
    return c.json(deps.repositories.updateProjectConfig(c.req.param('id'), config));
  });
  app.get('/v1/repositories', (c) => c.json(deps.repositories.listRepositories()));
  app.post('/v1/repositories/inspect', async (c) => {
    const input = await parseBody(c, InspectRepositoryInputSchema);
    return c.json(await deps.repositories.inspect(input.path));
  });
  app.post('/v1/repositories', async (c) => {
    const input = await parseBody(c, RegisterRepositoryInputSchema);
    return c.json(await deps.repositories.register(input), 201);
  });

  app.get('/v1/jobs', (c) => c.json(deps.jobs.list()));
  app.post('/v1/jobs', async (c) => {
    const input = await parseBody(c, CreateJobInputSchema);
    return c.json(deps.jobs.create(input), 201);
  });
  app.get('/v1/jobs/:id', (c) => c.json(deps.jobs.get(c.req.param('id'))));
  app.get('/v1/jobs/:id/artifacts', (c) => {
    const id = c.req.param('id');
    deps.jobs.get(id); // 404 for an unknown Job
    return c.json(deps.artifacts.listForJob(id));
  });
  app.get('/v1/jobs/:id/acceptance-criteria', (c) =>
    c.json(deps.jobs.acceptanceCriteria(c.req.param('id'))),
  );
  app.get('/v1/jobs/:id/tasks', (c) => c.json(deps.jobs.tasks(c.req.param('id'))));
  app.get('/v1/jobs/:id/attempts', (c) => c.json(deps.jobs.attempts(c.req.param('id'))));
  app.get('/v1/jobs/:id/reviews', (c) => c.json(deps.jobs.reviews(c.req.param('id'))));
  app.get('/v1/jobs/:id/logs', (c) => {
    const id = c.req.param('id');
    deps.jobs.get(id); // 404 for an unknown Job
    return c.json(deps.logs(id));
  });
  app.get('/v1/jobs/:id/worktrees', (c) => c.json(deps.jobs.worktrees(c.req.param('id'))));
  app.get('/v1/artifacts/:id', (c) => c.json(deps.artifacts.get(c.req.param('id'))));
  /** The exact bytes the content hash was computed over. */
  app.get('/v1/artifacts/:id/content', (c) => {
    const bytes = deps.artifacts.readContent(c.req.param('id'));
    return c.body(new Uint8Array(bytes), 200, { 'content-type': 'application/json' });
  });
  app.get('/v1/jobs/:id/events', (c) => {
    const id = c.req.param('id');
    deps.jobs.get(id); // 404 for an unknown Job
    const q = parseQuery(c, EventPageQuerySchema);
    return c.json(deps.outbox.list({ ...q, jobId: id }));
  });
  app.get('/v1/events', (c) => {
    const { job, ...q } = parseQuery(
      c,
      EventPageQuerySchema.extend({ job: z.string().optional() }),
    );
    return c.json(deps.outbox.list({ ...q, jobId: job }));
  });
  /**
   * The live event stream. Resumes after `Last-Event-ID` (or `?after=`);
   * with neither, it starts at the current end of the log. `?job=` limits it to
   * one Job. Each SSE `id` is the event's `seq`.
   */
  app.get('/v1/events/stream', (c) => {
    const q = parseQuery(
      c,
      z.object({ job: z.string().optional(), after: EventPageQuerySchema.shape.after }),
    );
    const lastEventId = c.req.header('last-event-id');
    const after =
      lastEventId === undefined
        ? (q.after ?? deps.outbox.head())
        : validated(z.coerce.number().int().nonnegative(), lastEventId);
    if (q.job !== undefined) deps.jobs.get(q.job); // 404 for an unknown Job
    const res = streamSSE(c, async (stream) => {
      const ended = new Promise<void>((resolve) => {
        const sub = deps.outbox.subscribe({
          after,
          ...(q.job === undefined ? {} : { jobId: q.job }),
          send: (event) =>
            stream.writeSSE({
              id: String(event.seq),
              event: 'factory',
              data: JSON.stringify(event),
            }),
          onClose: resolve,
        });
        stream.onAbort(() => {
          sub.close();
        });
      });
      const keepAlive = setInterval(() => {
        void stream.write(': keep-alive\n\n');
      }, 15_000);
      await ended;
      clearInterval(keepAlive);
    });
    // A stream's socket is never reused; this lets shutdown close it as soon as the stream ends.
    res.headers.set('connection', 'close');
    return res;
  });
  app.post('/v1/jobs/:id/cancel', async (c) => {
    const input = await parseBody(c, CancelJobInputSchema);
    return c.json(await deps.jobs.cancel(c.req.param('id'), input));
  });

  app.post('/v1/shutdown', (c) => {
    setImmediate(() => {
      deps.requestShutdown();
    });
    return c.json({ state: 'stopping' }, 202);
  });

  app.notFound((c) => c.json({ error: 'not_found' } satisfies ApiError, 404));
  app.onError((err, c) => {
    if (err instanceof ApiFailure) {
      return c.json({ error: err.code, message: err.message } satisfies ApiError, err.status);
    }
    process.stderr.write(
      `factory runtime: ${c.req.method} ${c.req.path} failed: ${err.stack ?? err.message}\n`,
    );
    return c.json({ error: 'internal' } satisfies ApiError, 500);
  });
  return app;
}

const EventPageQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EVENT_PAGE).optional(),
});

function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  return validated(schema, c.req.query());
}

/** Parses a JSON request body against a schema, failing with 400 `invalid_request`. */
async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  return validated(schema, await c.req.json().catch(() => undefined));
}

function validated<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new ApiFailure(400, 'invalid_request', message);
  }
  return parsed.data;
}

/** Fixed-length digests so the comparison is constant-time regardless of input length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
