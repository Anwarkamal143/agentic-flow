/**
 * Environment checks behind `GET /v1/doctor` (PRODUCT_SPEC §13). Detects the
 * tools the factory shells out to, as seen from the runtime's own PATH, and
 * whether credentials are present.
 *
 * Credentials are reported as present/absent only. A value is tested for being
 * non-empty and never copied, logged, returned or passed to a probe.
 *
 * Tool output is untrusted: only a parsed version number leaves this module,
 * never the raw text.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ToolCheck {
  id: 'node' | 'git' | 'gh' | 'claude';
  name: string;
  command: string;
  /** `ok`: found and reported a version. `failed`: found, but `--version` did not work. */
  status: 'ok' | 'missing' | 'failed';
  version?: string;
  path?: string;
  /** What the operator can do about a missing or failed tool. */
  fix?: string;
}

export interface CredentialCheck {
  id: 'anthropic_api_key' | 'claude_oauth_token' | 'gh_token' | 'github_token' | 'gh_login';
  name: string;
  /** Where presence was looked for: an environment variable name, or a command. */
  source: string;
  present: boolean;
}

export interface DoctorReport {
  checkedAt: string;
  tools: ToolCheck[];
  credentials: CredentialCheck[];
}

interface ToolSpec {
  id: ToolCheck['id'];
  name: string;
  command: string;
  install: string;
}

const TOOLS: readonly ToolSpec[] = [
  {
    id: 'node',
    name: 'Node.js',
    command: 'node',
    install: 'Install Node.js 22.12+: https://nodejs.org',
  },
  { id: 'git', name: 'git', command: 'git', install: 'Install git: https://git-scm.com/downloads' },
  {
    id: 'gh',
    name: 'GitHub CLI',
    command: 'gh',
    install: 'Install the GitHub CLI: https://cli.github.com',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    install: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup',
  },
];

const VERSION_TIMEOUT_MS = 10_000;

const ENV_CREDENTIALS: readonly Omit<CredentialCheck, 'present'>[] = [
  { id: 'anthropic_api_key', name: 'Claude API key', source: 'ANTHROPIC_API_KEY' },
  {
    id: 'claude_oauth_token',
    name: 'Claude subscription token',
    source: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
  { id: 'gh_token', name: 'GitHub token', source: 'GH_TOKEN' },
  { id: 'github_token', name: 'GitHub token', source: 'GITHUB_TOKEN' },
];

export async function runDoctor(env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const tools = await Promise.all(TOOLS.map((spec) => checkTool(spec, env)));
  const credentials: CredentialCheck[] = ENV_CREDENTIALS.map((c) => ({
    ...c,
    present: (env[c.source] ?? '') !== '',
  }));
  const gh = tools.find((t) => t.id === 'gh');
  credentials.push({
    id: 'gh_login',
    name: 'GitHub CLI login',
    source: 'gh auth status',
    // Exit code only; the output is discarded. Without the probe env's tokens this
    // reflects gh's stored login, not GH_TOKEN/GITHUB_TOKEN (reported above).
    present: gh?.path !== undefined && (await run(gh.path, ['auth', 'status'], toolEnv(env))).ok,
  });
  return { checkedAt: new Date().toISOString(), tools, credentials };
}

async function checkTool(spec: ToolSpec, env: NodeJS.ProcessEnv): Promise<ToolCheck> {
  const base = { id: spec.id, name: spec.name, command: spec.command };
  const path = findOnPath(spec.command, env['PATH']);
  if (path === undefined) return { ...base, status: 'missing', fix: spec.install };

  const result = await run(path, ['--version'], toolEnv(env));
  const version = result.ok ? parseVersion(result.stdout) : undefined;
  if (version === undefined) {
    return {
      ...base,
      status: 'failed',
      path,
      fix: `\`${spec.command} --version\` ${result.ok ? 'printed no version' : result.reason}. ${spec.install}`,
    };
  }
  return { ...base, status: 'ok', version, path };
}

/** The first `x.y` or `x.y.z` on the first line of `--version` output. */
function parseVersion(stdout: string): string | undefined {
  const firstLine = stdout.split('\n', 1)[0] ?? '';
  return /\d+\.\d+(?:\.\d+)?/.exec(firstLine)?.[0];
}

/** Resolves a command against PATH the way a shell would: first executable file wins. */
function findOnPath(command: string, pathVar: string | undefined): string | undefined {
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

/**
 * Probes run with a minimal environment: enough to locate their own config,
 * and nothing else, so no credential in the runtime's environment reaches them.
 */
function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'];
  return Object.fromEntries(keep.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])));
}

type RunResult = { ok: true; stdout: string } | { ok: false; reason: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err === null) {
          resolve({ ok: true, stdout });
        } else if (err.killed) {
          resolve({ ok: false, reason: `timed out after ${String(VERSION_TIMEOUT_MS / 1000)}s` });
        } else {
          const code =
            typeof err.code === 'number' ? `exited with code ${String(err.code)}` : 'could not run';
          resolve({ ok: false, reason: code });
        }
      },
    );
  });
}
