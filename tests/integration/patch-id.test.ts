/**
 * The patch-id the re-anchoring rule compares (#62, ADR-0041): `diffPatchId`
 * of the built `@factory/git`, on a real repository. Merging a moved base that
 * touches only other files leaves the diff from the merge-base to the head
 * unchanged; a base change next to the reviewed lines changes it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitTree, diffPatchId, mergeCommits } from '@factory/git';
import { git, tempDir } from '../support/factory.js';

function repo(): string {
  const dir = tempDir('patch-id-');
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.invalid']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'README.md'), 'readme\n');
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}

function commit(dir: string, from: string, files: Record<string, string>): string {
  git(dir, ['checkout', '--quiet', '--detach', from]);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '-m', 'change']);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** The base merged into the head: one two-parent commit, as the factory makes it. */
async function mergeIn(dir: string, head: string, base: string): Promise<string> {
  const merged = await mergeCommits(dir, head, base);
  if (merged.kind !== 'merged') throw new Error('unexpected conflict');
  return commitTree(dir, merged.tree, [head, base], 'merge base in');
}

describe('diffPatchId', () => {
  it('is unchanged by merging in a base that touched only other files', async () => {
    const dir = repo();
    const b1 = git(dir, ['rev-parse', 'HEAD']).trim();
    const h1 = commit(dir, b1, { 'a.ts': 'one\nTWO\nthree\n' });
    const b2 = commit(dir, b1, { 'README.md': 'moved\n' });
    const h2 = await mergeIn(dir, h1, b2);

    const before = await diffPatchId(dir, b1, h1);
    expect(before).toMatch(/^[0-9a-f]{40}$/);
    expect(await diffPatchId(dir, b2, h2)).toBe(before);
  });

  it('changes when the base changed the lines next to the reviewed change', async () => {
    const dir = repo();
    const b1 = git(dir, ['rev-parse', 'HEAD']).trim();
    const h1 = commit(dir, b1, { 'a.ts': 'one\nTWO\nthree\n' });
    const b2 = commit(dir, b1, { 'a.ts': 'one\ntwo\nthree\nfour\n' });
    const h2 = await mergeIn(dir, h1, b2);

    expect(await diffPatchId(dir, b2, h2)).not.toBe(await diffPatchId(dir, b1, h1));
  });

  it('is null for an empty diff', async () => {
    const dir = repo();
    const b1 = git(dir, ['rev-parse', 'HEAD']).trim();
    expect(await diffPatchId(dir, b1, b1)).toBeNull();
  });
});
