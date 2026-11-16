/**
 * The Worktree setup step (spec issue 43, ADR-0047): the environment a
 * Repository's human-set setup command runs in, when it runs, and where a
 * failed setup goes. Pure; tested through `@factory/domain`.
 */
import {
  createRedactor,
  secretsFromEnv,
  blockerItemTitle,
  blockerOptions,
  routeFailedAttempt,
  setupEnvironment,
  setupNeeded,
  SetupCommandSchema,
  type SetupLogContent,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const GUARDRAIL = {
  PATH: '/usr/bin',
  HOME: '/home/op',
  FACTORY_TASK_ID: 'tsk_1',
  CI: 'true',
};

describe('the setup environment', () => {
  it('is the guardrail environment plus the shared caches, with lifecycle scripts off', () => {
    expect(setupEnvironment(GUARDRAIL, '/factory/cache')).toEqual({
      ...GUARDRAIL,
      npm_config_cache: '/factory/cache/npm',
      npm_config_store_dir: '/factory/cache/pnpm-store',
      YARN_CACHE_FOLDER: '/factory/cache/yarn',
      npm_config_ignore_scripts: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
    });
  });

  it('keeps lifecycle scripts off even when the guardrail environment says otherwise', () => {
    const env = setupEnvironment(
      { ...GUARDRAIL, npm_config_ignore_scripts: 'false', YARN_ENABLE_SCRIPTS: 'true' },
      '/c',
    );
    expect(env['npm_config_ignore_scripts']).toBe('true');
    expect(env['YARN_ENABLE_SCRIPTS']).toBe('false');
  });

  it('adds nothing beyond the guardrail environment and its own variables', () => {
    const env = setupEnvironment(GUARDRAIL, '/c');
    expect(Object.keys(env).sort()).toEqual(
      [
        ...Object.keys(GUARDRAIL),
        'npm_config_cache',
        'npm_config_store_dir',
        'YARN_CACHE_FOLDER',
        'npm_config_ignore_scripts',
        'YARN_ENABLE_SCRIPTS',
      ].sort(),
    );
  });
});

describe('when setup runs', () => {
  it('runs once per Worktree: the first time, and not again for the same dependency files', () => {
    expect(setupNeeded([], 'sha256:a')).toBe(true);
    expect(setupNeeded([{ passed: true, dependencyHash: 'sha256:a' }], 'sha256:a')).toBe(false);
  });

  it('runs again when the dependency files changed since the last setup that passed', () => {
    expect(setupNeeded([{ passed: true, dependencyHash: 'sha256:a' }], 'sha256:b')).toBe(true);
    expect(
      setupNeeded(
        [
          { passed: true, dependencyHash: 'sha256:a' },
          { passed: true, dependencyHash: 'sha256:b' },
        ],
        'sha256:a',
      ),
      'only the latest passing setup counts',
    ).toBe(true);
  });

  it('runs again after a setup that did not pass (failed, timed out, or left the Worktree changed)', () => {
    expect(setupNeeded([{ passed: false, dependencyHash: 'sha256:a' }], 'sha256:a')).toBe(true);
    expect(setupNeeded([{ passed: false, dependencyHash: 'sha256:a' }], 'sha256:a')).toBe(true);
    expect(
      setupNeeded(
        [
          { passed: true, dependencyHash: 'sha256:a' },
          { passed: false, dependencyHash: 'sha256:a' },
        ],
        'sha256:a',
      ),
      'a failed setup may have left node_modules half-written',
    ).toBe(true);
  });
});

describe('the setup command', () => {
  it('is one non-empty line of at most 1000 characters', () => {
    expect(SetupCommandSchema.parse('  npm ci --ignore-scripts ')).toBe('npm ci --ignore-scripts');
    expect(SetupCommandSchema.safeParse('').success).toBe(false);
    expect(SetupCommandSchema.safeParse('npm ci\nrm -rf ~').success).toBe(false);
    expect(SetupCommandSchema.safeParse('x'.repeat(1001)).success).toBe(false);
  });
});

describe('a failed setup', () => {
  it('waits for a human, never Rework, whatever Attempts remain', () => {
    const route = routeFailedAttempt({
      exitReason: 'setup_failed',
      findings: [],
      n: 1,
      maxAttempts: 3,
    });
    expect(route).toMatchObject({
      kind: 'blocked',
      blocker: { kind: 'human', reason: 'setup_failed' },
    });
  });

  it('offers a Retry (the setup runs again first) and cancelling the Job', () => {
    expect(blockerOptions('setup_failed')?.map((o) => o.id)).toEqual(['retry_now', 'cancel_job']);
    expect(blockerItemTitle('a', 'setup_failed')).toBe('Task a stopped: its Worktree setup failed');
    expect(blockerItemTitle('i', 'setup_failed', 'integration')).toBe(
      'Integration Task stopped: its Worktree setup failed',
    );
  });
});

describe('a setup log', () => {
  it('is redacted before it is stored: a token pattern and a secret the runtime knows by name', () => {
    // As the Artifact store stores every log: each string through the runtime's redactor.
    const redact = createRedactor(secretsFromEnv({ NPM_TOKEN: 'npm-secret-value-123456' }));
    const log: SetupLogContent = {
      source: 'setup',
      command: 'npm ci',
      exitCode: 1,
      timedOut: false,
      truncated: false,
      output: `npm ERR! 401 for token npm-secret-value-123456\nfetched with ghp_${'a1B2'.repeat(9)}\n`,
    };
    const stored = JSON.parse(
      JSON.stringify(log, (_k, v: unknown) => (typeof v === 'string' ? redact(v) : v)),
    ) as SetupLogContent;
    expect(stored.output).not.toContain('npm-secret-value-123456');
    expect(stored.output).not.toContain('ghp_a1B2');
    expect(stored.output).toContain('[REDACTED:github_token]');
    expect(stored.command).toBe('npm ci');
  });

  it('runs with no secret the runtime holds: the setup environment adds only factory-set, non-secret values', () => {
    const env = setupEnvironment(GUARDRAIL, '/c');
    const added = Object.entries(env).filter(([k]) => !(k in GUARDRAIL));
    expect(added.map(([k]) => k).some((k) => /TOKEN|SECRET|KEY|PASSWORD/i.test(k))).toBe(false);
  });
});
