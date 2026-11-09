/**
 * `factory logs <job>`: the Harness and verification output of a Job's
 * Attempts, through the runtime API. Everything shown was redacted before the
 * runtime stored it (ADR-0011).
 */
import type { JobLogEntry } from '@factory/domain';
import { resolveHome } from '@factory/home';
import { findRuntime } from '../client.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

export async function logs(jobId: string, opts: { json: boolean }): Promise<number> {
  const found = findRuntime(resolveHome());
  if (found.kind === 'not_running') {
    process.stderr.write('Runtime: not running. Run: factory start\n');
    return EXIT_NOT_RUNNING;
  }
  const entries = await found.client.json<JobLogEntry[]>(
    'GET',
    `/v1/jobs/${encodeURIComponent(jobId)}/logs`,
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(`No logs for Job ${jobId} yet.\n`);
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(`== ${heading(entry)}\n`);
    const output = entry.content.output.replace(/\n$/, '');
    process.stdout.write(output === '' ? '   (no output)\n' : indent(output) + '\n');
    process.stdout.write('\n');
  }
  return 0;
}

function heading(entry: JobLogEntry): string {
  const where = `${entry.taskKey} Attempt ${String(entry.attemptN)}`;
  const c = entry.content;
  if (c.source === 'harness') {
    const run = c.n === 1 ? '' : ` #${String(c.n)} (re-prompt)`;
    return `${where}: ${c.role} Harness Run${run} (${c.harnessId}), ${exitText(c.exit)}`;
  }
  const status = c.timedOut ? 'timed out' : `exit ${String(c.exitCode)}`;
  return `${where}: verification ${c.key}: ${c.command} → ${status}${c.truncated ? ' (output truncated)' : ''}`;
}

function exitText(exit: Extract<JobLogEntry['content'], { source: 'harness' }>['exit']): string {
  if (exit.kind === 'exited') return `exited with code ${String(exit.code)}`;
  if (exit.kind === 'timed_out') return `timed out after ${String(exit.afterMs)} ms`;
  return 'was cancelled';
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}
