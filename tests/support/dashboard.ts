/**
 * The dashboard as a scenario sees it: the built Next.js app (`next start`,
 * from `pnpm build`) as a child process against a test's factory home, spoken
 * to over HTTP only, like a browser that runs no scripts.
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { TestHome } from './factory.js';
import { dashboardDir } from './paths.js';

export interface RunningDashboard {
  readonly url: string;
  readonly port: number;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** The page's HTML; fails on a non-2xx status unless `status` says otherwise. */
  html(path: string, status?: number): Promise<string>;
  /** A raw GET with this `Host` header (fetch can't set one). Resolves with the status. */
  getWithHost(path: string, host: string): Promise<number>;
  output(): string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

/** Starts the built dashboard against `home`. Torn down when the test finishes. */
export async function startDashboard(home: TestHome): Promise<RunningDashboard> {
  const port = await freePort();
  const next = join(dashboardDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(
    process.execPath,
    [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: dashboardDir,
      env: { ...home.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve();
    });
  });
  onTestFinished(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    // `next start` waits for open streams on SIGTERM; a test doesn't.
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await exited;
    clearTimeout(timer);
  });

  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dashboard exited before ready:\n${output}`);
    try {
      const res = await fetch(`${url}/`);
      await res.body?.cancel();
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`dashboard not ready within 20s:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const request = (path: string, init?: RequestInit) => fetch(url + path, init);
  return {
    url,
    port,
    request,
    html: async (path, status) => {
      const res = await request(path);
      const body = await res.text();
      if (status === undefined ? !res.ok : res.status !== status) {
        throw new Error(
          `GET ${path}: HTTP ${String(res.status)}\n${body.slice(0, 500)}\n${output}`,
        );
      }
      return body;
    },
    getWithHost: (path, host) =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      }),
    output: () => output,
  };
}
