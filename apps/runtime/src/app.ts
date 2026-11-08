import { createHash, timingSafeEqual } from 'node:crypto';
import {
  InspectRepositoryInputSchema,
  RegisterRepositoryInputSchema,
  type ApiError,
} from '@factory/domain';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import type { DoctorReport } from './doctor.js';
import { ApiFailure } from './errors.js';
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
}

export interface AppDeps {
  token: string;
  status(): RuntimeStatus;
  /** Runs the environment checks (tools, credential presence). */
  doctor(): Promise<DoctorReport>;
  repositories: RepositoryService;
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
  app.get('/v1/repositories', (c) => c.json(deps.repositories.listRepositories()));
  app.post('/v1/repositories/inspect', async (c) => {
    const input = await parseBody(c, InspectRepositoryInputSchema);
    return c.json(await deps.repositories.inspect(input.path));
  });
  app.post('/v1/repositories', async (c) => {
    const input = await parseBody(c, RegisterRepositoryInputSchema);
    return c.json(await deps.repositories.register(input), 201);
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

/** Parses a JSON request body against a schema, failing with 400 `invalid_request`. */
async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
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
