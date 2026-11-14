/**
 * Which Task Branches the Delivery Report v3 offers to fetch (ADR-0028). A
 * leaf is a Task no other Task depends on. A fetch is offered for each
 * approved Task no approved Task depends on: its branch already holds every
 * approved Task beneath it (the Dependency Base). A failed or cancelled leaf
 * is listed, never offered. Pure; tested through `@factory/domain`.
 */
import { deliveryBranches, type TaskState } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const plan = (states: Record<string, TaskState>, deps: Record<string, string[]> = {}) =>
  Object.entries(states).map(([key, state]) => ({ key, state, dependsOn: deps[key] ?? [] }));

describe('deliveryBranches', () => {
  it('offers only the leaf of a finished chain', () => {
    expect(deliveryBranches(plan({ a: 'approved', b: 'approved' }, { b: ['a'] }))).toEqual([
      { key: 'a', leaf: false, offered: false },
      { key: 'b', leaf: true, offered: true },
    ]);
  });

  it('offers each independent leaf of a completed DAG', () => {
    const dag = plan(
      { a: 'approved', b: 'approved', c: 'approved', d: 'approved' },
      { b: ['a'], c: ['a'], d: ['b'] },
    );
    expect(
      deliveryBranches(dag)
        .filter((b) => b.offered)
        .map((b) => b.key),
    ).toEqual(['c', 'd']);
  });

  it('lists a failed or cancelled leaf without offering it, and offers the approved Tasks beneath it', () => {
    const dag = plan(
      { a: 'approved', b: 'approved', c: 'failed', d: 'cancelled', e: 'approved' },
      { b: ['a'], c: ['b'], d: ['c'] },
    );
    expect(deliveryBranches(dag)).toEqual([
      { key: 'a', leaf: false, offered: false },
      { key: 'b', leaf: false, offered: true },
      { key: 'c', leaf: false, offered: false },
      { key: 'd', leaf: true, offered: false },
      { key: 'e', leaf: true, offered: true },
    ]);
  });

  it('offers both approved dependencies of a failed merge Task', () => {
    const dag = plan({ a: 'approved', b: 'approved', d: 'failed' }, { d: ['a', 'b'] });
    expect(
      deliveryBranches(dag)
        .filter((b) => b.offered)
        .map((b) => b.key),
    ).toEqual(['a', 'b']);
  });

  it('offers nothing when nothing was approved', () => {
    expect(deliveryBranches(plan({ a: 'failed', b: 'blocked' })).some((b) => b.offered)).toBe(
      false,
    );
  });
});
