import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, tinyTsRepo } from '../support/factory.js';

describe('fixture generator: tiny-ts', () => {
  it('creates a TypeScript + Vitest Repository with one module, from scratch', () => {
    const repo = tinyTsRepo();

    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test']).toBe('vitest run');
    expect(pkg.scripts['typecheck']).toBe('tsc --noEmit');
    expect(existsSync(join(repo, 'src', 'math.ts'))).toBe(true);
    expect(existsSync(join(repo, 'tsconfig.json'))).toBe(true);

    expect(git(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(git(repo, ['branch', '--show-current']).trim()).toBe('main');
    expect(git(repo, ['status', '--porcelain']), 'committed, clean tree').toBe('');
    expect(git(repo, ['remote']).trim(), 'no remote: the factory clones from the path').toBe('');
  });

  it('is deterministic: two runs produce the same commit', () => {
    expect(git(tinyTsRepo(), ['rev-parse', 'HEAD'])).toBe(git(tinyTsRepo(), ['rev-parse', 'HEAD']));
  });
});
