import { resolveHome } from '@factory/home';
import { findRuntime } from '../client.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

const DOCTOR_TIMEOUT_MS = 30_000;

/** The `GET /v1/doctor` body, as far as the CLI renders it. */
interface DoctorBody {
  checkedAt: string;
  tools: {
    name: string;
    command: string;
    status: 'ok' | 'missing' | 'failed';
    version?: string;
    path?: string;
    fix?: string;
    notes?: string[];
  }[];
  credentials: { name: string; source: string; present: boolean }[];
  billing:
    | { mode: 'subscription' }
    | { mode: 'api_key'; credential: string; present: boolean; exposure: string }
    | null;
}

/**
 * Renders the runtime's environment checks. Detection happens in the runtime
 * (it is the process that will run the tools); the CLI only displays it.
 * Missing tools are findings, not errors: the command exits 0 once it has a report.
 */
export async function doctor(opts: { json: boolean }): Promise<number> {
  const home = resolveHome();
  const found = findRuntime(home);
  if (found.kind === 'not_running') {
    process.stderr.write(
      'Runtime: not running. factory doctor checks the environment the runtime sees.\n' +
        'Run: factory start\n',
    );
    return EXIT_NOT_RUNNING;
  }
  let body: DoctorBody;
  try {
    // The runtime runs probes with their own timeouts (ADR-0003); allow for them.
    body = await found.client.json<DoctorBody>('GET', '/v1/doctor', {
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });
  } catch (err) {
    process.stderr.write(
      `Runtime process ${String(found.record.pid)} did not answer the doctor request at ` +
        `${found.client.url}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(body) + '\n');
    return 0;
  }

  const nameWidth = Math.max(...body.tools.map((t) => t.name.length)) + 2;
  const versionWidth = Math.max(...body.tools.map((t) => (t.version ?? '').length)) + 2;
  const lines = ['Tools (as seen on the runtime PATH):'];
  for (const tool of body.tools) {
    const name = tool.name.padEnd(nameWidth);
    if (tool.status === 'ok') {
      lines.push(
        `  ok       ${name}${(tool.version ?? '').padEnd(versionWidth)}${tool.path ?? ''}`,
      );
    } else {
      lines.push(
        `  ${tool.status.padEnd(9)}${name}${tool.status === 'missing' ? 'not found' : (tool.version ?? 'version unknown')}`,
      );
      if (tool.fix !== undefined) lines.push(`           fix: ${tool.fix}`);
    }
    for (const note of tool.notes ?? []) lines.push(`           note: ${note}`);
  }
  lines.push('', 'Credentials (presence only; values are never shown):');
  for (const cred of body.credentials) {
    lines.push(`  ${(cred.present ? 'present' : 'absent').padEnd(9)}${cred.name} (${cred.source})`);
  }
  if (body.billing !== null) {
    const b = body.billing;
    lines.push(
      '',
      b.mode === 'api_key'
        ? `Billing: Claude Code is billed to an API key (${b.credential}, ${b.present ? 'present' : 'absent'}): the key is ${b.exposure}.`
        : 'Billing: Claude Code is billed to your subscription login (no credential is passed to it).',
    );
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
