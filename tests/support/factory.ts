/**
 * The single test seam for Phase A. Scenarios start the runtime as a real child
 * process against a temporary factory home and talk to it only over HTTP (and,
 * later, SSE). Never import runtime internals or open the database here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { cliEntry, runtimeEntry } from './paths.js';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface TestHome {
  /** FACTORY_HOME for this test. */
  readonly dir: string;
  readonly workspaceRoot: string;
  /** Environment to run the CLI or runtime against this home. */
  readonly env: NodeJS.ProcessEnv;
  token(): string;
  cli(args: string[], opts?: { input?: string; env?: NodeJS.ProcessEnv }): Promise<CliResult>;
}

/** A fresh temporary directory, removed when the test finishes. */
export function tempDir(prefix = 'factory-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A temporary, not yet initialized factory home. */
export function emptyHome(): TestHome {
  const base = tempDir();
  const dir = join(base, 'home');
  const workspaceRoot = join(base, 'workspace');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: base,
    FACTORY_HOME: dir,
    FACTORY_PORT: '0',
  };
  return {
    dir,
    workspaceRoot,
    env,
    token: () => readFileSync(join(dir, 'token'), 'utf8').trim(),
    cli: (args, opts) => runCli(args, { env: { ...env, ...opts?.env }, input: opts?.input }),
  };
}

/** A temporary factory home initialized through `factory init`. */
export async function initializedHome(): Promise<TestHome> {
  const home = emptyHome();
  const res = await home.cli(['init', '--workspace-root', home.workspaceRoot]);
  if (res.code !== 0) throw new Error(`factory init failed: ${res.stderr}${res.stdout}`);
  return home;
}

export function runCli(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input?: string | undefined },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

export interface RequestOptions extends RequestInit {
  /** Override the bearer token: a string to send instead, or null to send none. */
  token?: string | null;
}

export interface RunningRuntime {
  readonly home: TestHome;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  request(path: string, init?: RequestOptions): Promise<Response>;
  /** Stops the runtime with SIGTERM and resolves with its exit code. */
  stop(): Promise<number | null>;
}

/**
 * Starts the runtime as a child process against a temporary, initialized home.
 * It is torn down (and the home removed) when the test finishes.
 */
export async function startRuntime(home?: TestHome): Promise<RunningRuntime> {
  const h = home ?? (await initializedHome());
  const child = spawn(process.execPath, [runtimeEntry], {
    env: h.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      resolve(code);
    }),
  );
  onTestFinished(async () => {
    await terminate(child, exited);
  });

  const record = await waitForRuntimeRecord(h.dir, child, () => output);
  const url = `http://${record.host}:${String(record.port)}`;
  return {
    home: h,
    url,
    host: record.host,
    port: record.port,
    pid: record.pid,
    request: (path, init = {}) => {
      const { token = h.token(), ...rest } = init;
      const headers = new Headers(rest.headers);
      if (token !== null) headers.set('authorization', `Bearer ${token}`);
      return fetch(url + path, { ...rest, headers });
    },
    stop: () => terminate(child, exited),
  };
}

async function terminate(child: ChildProcess, exited: Promise<number | null>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }
  return exited;
}

async function waitForRuntimeRecord(
  homeDir: string,
  child: ChildProcess,
  output: () => string,
): Promise<{ pid: number; host: string; port: number }> {
  const path = join(homeDir, 'runtime.json');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime exited with ${String(child.exitCode)} before ready:\n${output()}`);
    }
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as {
        pid: number;
        host: string;
        port: number;
      };
      if (record.pid === child.pid) return record;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`runtime did not become ready within 10s:\n${output()}`);
}
