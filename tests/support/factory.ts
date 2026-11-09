/**
 * The single test seam for Phase A. Scenarios start the runtime as a real child
 * process against a temporary factory home and talk to it only over HTTP (and,
 * later, SSE). Never import runtime internals or open the database here.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { cliEntry, runtimeEntry, tinyTsScript } from './paths.js';

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

/** The Fake Harness's message for a Run its script has no response for (`FAKE_SCRIPT_EXHAUSTED`). */
const FAKE_SCRIPT_EXHAUSTED = 'fake harness: the script has no response';

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
  /** Everything the runtime wrote to stdout and stderr so far. */
  output(): string;
  /** Stops the runtime with SIGTERM and resolves with its exit code. */
  stop(): Promise<number | null>;
  /** Kills the runtime with SIGKILL (a crash: no shutdown runs) and waits for it to be gone. */
  kill(): Promise<void>;
  /** Settles when the runtime process has exited, by itself or otherwise. */
  readonly exited: Promise<number | null>;
}

/**
 * Starts the runtime as a child process against a temporary, initialized home.
 * It is torn down (and the home removed) when the test finishes. `opts.env` is
 * merged over the home's environment (for example a restricted PATH).
 */
export async function startRuntime(
  home?: TestHome,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<RunningRuntime> {
  const h = home ?? (await initializedHome());
  const child = spawn(process.execPath, [runtimeEntry], {
    env: { ...h.env, ...opts?.env },
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
  // An exhausted Fake Harness script is a bug in the test, never an expected outcome:
  // a scenario that passed only because a Run found no response is a false green.
  onTestFinished(() => {
    const line = output.split('\n').find((l) => l.includes(FAKE_SCRIPT_EXHAUSTED));
    if (line !== undefined) {
      throw new Error(
        `the Fake Harness script ran out during this test (${line.trim()}); script every Run the scenario causes`,
      );
    }
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
    output: () => output,
    stop: () => terminate(child, exited),
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
    exited,
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

/**
 * A temporary directory of fake executables, for use as PATH. Each entry maps a
 * command name to the body of a POSIX shell script (`$1` is the first argument).
 */
export function fakeBin(tools: Record<string, string>): string {
  const dir = join(tempDir('factory-bin-'), 'bin');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(tools)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** A fake tool body that prints `output` for `--version` and fails otherwise. */
export function versionTool(output: string, otherwise = 'exit 1'): string {
  return `if [ "$1" = "--version" ]; then\n  printf '%s\\n' '${output}'\n  exit 0\nfi\n${otherwise}`;
}

/**
 * A fresh `tiny-ts` fixture Repository, made by the fixture generator script
 * (never a committed nested repo). Returns the path of its checkout.
 */
export function tinyTsRepo(): string {
  const dir = join(tempDir('factory-repo-'), 'tiny-ts');
  execFileSync(process.execPath, [tinyTsScript, dir], { stdio: 'pipe' });
  return dir;
}

/** Runs git with no user or system config, so tests never depend on the machine's setup. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

/**
 * Selects the Fake Harness for this home through runtime configuration: writes
 * `script` (YAML) next to the home and points `config.json` at it. Call before
 * `startRuntime`.
 */
export function useFakeHarness(home: TestHome, script: string): string {
  const path = join(home.dir, '..', 'fake-harness.yaml');
  writeFileSync(path, script);
  const configPath = join(home.dir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config['harness'] = { id: 'fake', script: path };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return path;
}
