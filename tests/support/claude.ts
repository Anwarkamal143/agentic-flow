/**
 * The Claude Code adapter scenarios' stand-in CLI (`claude-stub.mjs`): NOT
 * Claude Code, a script that speaks its headless stream-json protocol. The
 * runtime is pointed at it through runtime configuration, exactly as at the
 * real `claude`.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { tempDir, type TestHome } from './factory.js';
import { VALID_SCRIPT } from './scripts.js';

const STUB = fileURLToPath(new URL('./claude-stub.mjs', import.meta.url));

export interface StubScenario {
  version?: string;
  helpOmits?: string[];
  loggedIn?: boolean;
  /** By Role; see `claude-stub.mjs`. Defaults to {@link validResponses}. */
  responses?: Record<string, unknown[]>;
}

/** One Run of the stub, as it recorded itself. */
export interface StubInvocation {
  role: string;
  n: number;
  argv: string[];
  env: string[];
  cwd: string;
  pid: number;
  promptOnArgv: boolean;
  child?: number;
}

export interface ClaudeStub {
  /** The executable (a `claude` in its own directory, for use on PATH too). */
  readonly command: string;
  readonly dir: string;
  invocations(): StubInvocation[];
}

/** The valid Fake script's responses, by the Role each Stage asks for. */
export function validResponses(): Record<string, unknown[]> {
  const script = parse(VALID_SCRIPT) as {
    stages: Record<string, unknown[]>;
    tasks: Record<string, unknown[]>;
    reviews: Record<string, unknown[]>;
  };
  return {
    triager: script.stages['triage'] ?? [],
    researcher: script.stages['discovery'] ?? [],
    specifier: script.stages['specification'] ?? [],
    planner: script.stages['planning'] ?? [],
    developer: script.tasks['add-sum'] ?? [],
    reviewer: script.reviews['add-sum'] ?? [],
  };
}

export function claudeStub(scenario: StubScenario = {}): ClaudeStub {
  const dir = tempDir('factory-claude-stub-');
  const record = join(dir, 'invocations.jsonl');
  const scenarioPath = join(dir, 'scenario.json');
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      version: scenario.version ?? '9.8.7',
      helpOmits: scenario.helpOmits ?? [],
      loggedIn: scenario.loggedIn ?? true,
      record,
      responses: { ...validResponses(), ...scenario.responses },
    }),
  );
  const command = join(dir, 'claude');
  writeFileSync(
    command,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} ${JSON.stringify(scenarioPath)} "$@"\n`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    dir,
    invocations: () =>
      existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as StubInvocation)
        : [],
  };
}

/** Selects the Claude Code Harness for this home through runtime configuration. Call before `startRuntime`. */
export function useClaudeCode(home: TestHome, command: string): void {
  const configPath = join(home.dir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config['harness'] = { id: 'claude-code', command };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

/** The values following `flag` in `argv`, up to the next `--flag`. */
export function flagValues(argv: readonly string[], flag: string): string[] {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
}
