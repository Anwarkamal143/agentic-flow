/**
 * A stand-in for the `claude` CLI, for the Claude Code adapter scenarios. It is
 * NOT Claude Code: it speaks the same headless stream-json protocol, with
 * responses scripted per Role, so the adapter's whole path (flags, stdin
 * prompt, stream parsing, Session id, usage, failures, cancellation) runs in
 * `pnpm test` without the real CLI or the network.
 *
 *   node claude-stub.mjs <scenario.json> [claude arguments…]
 *
 * The scenario (JSON):
 *   version        what `--version` prints (`<version> (Claude Code)`)
 *   helpOmits      flags left out of `--help`
 *   loggedIn       `auth status` exit code 0 (true) or 1
 *   record         a file each Harness Run appends one JSON line to: its argv, env names, cwd, pid
 *   responses      by Role (triager, …, developer, reviewer): a list; the n-th Harness Run of a Role gets the n-th
 *     { output }                 the final result text is the JSON of `output`
 *     { steps, result }          developer: write/commit steps, then the Task Result file
 *     { error: { subtype, errors, exitCode } }   a failed Harness Run
 *     { hang: true }             starts a child `sleep` (its pid recorded) and never ends
 *     { printEnv: [names] }      puts those environment variables' values in the final text (a leak, for redaction checks)
 *   apiKeySource   what the `init` event reports as the credential (as Claude Code 2.1.x does):
 *                  default `ANTHROPIC_API_KEY` when that variable is set, else `none` (the login)
 *
 * The `result` event carries `usage` and a per-model `modelUsage` with a
 * list-price `costUSD`, shaped like Claude Code 2.1.x's (seen 2026-11-09).
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [scenarioPath, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

const FLAGS = [
  '--print',
  '--output-format',
  '--verbose',
  '--session-id',
  '--permission-mode',
  '--permission-prompts',
  '--tools',
  '--allowed-tools',
  '--disallowed-tools',
  '--setting-sources',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--model',
];

if (args[0] === '--version') {
  process.stdout.write(`${scenario.version} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === '--help') {
  const omitted = new Set(scenario.helpOmits ?? []);
  const lines = FLAGS.filter((f) => !omitted.has(f)).map((f) => `  ${f} <value>   stub`);
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${lines.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(scenario.loggedIn ? 0 : 1);
if (!args.includes('--print')) {
  process.stderr.write('claude stub: only --print runs are scripted\n');
  process.exit(2);
}

const sessionId = args[args.indexOf('--session-id') + 1];
const prompt = readFileSync(0, 'utf8');
const role = /^You are the (?:independent )?(\w+)/.exec(prompt)?.[1] ?? 'unknown';

// The n-th Harness Run of this Role gets the n-th response.
const countsPath = `${scenarioPath}.runs.json`;
const counts = existsSync(countsPath) ? JSON.parse(readFileSync(countsPath, 'utf8')) : {};
const n = (counts[role] ?? 0) + 1;
counts[role] = n;
writeFileSync(countsPath, JSON.stringify(counts));
const response = scenario.responses?.[role]?.[n - 1];

const record = (extra) =>
  appendFileSync(
    scenario.record,
    JSON.stringify({
      role,
      n,
      argv: args,
      env: Object.keys(process.env).sort(),
      cwd: process.cwd(),
      pid: process.pid,
      promptOnArgv: args.some((a) => a.includes('You are the')),
      ...extra,
    }) + '\n',
  );

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  claude_code_version: scenario.version,
  apiKeySource:
    scenario.apiKeySource ??
    ((process.env.ANTHROPIC_API_KEY ?? '') === '' ? 'none' : 'ANTHROPIC_API_KEY'),
});

if (response === undefined) {
  record({});
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [`claude stub: no response #${String(n)} for ${role}`],
    session_id: sessionId,
  });
  process.exit(1);
}

if (response.hang === true) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  record({ child: child.pid });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
  setInterval(() => undefined, 1_000);
} else {
  record({});
  if (response.error !== undefined) {
    emit({
      type: 'result',
      subtype: response.error.subtype,
      is_error: true,
      errors: response.error.errors ?? [],
      terminal_reason: response.error.terminalReason ?? null,
      session_id: sessionId,
    });
    process.exit(response.error.exitCode ?? 1);
  }
  for (const step of response.steps ?? []) {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } });
    if (step.write !== undefined) {
      const path = join(process.cwd(), step.write.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.write.content);
    } else if (step.commit !== undefined) {
      const git = (a) =>
        execFileSync(
          'git',
          ['-c', 'user.name=Claude Stub', '-c', 'user.email=stub@factory.invalid', ...a],
          { stdio: 'ignore' },
        );
      git(['add', '--all']);
      git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--message', step.commit]);
    }
  }
  if (response.result !== undefined) {
    const path = join(process.cwd(), '.factory/result.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(response.result));
  }
  const printed = (response.printEnv ?? []).map((name) => `${name}=${process.env[name] ?? ''}\n`);
  const text =
    response.output === undefined ? `${printed.join('')}Done.` : JSON.stringify(response.output);
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    modelUsage: {
      'claude-stub-model': {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        costUSD: 0.42,
        costBasis: 'list',
      },
    },
  });
}
