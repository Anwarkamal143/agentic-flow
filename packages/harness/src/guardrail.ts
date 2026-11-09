/**
 * Security Tier 0, the local **guardrail** (ARCHITECTURE §11). It is not a
 * sandbox: the process runs as the operator's user and can reach anything that
 * user can. What it does guarantee for every process the factory starts on a
 * Worktree (a Harness Run, a verification command):
 *
 * - the environment is built from an explicit allowlist plus the factory's own
 *   variables, never inherited (`env -i` semantics), so secrets in the
 *   runtime's environment don't reach it;
 * - stdin is closed (`/dev/null`), or a file the factory wrote (the prompt),
 *   so nothing can wait on a prompt;
 * - the working directory is the given Worktree;
 * - a wall-clock limit, after which the whole process group gets SIGTERM, then
 *   SIGKILL after a grace period.
 *
 * Every guarded process has a **spool**: a directory the runtime owns, where a
 * small `sh` wrapper (the process group's leader) writes the process's start
 * time, its pid, its output and, when it exits, its exit status. Nothing about
 * the process depends on the runtime staying alive (no pipes), so a runtime
 * that crashed can find it again, check it is still the same process (pid plus
 * start time), and re-attach to it, or read what it left (ADR-0012). The
 * output in the spool is raw; the runtime reads it through its redaction and
 * removes the spool once the process's end is recorded.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Variables passed through from the runtime's environment, when set. Nothing else is. */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TZ',
];

/**
 * The complete environment of a guarded process: the allowlisted variables of
 * `source`, then `factory` (the factory's own, e.g. ports and ids) on top.
 */
export function guardrailEnv(
  source: NodeJS.ProcessEnv,
  factory: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...factory };
}

export interface GuardedOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete environment (see {@link guardrailEnv}). */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** A directory for this process alone (created if missing); see the module comment. */
  spool: string;
  /** Output beyond this many bytes is dropped (the end is kept). Default 1 MiB. */
  maxOutputBytes?: number;
  /** Time between SIGTERM and SIGKILL. Default 5 s. */
  graceMs?: number;
  /**
   * The process's stdin, written to a file in the spool first. Without it,
   * stdin is `/dev/null`. Either way it is a file that ends, so nothing can
   * wait on a prompt.
   */
  input?: string;
}

export interface GuardedExit {
  /** `null` when the process was killed by a signal, or its exit status is unknown. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** stdout and stderr, interleaved as written. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface GuardedProcess {
  /** The wrapper's pid, which is also the process group id. */
  readonly pid: number | undefined;
  readonly exit: Promise<GuardedExit>;
  /**
   * Stops the whole process group: SIGTERM, then SIGKILL once the grace period
   * is over and any process of the group is left. Settles when the group is gone.
   */
  cancel(): Promise<GuardedExit>;
}

/** How a spooled process stands, as found from its spool (see {@link inspectSpool}). */
export type SpoolState =
  { state: 'none' } | { state: 'alive' | 'finished' | 'dead'; pid: number | undefined };

const WRAPPER = [
  'spool=$1; shift',
  'LC_ALL=C TZ=UTC ps -o lstart= -p $$ > "$spool/start.tmp" && mv "$spool/start.tmp" "$spool/start"',
  'echo $$ > "$spool/pid.tmp" && mv "$spool/pid.tmp" "$spool/pid"',
  'in=/dev/null; if [ -f "$spool/input" ]; then in="$spool/input"; fi',
  '"$@" > "$spool/output" 2>&1 < "$in"',
  'code=$?',
  'echo $code > "$spool/exit.tmp" && mv "$spool/exit.tmp" "$spool/exit"',
  'exit $code',
].join('\n');

const POLL_MS = 100;

export function spawnGuarded(opts: GuardedOptions): GuardedProcess {
  mkdirSync(opts.spool, { recursive: true, mode: 0o700 });
  if (opts.input !== undefined) {
    writeFileSync(join(opts.spool, 'input'), opts.input, { mode: 0o600 });
  }
  const child = spawn(
    'sh',
    ['-c', WRAPPER, 'factory-guard', opts.spool, opts.command, ...opts.args],
    {
      cwd: opts.cwd,
      env: { ...opts.env },
      stdio: 'ignore',
      // Its own process group, so the whole tree can be signalled, and so it outlives the runtime.
      detached: true,
    },
  );
  child.unref();
  let failedToStart: string | undefined;
  const leaderExit = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on('error', (err) => {
      failedToStart = `failed to start ${opts.command}: ${err.message}\n`;
      resolve(null);
    });
    child.on('exit', (_code, signal) => {
      resolve(signal);
    });
  });
  return supervise(opts, child.pid, leaderExit, () => failedToStart, Date.now());
}

/**
 * Re-attaches to a spooled process a previous runtime started: settles when it
 * is gone (or at once, if it already is), with what its spool holds. The time
 * limit counts from `startedAt`. `undefined` when the spool holds no process.
 */
export function attachGuarded(opts: {
  spool: string;
  startedAt: number;
  timeoutMs: number;
  maxOutputBytes?: number;
  graceMs?: number;
}): GuardedProcess | undefined {
  const found = inspectSpool(opts.spool);
  if (found.state === 'none') return undefined;
  const { pid } = found;
  const leaderExit = new Promise<NodeJS.Signals | null>((resolve) => {
    const poll = () => {
      const now = inspectSpool(opts.spool);
      if (now.state === 'alive') setTimeout(poll, POLL_MS);
      else resolve(null);
    };
    poll();
  });
  return supervise(
    { ...opts, timeoutMs: Math.max(0, opts.startedAt + opts.timeoutMs - Date.now()) },
    pid,
    leaderExit,
    () => undefined,
    opts.startedAt,
  );
}

/**
 * Whether the spool's process is `alive` (and provably the one started there:
 * same pid, same start time), `finished` (its exit status was written), or
 * `dead` (gone without one). `none`: no spool, or it never got a pid.
 */
export function inspectSpool(spool: string): SpoolState {
  if (!existsSync(spool)) return { state: 'none' };
  const pid = readNumber(join(spool, 'pid'));
  if (existsSync(join(spool, 'exit'))) return { state: 'finished', pid };
  if (pid === undefined) return { state: 'none' };
  const start = readText(join(spool, 'start'))?.trim();
  const alive = start !== undefined && start !== '' && processStartTime(pid) === start;
  return { state: alive ? 'alive' : 'dead', pid };
}

/** The process's start time as `ps` reports it (C locale, UTC), or `undefined` when it is gone. */
export function processStartTime(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** Whether any process is left in the group `pgid`. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function supervise(
  opts: { spool: string; timeoutMs: number; maxOutputBytes?: number; graceMs?: number },
  pid: number | undefined,
  leaderExit: Promise<NodeJS.Signals | null>,
  startError: () => string | undefined,
  startedAt: number,
): GuardedProcess {
  const max = opts.maxOutputBytes ?? 1024 * 1024;
  const grace = opts.graceMs ?? 5_000;
  let timedOut = false;
  let cancelled = false;
  let stopping: Promise<void> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  /** SIGTERM to the group; SIGKILL when the grace period ends with any of it left. */
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      signalGroup('SIGTERM');
      const deadline = Date.now() + grace;
      while (pid !== undefined && groupAlive(pid) && Date.now() < deadline) {
        await sleep(POLL_MS);
      }
      if (pid !== undefined && groupAlive(pid)) signalGroup('SIGKILL');
    })();
    return stopping;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, opts.timeoutMs);

  const exit = (async (): Promise<GuardedExit> => {
    const signal = await leaderExit;
    clearTimeout(timer);
    if (stopping === undefined) {
      // Children left in the group must not outlive the run.
      signalGroup('SIGKILL');
    } else {
      await stopping;
    }
    const code = readNumber(join(opts.spool, 'exit')) ?? null;
    const { text, truncated } = readTail(join(opts.spool, 'output'), max);
    return {
      code: startError() === undefined ? code : 127,
      signal,
      timedOut,
      cancelled,
      output: (startError() ?? '') + text,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  })();

  return {
    pid,
    exit,
    cancel: async () => {
      cancelled = true;
      await stop();
      return exit;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readNumber(path: string): number | undefined {
  const text = readText(path)?.trim();
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  return Number(text);
}

/** The last `max` bytes of a file. */
function readTail(path: string, max: number): { text: string; truncated: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return { text: buf.toString('utf8'), truncated: size > max };
  } finally {
    closeSync(fd);
  }
}
