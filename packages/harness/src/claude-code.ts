/**
 * The Claude Code Harness (ARCHITECTURE §6): drives the installed `claude` CLI
 * headless (`--print`, `--output-format stream-json`), one process per Harness
 * Harness Run, under the Tier 0 guardrail like any process the factory starts.
 *
 * - **Flags.** `detect` checks every flag the adapter passes against the
 *   installed version's `--help` (shared with `factory doctor` through
 *   {@link probeClaudeCode}). A flag the CLI hides from `--help` but accepts
 *   (`--max-turns`) can't be checked offline; it is listed as unverified, and a
 *   CLI that rejects it fails the Harness Run with its own reason.
 * - **Policy.** The Role's tool policy (Effective Configuration) becomes
 *   `--tools`, `--allowed-tools` and `--disallowed-tools`, under
 *   `--permission-mode dontAsk`: anything the policy doesn't allow is denied,
 *   never prompted for. No settings file is loaded (`--setting-sources ''`), so
 *   neither the Repository's `.claude/` nor the operator's own settings can
 *   widen the policy; no MCP server and no skill is loaded either.
 * - **Session.** The adapter picks the Session id (`--session-id`, a UUID), so
 *   it is known, and recorded, before the process starts.
 * - **Prompt.** Given on stdin (a file in the spool), never on the command
 *   line.
 * - **Output.** The stream is read from the spool's output file while the
 *   process runs (progress events) and once it ends (the `result` event: the
 *   final text, usage, and whether it failed). A Harness Run whose stream has no
 *   successful `result` fails, with the reason the CLI gave.
 * - **Usage.** Token counts are what the CLI reports (`actual`). Billing is a
 *   subscription (the operator's own `claude` login), so the cost is
 *   `unknown/subscription`: the CLI's `total_cost_usd` is a list-price figure,
 *   not what the Harness Run cost, and is not recorded.
 * - **Version.** Detected once at startup and recorded on each Attempt; the
 *   CLI's auto-updater is off in every Harness Run (`DISABLE_AUTOUPDATER=1`), so a Harness Run
 *   doesn't update the CLI under the runtime.
 * - **Credentials.** None is passed: the guardrail env has no secret, so the
 *   CLI uses its stored login (found through `HOME`). An `ANTHROPIC_API_KEY`
 *   in the runtime's environment never reaches it.
 *
 * Everything the CLI prints is untrusted: the runtime validates the output,
 * and the reason text only explains a failure.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { toolsOf, type ToolPolicy } from '@factory/domain';
import { z } from 'zod';
import {
  attachGuarded,
  guardrailEnv,
  spawnGuarded,
  type GuardedExit,
  type GuardedProcess,
} from './guardrail.js';
import type {
  AgentHarness,
  HarnessDetection,
  HarnessEvent,
  HarnessExit,
  HarnessRawResult,
  HarnessReattachInput,
  HarnessRun,
  HarnessStartInput,
  HarnessUsage,
} from './index.js';

/** Every flag the adapter passes that the CLI must list in `--help`. */
export const CLAUDE_CODE_FLAGS: readonly string[] = [
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

/** Flags the adapter passes that the CLI accepts but doesn't list in `--help`: not checkable offline. */
export const CLAUDE_CODE_UNLISTED_FLAGS: readonly string[] = ['--max-turns'];

const PROBE_TIMEOUT_MS = 10_000;
const POLL_MS = 200;
/** A failure reason is cut to this many characters. */
const MAX_REASON = 500;

export interface ClaudeCodeProbe {
  /** The executable, when found. */
  path: string | undefined;
  version: string | null;
  /** Flags of {@link CLAUDE_CODE_FLAGS} the installed `--help` doesn't list. */
  missingFlags: string[];
  /** Flags of {@link CLAUDE_CODE_UNLISTED_FLAGS} the installed `--help` doesn't list either. */
  unverifiedFlags: string[];
  /** `claude auth status` exit code; `null` when it couldn't run. Never its output. */
  loggedIn: boolean | null;
  /** Why the adapter can't drive it. Empty when it can. */
  problems: string[];
}

/**
 * Checks an installed Claude Code: its version, every flag the adapter needs,
 * and whether it has a login (exit code only). `command` is a path, or a name
 * looked up on `env.PATH`. Harness Runs with the guardrail's env, so no secret reaches it.
 */
export async function probeClaudeCode(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodeProbe> {
  const path = isAbsolute(command) ? command : findExecutable(command, env['PATH']);
  const none = { path, version: null, missingFlags: [], unverifiedFlags: [], loggedIn: null };
  if (path === undefined) {
    return { ...none, problems: [`\`${command}\` was not found on PATH`] };
  }
  const probeEnv = guardrailEnv(env, {});
  const version = await run(path, ['--version'], probeEnv);
  const parsed = version.ok
    ? /\d+\.\d+(?:\.\d+)?/.exec(version.stdout.split('\n', 1)[0] ?? '')
    : null;
  if (parsed === null) {
    return {
      ...none,
      problems: [`\`${path} --version\` ${version.ok ? 'printed no version' : version.reason}`],
    };
  }
  const help = await run(path, ['--help'], probeEnv);
  const listed = (flag: string) =>
    help.ok && new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<\\[]|$)`, 'm').test(help.stdout);
  const missingFlags = CLAUDE_CODE_FLAGS.filter((f) => !listed(f));
  const auth = await run(path, ['auth', 'status'], probeEnv);
  return {
    path,
    version: parsed[0],
    missingFlags,
    unverifiedFlags: CLAUDE_CODE_UNLISTED_FLAGS.filter((f) => !listed(f)),
    loggedIn: auth.ok ? true : auth.reason.startsWith('exited') ? false : null,
    problems: help.ok
      ? missingFlags.length === 0
        ? []
        : [
            `Claude Code ${parsed[0]} does not list ${missingFlags.join(', ')} in --help; the adapter needs ${missingFlags.length === 1 ? 'it' : 'them'}`,
          ]
      : [`\`${path} --help\` ${help.reason}`],
  };
}

/** Resolves a command against PATH the way a shell would: the first executable file wins. */
export function findExecutable(command: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, or not executable
    }
  }
  return undefined;
}

export interface ClaudeCodeOptions {
  /** The `claude` executable: a path, or a name looked up on the runtime's PATH. */
  command: string;
  /** `--model`, when set; otherwise the CLI's default. */
  model?: string;
  /** The runtime's environment, for `detect` (filtered through the guardrail). */
  env: NodeJS.ProcessEnv;
}

/** The command line of one Harness Run (the prompt goes on stdin). Pure. */
export function claudeCodeArgs(input: {
  sessionRef: string;
  policy: ToolPolicy;
  maxTurns?: number;
  model?: string;
}): string[] {
  const tools = toolsOf(input.policy);
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    input.sessionRef,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    tools.join(','),
    ...(input.policy.allow.length === 0 ? [] : ['--allowed-tools', ...input.policy.allow]),
    ...(input.policy.deny.length === 0 ? [] : ['--disallowed-tools', ...input.policy.deny]),
    ...(input.maxTurns === undefined ? [] : ['--max-turns', String(input.maxTurns)]),
    ...(input.model === undefined ? [] : ['--model', input.model]),
  ];
}

/** What a Harness Run's re-attach needs: its Session. */
const TokenSchema = z.object({ sessionRef: z.string() });

export class ClaudeCodeHarness implements AgentHarness {
  readonly id = 'claude-code';
  readonly capabilities = ['structured_output', 'cancel'] as const;
  private path: string | undefined;

  constructor(private readonly opts: ClaudeCodeOptions) {}

  async detect(): Promise<HarnessDetection> {
    const probe = await probeClaudeCode(this.opts.command, this.opts.env);
    this.path = probe.path;
    return {
      installed: probe.path !== undefined && probe.version !== null,
      version: probe.version,
      credentials: probe.loggedIn === null ? 'unknown' : probe.loggedIn ? 'present' : 'absent',
      problems: probe.problems,
    };
  }

  start(input: HarnessStartInput): Promise<HarnessRun> {
    const command =
      this.path ??
      (isAbsolute(this.opts.command)
        ? this.opts.command
        : findExecutable(this.opts.command, this.opts.env['PATH']));
    if (command === undefined) {
      return Promise.reject(new Error(`\`${this.opts.command}\` was not found on PATH`));
    }
    const sessionRef = randomUUID();
    const proc = spawnGuarded({
      command,
      args: claudeCodeArgs({
        sessionRef,
        policy: input.policy,
        ...(input.limits.maxTurns === undefined ? {} : { maxTurns: input.limits.maxTurns }),
        ...(this.opts.model === undefined ? {} : { model: this.opts.model }),
      }),
      cwd: input.cwd,
      // The version detected at startup is the one recorded on each Attempt: no update mid-way.
      env: { ...input.env, DISABLE_AUTOUPDATER: '1' },
      timeoutMs: input.limits.wallClockMs,
      spool: input.spool,
      input: input.prompt,
    });
    return Promise.resolve(claudeRun(proc, sessionRef, input.spool, input.limits.wallClockMs));
  }

  /** A Harness Run started by an earlier runtime: watched to its end, never started again. */
  reattach(input: HarnessReattachInput): Promise<HarnessRun | undefined> {
    const { sessionRef } = TokenSchema.parse(JSON.parse(input.token));
    const proc = attachGuarded({
      spool: input.spool,
      startedAt: input.startedAt,
      timeoutMs: input.limits.wallClockMs,
    });
    if (proc === undefined) return Promise.resolve(undefined);
    return Promise.resolve(claudeRun(proc, sessionRef, input.spool, input.limits.wallClockMs));
  }
}

function claudeRun(
  proc: GuardedProcess,
  sessionRef: string,
  spool: string,
  wallClockMs: number,
): HarnessRun {
  const result = proc.exit.then((e) => rawResult(e, wallClockMs));
  return {
    executionId: `claude_${randomBytes(8).toString('hex')}`,
    sessionRef,
    ...(proc.pid === undefined
      ? {}
      : { pid: proc.pid, process: { pid: proc.pid, token: JSON.stringify({ sessionRef }) } }),
    events: tailEvents(join(spool, 'output'), result),
    result,
    cancel: () => proc.cancel().then(() => undefined),
  };
}

/** How the Harness Run ended, from its process's exit and the stream it left. */
function rawResult(e: GuardedExit, wallClockMs: number): HarnessRawResult {
  const stream = parseClaudeStream(e.output);
  const usage = usageOf(stream);
  if (e.cancelled)
    return { exit: { kind: 'cancelled' }, output: e.output, usage, durationMs: e.durationMs };
  if (e.timedOut) {
    return {
      exit: { kind: 'timed_out', afterMs: wallClockMs },
      output: e.output,
      usage,
      durationMs: e.durationMs,
    };
  }
  const code = e.code ?? 128;
  const failed = (reason: string): HarnessRawResult => ({
    exit: {
      kind: 'exited',
      code: code === 0 ? 1 : code,
      reason: cut(reason),
    } satisfies HarnessExit,
    output: e.output,
    usage,
    durationMs: e.durationMs,
  });
  const res = stream.result;
  if (res === undefined) {
    return failed(
      `Claude Code ended without a result event${
        stream.lastText === undefined ? '' : `; it last printed: ${stream.lastText}`
      }`,
    );
  }
  if (res.isError || code !== 0) return failed(`Claude Code reported ${describeFailure(res)}`);
  return {
    exit: { kind: 'exited', code: 0 },
    output: res.text ?? '',
    usage,
    durationMs: e.durationMs,
  };
}

function describeFailure(res: NonNullable<ClaudeStream['result']>): string {
  const kind = [
    res.subtype !== undefined && res.subtype !== 'success' ? res.subtype : res.terminalReason,
    res.apiErrorStatus === undefined ? undefined : `API status ${String(res.apiErrorStatus)}`,
  ]
    .filter((p) => p !== undefined)
    .join(', ');
  const detail = res.errors.length > 0 ? res.errors.join('; ') : (res.text ?? '');
  return `${kind === '' ? 'an error' : kind}${detail === '' ? '' : `: ${detail}`}`;
}

function cut(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

function usageOf(stream: ClaudeStream): HarnessUsage {
  const u = stream.result?.usage;
  return {
    tag: u === undefined ? 'unknown' : 'actual',
    inputTokens: u === undefined ? null : u.inputTokens,
    outputTokens: u === undefined ? null : u.outputTokens,
    costUsd: null,
    costTag: 'unknown/subscription',
  };
}

// ---- the stream ---------------------------------------------------------------

const ResultEventSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().nullable().optional(),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().nullable().optional(),
  api_error_status: z.number().nullable().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

const AssistantEventSchema = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({
    content: z.array(
      z.looseObject({ type: z.string(), text: z.string().optional(), name: z.string().optional() }),
    ),
  }),
});

const DeniedEventSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('permission_denied'),
  tool_name: z.string().optional(),
});

/** What a Harness Run's stream says, as far as the factory reads it. */
export interface ClaudeStream {
  /** The last `result` event. */
  result:
    | {
        subtype: string | undefined;
        isError: boolean;
        text: string | undefined;
        errors: string[];
        terminalReason: string | undefined;
        apiErrorStatus: number | undefined;
        usage: { inputTokens: number; outputTokens: number } | undefined;
      }
    | undefined;
  /** The last line that isn't a stream event (the CLI's own error message, usually). */
  lastText: string | undefined;
}

/** Reads a Harness Run's stream-json output (stdout and stderr interleaved). Lines that aren't events are skipped. Pure. */
export function parseClaudeStream(output: string): ClaudeStream {
  let result: ClaudeStream['result'];
  let lastText: string | undefined;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const value = parseLine(trimmed);
    if (value === undefined) {
      lastText = cut(trimmed);
      continue;
    }
    const r = ResultEventSchema.safeParse(value);
    if (!r.success) continue;
    const u = r.data.usage;
    result = {
      subtype: r.data.subtype,
      isError: r.data.is_error === true,
      text: r.data.result ?? undefined,
      errors: r.data.errors ?? [],
      terminalReason: r.data.terminal_reason ?? undefined,
      apiErrorStatus: r.data.api_error_status ?? undefined,
      usage:
        u === undefined
          ? undefined
          : {
              // Cached input is input too: the Harness Run read it.
              inputTokens:
                (u.input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
            },
    };
  }
  return { result, lastText };
}

function parseLine(line: string): unknown {
  if (!line.startsWith('{')) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** The events of one stream line. */
function eventsOf(line: string): HarnessEvent[] {
  const value = parseLine(line.trim());
  if (value === undefined) return [];
  const assistant = AssistantEventSchema.safeParse(value);
  if (assistant.success) {
    return assistant.data.message.content.flatMap((c): HarnessEvent[] =>
      c.type === 'text' && c.text !== undefined && c.text !== ''
        ? [{ kind: 'text', text: c.text }]
        : c.type === 'tool_use'
          ? [{ kind: 'progress', message: `tool ${c.name ?? '?'}` }]
          : [],
    );
  }
  const denied = DeniedEventSchema.safeParse(value);
  if (denied.success) {
    return [{ kind: 'progress', message: `denied tool ${denied.data.tool_name ?? '?'}` }];
  }
  const result = ResultEventSchema.safeParse(value);
  if (result.success) {
    const stream = parseClaudeStream(line);
    return [{ kind: 'usage', usage: usageOf(stream) }];
  }
  return [];
}

/**
 * The Harness Run's events, read from its output file as it grows, until the Harness Run has
 * ended and the file is read to its end.
 */
async function* tailEvents(path: string, ended: Promise<unknown>): AsyncGenerator<HarnessEvent> {
  const state = { ended: false };
  void ended.then(() => {
    state.ended = true;
  });
  let offset = 0;
  let pending = '';
  for (;;) {
    const finished = state.ended;
    const chunk = readFrom(path, offset);
    offset += chunk.length;
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) yield* eventsOf(line);
    if (finished) {
      if (pending !== '') yield* eventsOf(pending);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** What the file holds from `offset` on (nothing, when it doesn't exist yet). */
function readFrom(path: string, offset: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = statSync(path).size;
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

type RunResult = { ok: true; stdout: string } | { ok: false; reason: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err === null) {
          resolve({ ok: true, stdout });
        } else if (err.killed) {
          resolve({ ok: false, reason: `timed out after ${String(PROBE_TIMEOUT_MS / 1000)}s` });
        } else {
          resolve({
            ok: false,
            reason:
              typeof err.code === 'number'
                ? `exited with code ${String(err.code)}`
                : 'could not run',
          });
        }
      },
    );
  });
}
