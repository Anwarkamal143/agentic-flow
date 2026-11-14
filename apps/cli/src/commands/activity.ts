/**
 * `factory activity`: what is running right now (ADR-0018), through the
 * runtime API. Every running Attempt with its Job, Task, Harness, model,
 * Repository, tier, heartbeat and port block, and the redacted tail of the
 * process it waits on.
 */
import {
  ActivitySchema,
  AttemptTailSchema,
  MODEL_UNKNOWN_LABEL,
  type ActivityAttempt,
  type AttemptTail,
} from '@factory/domain';
import { resolveHome } from '@factory/home';
import { findRuntime } from '../client.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

/** Tail lines shown per Attempt unless `--lines` says otherwise (`--json` has them all). */
export const DEFAULT_TAIL_LINES = 20;

export async function activity(opts: { json: boolean; lines: number }): Promise<number> {
  const found = findRuntime(resolveHome());
  if (found.kind === 'not_running') {
    process.stderr.write('Runtime: not running. Run: factory start\n');
    return EXIT_NOT_RUNNING;
  }
  const { client } = found;
  const current = ActivitySchema.parse(await client.json('GET', '/v1/activity'));
  const tails = await Promise.all(
    current.attempts.map(async (a) =>
      AttemptTailSchema.parse(
        await client.json('GET', `/v1/attempts/${encodeURIComponent(a.attemptId)}/tail`),
      ),
    ),
  );
  if (opts.json) {
    const attempts = current.attempts.map((a, i) => ({ ...a, tail: tails[i] }));
    process.stdout.write(JSON.stringify({ at: current.at, attempts }, null, 2) + '\n');
    return 0;
  }
  if (current.attempts.length === 0) {
    process.stdout.write('Nothing is running.\n');
    return 0;
  }
  current.attempts.forEach((a, i) => {
    process.stdout.write(describe(a));
    const tail = tails[i];
    if (tail !== undefined) process.stdout.write(renderTail(tail, opts.lines));
    process.stdout.write('\n');
  });
  return 0;
}

function describe(a: ActivityAttempt): string {
  const harness =
    a.harness.version === null ? a.harness.id : `${a.harness.id} ${a.harness.version}`;
  const heartbeat =
    a.heartbeat === null
      ? 'heartbeat: none (no Task lease)'
      : `heartbeat ${String(Math.round(a.heartbeat.ageMs / 1000))}s ago`;
  return [
    `== ${a.task.key} Attempt ${String(a.n)} (${a.state}) · Job ${a.job.id} "${a.job.title}"`,
    `   Repository ${a.repository.name} · Harness ${harness} · model ${a.model ?? MODEL_UNKNOWN_LABEL}`,
    `   ${a.tierLabel}: ${a.tierDetail}`,
    `   ${heartbeat} · ports ${String(a.ports.base)}–${String(a.ports.base + a.ports.size - 1)} · started ${a.startedAt}`,
    '',
  ].join('\n');
}

function renderTail(tail: AttemptTail, max: number): string {
  if (tail.process === null) return '   (no process running right now)\n';
  const lines = tail.lines.slice(Math.max(0, tail.lines.length - max));
  const head = `   -- ${tail.process.label} output, last ${String(lines.length)} line${lines.length === 1 ? '' : 's'} (redacted)\n`;
  if (lines.length === 0) return `${head}   (no output yet)\n`;
  return head + lines.map((l) => `   ${l}`).join('\n') + '\n';
}
