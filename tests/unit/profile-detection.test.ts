/**
 * Profile Detection (ADR-0051, ADR-0060): a pure inspection of a snapshot of a
 * Repository's files (its paths, plus the contents of the few files detection
 * reads) proposes a Repository Profile. No LLM, nothing written. Also the v1 →
 * v2 profile upgrade, the detect diff and `repo profile set`. Tested through
 * `@factory/domain`.
 */
import {
  DEFAULT_SENSITIVE_PATHS,
  detectProfile,
  profileChanges,
  profileDetectionReads,
  RepositoryProfileSchema,
  setProfileField,
  type FileSnapshot,
  type RepositoryProfile,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const CI = `name: CI
on: [push]
jobs:
  test:
    name: Unit tests
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: not a job name
        run: npm run lint
  matrix:
    name: build \${{ matrix.os }}
    runs-on: \${{ matrix.os }}
`;

function snapshot(files: Record<string, string>, otherPaths: string[] = []): FileSnapshot {
  const paths = [...Object.keys(files), ...otherPaths].sort();
  const read = Object.fromEntries(
    profileDetectionReads(paths)
      .filter((p) => p in files)
      .map((p) => [p, files[p] as string]),
  );
  return { paths, files: read };
}

const pkg = (scripts: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: 'x', scripts, ...extra });

describe('profileDetectionReads', () => {
  it('reads only package.json and the CI workflow files', () => {
    expect(
      profileDetectionReads([
        'CLAUDE.md',
        'package.json',
        'src/index.ts',
        '.github/workflows/ci.yml',
        '.github/workflows/release.yaml',
        '.github/workflows/nested/x.yml',
        '.github/dependabot.yml',
        'packages/a/package.json',
      ]),
    ).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yaml', 'package.json']);
  });
});

describe('detectProfile', () => {
  it('detects the package manager, named commands, CI checks, instruction files and Sensitive Paths', () => {
    const detected = detectProfile(
      snapshot(
        {
          'package.json': pkg(
            {
              test: 'vitest run',
              'type-check': 'tsc --noEmit',
              lint: 'eslint .',
              build: 'tsc -b',
              dev: 'vite',
              release: 'npm publish',
            },
            { packageManager: 'pnpm@9.1.0' },
          ),
          '.github/workflows/ci.yml': CI,
          'CLAUDE.md': '# rules',
          'docs/AGENTS.md': 'nested',
          '.cursorrules': 'be terse',
        },
        ['src/index.ts', 'yarn.lock'],
      ),
    );

    expect(detected).toEqual({
      packageManager: 'pnpm',
      commands: {
        build: { run: 'pnpm run build', acceptsArgs: false },
        lint: { run: 'pnpm run lint', acceptsArgs: false },
        test: { run: 'pnpm test', acceptsArgs: false },
        typecheck: { run: 'pnpm run type-check', acceptsArgs: false },
      },
      ciFiles: [{ path: '.github/workflows/ci.yml', checks: ['Unit tests', 'lint'] }],
      instructionFiles: ['.cursorrules', 'CLAUDE.md', 'docs/AGENTS.md'],
      sensitivePaths: [...DEFAULT_SENSITIVE_PATHS, '.cursorrules', 'CLAUDE.md', 'docs/AGENTS.md'],
    });
  });

  it('includes the fixed default Sensitive Paths', () => {
    expect(DEFAULT_SENSITIVE_PATHS).toEqual(
      expect.arrayContaining(['.env*', '.github/workflows/**', 'infra/**', '**/*.pem']),
    );
  });

  it('takes the package manager from the lockfile, else npm; none without a package.json', () => {
    const pm = (paths: string[]) =>
      detectProfile(snapshot({ 'package.json': pkg({}) }, paths)).packageManager;
    expect(pm(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(pm(['yarn.lock'])).toBe('yarn');
    expect(pm(['bun.lockb'])).toBe('bun');
    expect(pm([])).toBe('npm');
    expect(detectProfile(snapshot({ 'README.md': 'hi' })).packageManager).toBeNull();
  });

  it("skips npm's placeholder test script and runs bun's test through `bun run`", () => {
    const placeholder = detectProfile(
      snapshot({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) }),
    );
    expect(placeholder.commands).toEqual({});
    const bun = detectProfile(
      snapshot({ 'package.json': pkg({ test: 'bun test' }) }, ['bun.lock']),
    );
    expect(bun.commands).toEqual({ test: { run: 'bun run test', acceptsArgs: false } });
  });

  it('treats malformed files as nothing detected', () => {
    const detected = detectProfile(
      snapshot({ 'package.json': '{not json', '.github/workflows/ci.yml': 'jobs: [' }),
    );
    expect(detected).toMatchObject({
      packageManager: 'npm',
      commands: {},
      ciFiles: [{ path: '.github/workflows/ci.yml', checks: [] }],
    });
  });

  it('never detects a setup command', () => {
    const detected = detectProfile(
      snapshot({ 'package.json': pkg({ setup: 'npm ci', postinstall: 'x', install: 'y' }) }),
    );
    expect(detected).not.toHaveProperty('setup');
    expect(detected.commands).toEqual({});
  });
});

const v1 = {
  version: 1,
  packageManager: 'npm',
  commands: { test: 'npm test', typecheck: null },
  requiredChecks: ['ci'],
  setup: 'npm ci',
  confirmedBy: 'user:local',
  confirmedAt: '2026-11-01T00:00:00.000Z',
};

describe('RepositoryProfileSchema', () => {
  it('upgrades a v1 profile to v2 marked not detected, with the default Sensitive Paths', () => {
    expect(RepositoryProfileSchema.parse(v1)).toEqual({
      version: 2,
      detection: 'not_detected',
      packageManager: 'npm',
      commands: { test: { run: 'npm test', acceptsArgs: false } },
      ciFiles: [],
      instructionFiles: [],
      sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
      requiredChecks: ['ci'],
      setup: 'npm ci',
      confirmedBy: 'user:local',
      confirmedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('parses a v2 profile as it is', () => {
    const v2 = RepositoryProfileSchema.parse(v1);
    expect(RepositoryProfileSchema.parse(v2)).toEqual(v2);
  });
});

describe('profileChanges', () => {
  it('lists each field detection would change, with both values', () => {
    const current = RepositoryProfileSchema.parse(v1);
    const detected = detectProfile(
      snapshot({ 'package.json': pkg({ test: 'vitest run' }), 'CLAUDE.md': 'x' }),
    );
    expect(profileChanges(current, detected)).toEqual([
      { field: 'detection', from: 'not_detected', to: 'detected' },
      { field: 'instructionFiles', from: [], to: ['CLAUDE.md'] },
      {
        field: 'sensitivePaths',
        from: [...DEFAULT_SENSITIVE_PATHS],
        to: [...DEFAULT_SENSITIVE_PATHS, 'CLAUDE.md'],
      },
    ]);
  });
});

describe('setProfileField', () => {
  const base: RepositoryProfile = RepositoryProfileSchema.parse(v1);

  it('sets, changes and removes a named command', () => {
    const added = setProfileField(base, 'commands.lint', 'npm run lint');
    expect(added).toMatchObject({
      ok: true,
      profile: { commands: { lint: { run: 'npm run lint', acceptsArgs: false } } },
    });
    if (!added.ok) return;
    const args = setProfileField(added.profile, 'commands.test.acceptsArgs', 'true');
    expect(args).toMatchObject({
      ok: true,
      profile: { commands: { test: { run: 'npm test', acceptsArgs: true } } },
    });
    const removed = setProfileField(base, 'commands.test', '');
    expect(removed).toMatchObject({ ok: true, profile: { commands: {} } });
  });

  it('sets the lists, the package manager and the setup command', () => {
    expect(setProfileField(base, 'sensitivePaths', '["infra/**"]')).toMatchObject({
      ok: true,
      profile: { sensitivePaths: ['infra/**'] },
    });
    expect(setProfileField(base, 'requiredChecks', '[]')).toMatchObject({
      ok: true,
      profile: { requiredChecks: [] },
    });
    expect(setProfileField(base, 'packageManager', 'none')).toMatchObject({
      ok: true,
      profile: { packageManager: null },
    });
    const noSetup = setProfileField(base, 'setup', '');
    expect(noSetup.ok && noSetup.profile.setup).toBeUndefined();
  });

  it('refuses an unknown key, a bad value and acceptsArgs on a missing command', () => {
    expect(setProfileField(base, 'detection', 'detected')).toMatchObject({
      ok: false,
      code: 'unknown_profile_key',
    });
    expect(setProfileField(base, 'sensitivePaths', 'infra/**')).toMatchObject({
      ok: false,
      code: 'invalid_profile_value',
    });
    expect(setProfileField(base, 'commands.Bad Name', 'x')).toMatchObject({
      ok: false,
      code: 'invalid_profile_value',
    });
    expect(setProfileField(base, 'commands.lint.acceptsArgs', 'true')).toMatchObject({
      ok: false,
      code: 'invalid_profile_value',
    });
    expect(setProfileField(base, 'commands.test.acceptsArgs', 'yes')).toMatchObject({
      ok: false,
      code: 'invalid_profile_value',
    });
  });
});
