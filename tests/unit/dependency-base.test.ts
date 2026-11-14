/**
 * The Dependency Base (ARCHITECTURE §10, GLOSSARY, ADR-0021): what a dependent
 * Task's Worktree starts from. No dependency: the default branch. One: its
 * approved head. Several: their approved heads, merged in Plan order. Pure;
 * tested through `@factory/domain`.
 */
import { planDependencyBase } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('planDependencyBase', () => {
  it('starts a Task with no dependency from the default branch', () => {
    expect(planDependencyBase([])).toEqual({ kind: 'default_branch' });
  });

  it("starts from one dependency's approved head", () => {
    expect(planDependencyBase([{ key: 'a', state: 'approved', headSha: A }])).toEqual({
      kind: 'head',
      sha: A,
    });
  });

  it('merges several approved heads in the order given (Plan order)', () => {
    expect(
      planDependencyBase([
        { key: 'c', state: 'approved', headSha: C },
        { key: 'b', state: 'approved', headSha: B },
      ]),
    ).toEqual({ kind: 'merge', heads: [C, B] });
  });

  it('refuses while a dependency is not approved, naming it', () => {
    expect(
      planDependencyBase([
        { key: 'b', state: 'approved', headSha: B },
        { key: 'c', state: 'in_review', headSha: null },
      ]),
    ).toEqual({ kind: 'not_ready', keys: ['c'] });
  });

  it('refuses an approved dependency with no recorded head', () => {
    expect(planDependencyBase([{ key: 'a', state: 'approved', headSha: null }])).toEqual({
      kind: 'not_ready',
      keys: ['a'],
    });
  });

  it('merges a dependency head only once when two dependencies share it', () => {
    expect(
      planDependencyBase([
        { key: 'a', state: 'approved', headSha: A },
        { key: 'b', state: 'approved', headSha: A },
      ]),
    ).toEqual({ kind: 'head', sha: A });
  });
});
