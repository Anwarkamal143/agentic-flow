/**
 * Replan carry-over (ARCHITECTURE §4.7, ADR-0029): which of a Job's Tasks a
 * new Plan keeps. A Task carries over only with an identical key, definition
 * and whole dependency chain; it keeps its id (so its Branch, Worktree,
 * Attempts and cap counts). Everything else unfinished is cancelled, and a
 * Plan entry nothing carries becomes a new Task. Pure; tested through
 * `@factory/domain`.
 */
import {
  approvalStillHolds,
  decideCarryOver,
  type CarryOverTask,
  type PlanTaskProposal,
  type TaskState,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function entry(key: string, dependsOn: string[] = [], extra: Partial<PlanTaskProposal> = {}) {
  return {
    key,
    title: `Write docs/${key}.md`,
    objective: `Write docs/${key}.md.`,
    repository: 'repo_1',
    role: 'developer',
    risk: 'low',
    scope: { writable: [`docs/${key}.md`], forbidden: [], readHints: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [
      { key: 'test', command: `test -f docs/${key}.md`, required: true, criteria: [] },
    ],
    priority: 'normal',
    ...extra,
  } satisfies PlanTaskProposal;
}

function task(
  key: string,
  state: TaskState,
  opts: { dependsOn?: string[]; approvalHolds?: boolean; resolvedByReplan?: boolean } = {},
): CarryOverTask {
  return {
    id: `tsk_${key}`,
    key,
    state,
    entry: entry(key, opts.dependsOn ?? []),
    approvalHolds: opts.approvalHolds ?? state === 'approved',
    resolvedByReplan: opts.resolvedByReplan ?? false,
  };
}

describe('decideCarryOver', () => {
  it.each<[TaskState, TaskState]>([
    ['pending', 'ready'],
    ['ready', 'ready'],
    ['changes_requested', 'changes_requested'],
    ['blocked', 'blocked'],
    ['approved', 'approved'],
  ])('carries an identical %s Task over, keeping its id (now %s)', (state, to) => {
    const plan = decideCarryOver([task('a', state)], [entry('a')]);
    expect(plan).toEqual({
      carried: [{ key: 'a', taskId: 'tsk_a', from: state, to }],
      cancelled: [],
      created: [],
    });
  });

  it.each<TaskState>(['cancelled', 'failed'])(
    'never carries a %s Task over: an identical entry becomes a new Task',
    (state) => {
      expect(decideCarryOver([task('a', state)], [entry('a')])).toEqual({
        carried: [],
        cancelled: [],
        created: [{ key: 'a', state: 'ready', replaces: 'tsk_a' }],
      });
    },
  );

  it.each<TaskState>(['claimed', 'running', 'verifying', 'in_review'])(
    'refuses while a Task is %s (an Attempt is in flight)',
    (state) => {
      expect(() => decideCarryOver([task('a', state)], [entry('a')])).toThrow(/in flight/);
    },
  );

  it('cancels an approved Task whose definition changed; its re-run is a new Task', () => {
    const plan = decideCarryOver(
      [task('a', 'approved')],
      [entry('a', [], { objective: 'Write a longer docs/a.md.' })],
    );
    expect(plan).toEqual({
      carried: [],
      cancelled: [{ key: 'a', taskId: 'tsk_a', why: 'definition_changed' }],
      created: [{ key: 'a', state: 'ready', replaces: 'tsk_a' }],
    });
  });

  it('cancels an approved Task whose Evidence or review no longer matches its SHAs', () => {
    const plan = decideCarryOver([task('a', 'approved', { approvalHolds: false })], [entry('a')]);
    expect(plan.cancelled).toEqual([{ key: 'a', taskId: 'tsk_a', why: 'approval_stale' }]);
    expect(plan.created).toEqual([{ key: 'a', state: 'ready', replaces: 'tsk_a' }]);
  });

  it('cancels a blocked Task whose Inbox Item triggered this Replan', () => {
    const plan = decideCarryOver([task('a', 'blocked', { resolvedByReplan: true })], [entry('a')]);
    expect(plan.cancelled).toEqual([{ key: 'a', taskId: 'tsk_a', why: 'resolved_by_replan' }]);
    expect(plan.created).toEqual([{ key: 'a', state: 'ready', replaces: 'tsk_a' }]);
  });

  it('cancels an unfinished Task the new Plan drops', () => {
    expect(decideCarryOver([task('a', 'ready')], [entry('b')])).toEqual({
      carried: [],
      cancelled: [{ key: 'a', taskId: 'tsk_a', why: 'removed' }],
      created: [{ key: 'b', state: 'ready', replaces: null }],
    });
  });

  it('carries a Task over only when its whole dependency chain carries over', () => {
    // a → b → c: a's definition changes, so neither b nor c is unaffected.
    const plan = decideCarryOver(
      [
        task('a', 'approved'),
        task('b', 'approved', { dependsOn: ['a'] }),
        task('c', 'pending', { dependsOn: ['b'] }),
        task('d', 'approved'),
      ],
      [entry('a', [], { title: 'Retitled' }), entry('b', ['a']), entry('c', ['b']), entry('d')],
    );
    expect(plan.carried).toEqual([{ key: 'd', taskId: 'tsk_d', from: 'approved', to: 'approved' }]);
    expect(plan.cancelled).toEqual([
      { key: 'a', taskId: 'tsk_a', why: 'definition_changed' },
      { key: 'b', taskId: 'tsk_b', why: 'dependency_not_carried' },
      { key: 'c', taskId: 'tsk_c', why: 'dependency_not_carried' },
    ]);
    expect(plan.created).toEqual([
      { key: 'a', state: 'ready', replaces: 'tsk_a' },
      { key: 'b', state: 'pending', replaces: 'tsk_b' },
      { key: 'c', state: 'pending', replaces: 'tsk_c' },
    ]);
  });

  it('treats a changed dependency list as a changed definition', () => {
    const plan = decideCarryOver(
      [task('a', 'approved'), task('b', 'ready', { dependsOn: ['a'] })],
      [entry('a'), entry('b')],
    );
    expect(plan.cancelled).toEqual([{ key: 'b', taskId: 'tsk_b', why: 'definition_changed' }]);
  });

  it('readies a new or carried Task once every dependency it has is carried over approved', () => {
    const plan = decideCarryOver(
      [task('a', 'approved'), task('b', 'pending', { dependsOn: ['a'] }), task('x', 'blocked')],
      [entry('a'), entry('b', ['a']), entry('x'), entry('n', ['a']), entry('m', ['x'])],
    );
    expect(plan.carried).toEqual([
      { key: 'a', taskId: 'tsk_a', from: 'approved', to: 'approved' },
      { key: 'b', taskId: 'tsk_b', from: 'pending', to: 'ready' },
      { key: 'x', taskId: 'tsk_x', from: 'blocked', to: 'blocked' },
    ]);
    expect(plan.created).toEqual([
      { key: 'n', state: 'ready', replaces: null },
      { key: 'm', state: 'pending', replaces: null },
    ]);
  });

  it('compares definitions by value, not by key order', () => {
    const current = task('a', 'approved');
    const reordered = Object.fromEntries(Object.entries(entry('a')).reverse()) as PlanTaskProposal;
    expect(decideCarryOver([current], [reordered]).carried).toHaveLength(1);
  });
});

describe('approvalStillHolds', () => {
  const passed = { state: 'passed', headSha: H, baseSha: B };
  const at = (headSha: string, baseSha: string) => ({ headSha, baseSha });

  it('holds when every Evidence and review of the passed Attempt is on its (head, base)', () => {
    expect(
      approvalStillHolds({ attempt: passed, evidence: [at(H, B), at(H, B)], reviews: [at(H, B)] }),
    ).toBe(true);
  });

  it('fails when any Evidence or review ran against another head or base', () => {
    expect(
      approvalStillHolds({ attempt: passed, evidence: [at(H, B), at(OTHER, B)], reviews: [] }),
    ).toBe(false);
    expect(
      approvalStillHolds({ attempt: passed, evidence: [at(H, B)], reviews: [at(H, OTHER)] }),
    ).toBe(false);
  });

  it('fails without any Evidence, or when the last Attempt did not pass', () => {
    expect(approvalStillHolds({ attempt: passed, evidence: [], reviews: [at(H, B)] })).toBe(false);
    expect(
      approvalStillHolds({
        attempt: { ...passed, state: 'failed' },
        evidence: [at(H, B)],
        reviews: [],
      }),
    ).toBe(false);
    expect(approvalStillHolds({ attempt: undefined, evidence: [], reviews: [] })).toBe(false);
  });
});
