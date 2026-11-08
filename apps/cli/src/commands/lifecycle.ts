import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isProcessAlive,
  readConfig,
  readRuntimeRecord,
  readToken,
  resolveHome,
  runtimeUrl,
} from '@factory/home';
import { findRuntime, RuntimeClient } from '../client.js';

/** Exit code for `status` when the runtime is not running (LSB convention). */
export const EXIT_NOT_RUNNING = 3;

interface StatusBody {
  state: string;
  pid: number;
  version: string;
  uptimeMs: number;
  host: string;
  port: number;
  workspaceRoot: string;
  database: { journalMode: string; migrations: number };
}

export async function start(): Promise<number> {
  const home = resolveHome();
  const token = readToken(home);
  if (readConfig(home) === undefined || token === undefined) {
    process.stderr.write(`Factory home ${home.root} is not initialized. Run: factory init\n`);
    return 1;
  }
  const found = findRuntime(home);
  if (found.kind === 'running') {
    process.stdout.write(
      `Runtime already running (pid ${String(found.record.pid)}) at ${found.client.url}\n`,
    );
    return 0;
  }

  const entry = fileURLToPath(import.meta.resolve('@factory/runtime'));
  const log = openSync(home.runtimeLogPath, 'a', 0o600);
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  closeSync(log);
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('failed to spawn the runtime process');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break;
    const record = readRuntimeRecord(home);
    if (record?.pid === pid) {
      const client = new RuntimeClient(runtimeUrl(record), token);
      const res = await client.request('GET', '/v1/status').catch(() => undefined);
      if (res?.ok === true) {
        process.stdout.write(`Runtime started (pid ${String(pid)}) at ${client.url}\n`);
        process.stdout.write(`  log: ${home.runtimeLogPath}\n`);
        return 0;
      }
    }
    await sleep(100);
  }
  process.stderr.write(
    `Runtime failed to start (pid ${String(pid)}). See the log: ${home.runtimeLogPath}\n`,
  );
  return 1;
}

export async function status(opts: { json: boolean }): Promise<number> {
  const home = resolveHome();
  const found = findRuntime(home);
  if (found.kind === 'not_running') {
    if (opts.json) process.stdout.write(JSON.stringify({ state: 'not_running' }) + '\n');
    else process.stdout.write('Runtime: not running\n');
    return EXIT_NOT_RUNNING;
  }
  let body: StatusBody;
  try {
    body = await found.client.json<StatusBody>('GET', '/v1/status');
  } catch (err) {
    process.stderr.write(
      `Runtime process ${String(found.record.pid)} exists but is not responding at ` +
        `${found.client.url}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(body) + '\n');
    return 0;
  }
  process.stdout.write(
    `Runtime: ${body.state}\n` +
      `  pid:            ${String(body.pid)}\n` +
      `  url:            http://${body.host}:${String(body.port)}\n` +
      `  version:        ${body.version}\n` +
      `  uptime:         ${formatUptime(body.uptimeMs)}\n` +
      `  workspace root: ${body.workspaceRoot}\n` +
      `  database:       journal ${body.database.journalMode}, ${String(body.database.migrations)} migration(s) applied\n`,
  );
  return 0;
}

export async function stop(): Promise<number> {
  const home = resolveHome();
  const found = findRuntime(home);
  if (found.kind === 'not_running') {
    process.stdout.write('Runtime: not running\n');
    return 0;
  }
  const { pid } = found.record;
  try {
    await found.client.json('POST', '/v1/shutdown');
  } catch (err) {
    // Never signal a pid we could not confirm is our runtime (pid reuse).
    process.stderr.write(
      `Could not ask runtime pid ${String(pid)} to stop at ${found.client.url}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (await waitForExit(pid, 10_000)) {
    process.stdout.write(`Runtime stopped (pid ${String(pid)})\n`);
    return 0;
  }
  process.stderr.write(`Runtime pid ${String(pid)} did not exit within 10s\n`);
  return 1;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
