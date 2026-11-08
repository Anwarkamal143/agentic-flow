import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { DoctorReport } from './doctor.js';

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

  app.post('/v1/shutdown', (c) => {
    setImmediate(() => {
      deps.requestShutdown();
    });
    return c.json({ state: 'stopping' }, 202);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

/** Fixed-length digests so the comparison is constant-time regardless of input length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
