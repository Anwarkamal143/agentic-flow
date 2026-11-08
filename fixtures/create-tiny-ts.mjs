#!/usr/bin/env node
/**
 * Creates the `tiny-ts` fixture Repository from scratch: TypeScript, Vitest,
 * one module (`src/math.ts`), one commit on `main`, no remote.
 *
 *   node fixtures/create-tiny-ts.mjs [dest]     (default: fixtures/repos/tiny-ts)
 *
 * Fixtures are generated, never committed as nested git repos (ARCHITECTURE §2).
 * The commit is deterministic: fixed author, committer and dates, and no user or
 * system git config is read (so no signing, hooks or templates leak in).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = {
  'package.json':
    JSON.stringify(
      {
        name: 'tiny-ts',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
        devDependencies: { typescript: '6.0.3', vitest: '5.1.0' },
      },
      null,
      2,
    ) + '\n',
  'tsconfig.json':
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src', 'test'],
      },
      null,
      2,
    ) + '\n',
  '.gitignore': 'node_modules/\n',
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'test/math.test.ts':
    "import { expect, it } from 'vitest';\nimport { add } from '../src/math.js';\n\n" +
    "it('adds two numbers', () => {\n  expect(add(2, 3)).toBe(5);\n});\n",
};

const FIXED_DATE = '2026-01-01T00:00:00Z';

export function createTinyTs(dest) {
  const dir = resolve(dest);
  if (existsSync(dir)) throw new Error(`refusing to overwrite existing path: ${dir}`);
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Factory Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@factory.invalid',
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_NAME: 'Factory Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@factory.invalid',
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '--message', 'tiny-ts: initial fixture');
  return dir;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultDest = fileURLToPath(new URL('repos/tiny-ts', import.meta.url));
  process.stdout.write(`${createTinyTs(process.argv[2] ?? defaultDest)}\n`);
}
