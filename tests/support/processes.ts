/**
 * Process helpers for the cancellation and recovery scenarios. They look at
 * processes from the outside (signals, `ps`), never at runtime internals.
 */
import { execFileSync } from 'node:child_process';
import { onTestFinished } from 'vitest';
import type { RunningRuntime } from './factory.js';

/** Whether any process is left in the process group `pgid` (or the process `pgid`). */
export function groupAlive(pgid: number): boolean {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
}

/** Kills a process group; nothing happens when it is already gone. */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * The process groups the factory started for this runtime's home: their
 * leader is the guardrail's wrapper, whose command line names its spool
 * under the home.
 */
export function factoryGroups(home: string): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter(
      (m): m is RegExpExecArray => m !== null && (m[2] ?? '').includes(`factory-guard ${home}`),
    )
    .map((m) => Number(m[1]));
}

/**
 * A crashed runtime leaves its Harness processes running (that is the point);
 * this kills whatever is left of them when the test finishes.
 */
export function killGroupsOnFinish(rt: RunningRuntime): void {
  onTestFinished(() => {
    for (const pgid of factoryGroups(rt.home.dir)) killGroup(pgid);
  });
}

export async function waitFor(
  done: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
