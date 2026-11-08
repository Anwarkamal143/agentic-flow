/**
 * Security Tier 0, the local **guardrail** (ARCHITECTURE §11). It is not a
 * sandbox: the process runs as the operator's user and can reach anything that
 * user can. What it does guarantee for every process the factory starts on a
 * Worktree (a Harness Run, a verification command):
 *
 * - the environment is built from an explicit allowlist plus the factory's own
 *   variables, never inherited (`env -i` semantics), so secrets in the
 *   runtime's environment don't reach it;
 * - stdin is closed (`/dev/null`), so nothing can wait on a prompt;
 * - the working directory is the given Worktree;
 * - a wall-clock limit, after which the whole process group gets SIGTERM, then
 *   SIGKILL after a grace period.
 */
import { spawn } from 'node:child_process';

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
  /** Output beyond this many bytes is dropped (the end is kept). Default 1 MiB. */
  maxOutputBytes?: number;
  /** Time between SIGTERM and SIGKILL. Default 5 s. */
  graceMs?: number;
}

export interface GuardedExit {
  /** `null` when the process was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** stdout and stderr, interleaved as received. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface GuardedProcess {
  readonly pid: number | undefined;
  readonly exit: Promise<GuardedExit>;
  /** Stops the whole process group: SIGTERM, then SIGKILL after the grace period. */
  cancel(): Promise<GuardedExit>;
}

export function spawnGuarded(opts: GuardedOptions): GuardedProcess {
  const started = Date.now();
  const max = opts.maxOutputBytes ?? 1024 * 1024;
  const grace = opts.graceMs ?? 5_000;
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the whole tree can be signalled.
    detached: true,
  });
  let chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const collect = (d: Buffer) => {
    chunks.push(d);
    size += d.length;
    if (size > max * 2) {
      const all = Buffer.concat(chunks);
      chunks = [all.subarray(all.length - max)];
      size = max;
      truncated = true;
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let timedOut = false;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const stop = () => {
    signalGroup('SIGTERM');
    killTimer ??= setTimeout(() => {
      signalGroup('SIGKILL');
    }, grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.timeoutMs);

  const exit = new Promise<GuardedExit>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Children left in the group must not outlive the run.
      signalGroup('SIGKILL');
      let all = Buffer.concat(chunks);
      if (all.length > max) {
        all = all.subarray(all.length - max);
        truncated = true;
      }
      resolve({
        code,
        signal,
        timedOut,
        cancelled,
        output: all.toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => {
      chunks.push(Buffer.from(`failed to start ${opts.command}: ${err.message}\n`));
      finish(127, null);
    });
    child.on('close', finish);
  });

  return {
    pid: child.pid,
    exit,
    cancel: () => {
      cancelled = true;
      stop();
      return exit;
    },
  };
}
