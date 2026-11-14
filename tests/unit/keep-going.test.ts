/**
 * Keep going (ARCHITECTURE §4.4, ADR-0028): one stuck or failed Task never
 * stalls the rest of the DAG. A failed Task's dependents are cancelled
 * (`dependency_failed`); `execution` ends only once nothing else can make
 * progress, and the Job status follows from it (spec issue 9's precedence).
 * Pure; tested through `@factory/domain`.
 */
import {
  deriveJobStatus,
  dependentsToCancel,
  executionOutcome,
  type Blocker,
  type StageId,
  type StageRunState,
  type TaskState,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const blocker = (kind: Blocker['kind'], reason: Blocker['reason'] = 'rework_cap_reached') =>
  ({
    kind,
    reason,
    detail: 'd',
    requiredAction: 'r',
    taskId: 't',
    attemptId: 'att',
    createdAt: '2026-11-10T00:00:00.000Z',
  }) satisfies Blocker;

const task = (key: string, state: TaskState, b: Blocker | null = null) => ({
  key,
  state,
  blocker: b,
});

describe('dependentsToCancel', () => {
  const dag = (states: Record<string, TaskState>, deps: Record<string, string[]>) =>
    Object.entries(states).map(([id, state]) => ({ id, state, dependsOn: deps[id] ?? [] }));

  it("cancels a failed Task's direct and transitive dependents, in Plan order", () => {
    const tasks = dag(
      { a: 'failed', b: 'pending', c: 'pending', d: 'approved', e: 'pending' },
      { b: ['a'], c: ['b'], e: ['d'] },
    );
    expect(dependentsToCancel('a', tasks)).toEqual(['b', 'c']);
  });

  it('cancels a dependent that also waits on a healthy Task', () => {
    const tasks = dag({ a: 'failed', b: 'running', c: 'pending' }, { c: ['a', 'b'] });
    expect(dependentsToCancel('a', tasks)).toEqual(['c']);
  });

  it('leaves a dependent that is already finished alone, but cancels what waits on it', () => {
    const tasks = dag({ a: 'failed', b: 'cancelled', c: 'pending' }, { b: ['a'], c: ['b'] });
    expect(dependentsToCancel('a', tasks)).toEqual(['c']);
  });

  it('cancels nothing when no Task depends on the failed one', () => {
    expect(dependentsToCancel('a', dag({ a: 'failed', b: 'ready' }, {}))).toEqual([]);
  });
});

describe('executionOutcome', () => {
  it('keeps running while any Task is in progress, even beside a failed or blocked one', () => {
    for (const busy of ['ready', 'claimed', 'running', 'verifying', 'in_review'] as const) {
      expect(
        executionOutcome([
          task('a', 'failed'),
          task('b', 'blocked', blocker('human')),
          task('c', busy),
        ]),
      ).toEqual({ kind: 'running' });
    }
  });

  it('waits on a human Blocker before ending failed: the human can still unblock progress', () => {
    const human = blocker('human');
    expect(
      executionOutcome([task('a', 'failed'), task('b', 'blocked', human), task('c', 'pending')]),
    ).toEqual({ kind: 'waiting_human', blocker: human });
  });

  it('shows a human Blocker before a non-human one, and a non-human one as blocked', () => {
    const infra = blocker('infrastructure', 'fault_origin_infrastructure');
    const human = blocker('human');
    expect(executionOutcome([task('a', 'blocked', infra), task('b', 'blocked', human)])).toEqual({
      kind: 'waiting_human',
      blocker: human,
    });
    expect(executionOutcome([task('a', 'blocked', infra)])).toEqual({
      kind: 'blocked',
      blocker: infra,
    });
  });

  it('fails once nothing else can make progress, naming every failed Task', () => {
    expect(
      executionOutcome([
        task('a', 'failed'),
        task('b', 'cancelled'),
        task('c', 'approved'),
        task('d', 'failed'),
      ]),
    ).toEqual({ kind: 'failed', failedKeys: ['a', 'd'] });
  });

  it('succeeds when every Task is approved', () => {
    expect(executionOutcome([task('a', 'approved'), task('b', 'approved')])).toEqual({
      kind: 'succeeded',
    });
  });

  it('changes nothing with no Task, or with cancelled Tasks and no failure', () => {
    expect(executionOutcome([])).toEqual({ kind: 'unchanged' });
    expect(executionOutcome([task('a', 'approved'), task('b', 'cancelled')])).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('the Job status with keep-going', () => {
  const runs = (execution: StageRunState, closure: StageRunState = 'pending') =>
    (
      [
        ['intake', 'succeeded'],
        ['triage', 'succeeded'],
        ['discovery', 'succeeded'],
        ['specification', 'succeeded'],
        ['planning', 'succeeded'],
        ['plan_approval', 'skipped'],
        ['execution', execution],
        ['closure', closure],
      ] as [StageId, StageRunState][]
    ).map(([stageId, state]) => ({ stageId, state }));
  const statusOf = (tasks: ReturnType<typeof task>[]) => {
    const outcome = executionOutcome(tasks);
    const execution: StageRunState =
      outcome.kind === 'unchanged'
        ? 'running'
        : outcome.kind === 'succeeded'
          ? 'succeeded'
          : outcome.kind;
    // A failed execution still runs closure, for the partial results (ADR-0028).
    const ended = execution === 'failed' || execution === 'succeeded';
    return deriveJobStatus(runs(execution, ended ? 'queued' : 'pending'));
  };

  it('is active while an independent branch runs beside a failed Task', () => {
    expect(statusOf([task('a', 'failed'), task('b', 'cancelled'), task('c', 'running')])).toBe(
      'active',
    );
  });

  it('is active while an independent branch runs beside a blocked Task', () => {
    expect(
      statusOf([
        task('a', 'blocked', blocker('human')),
        task('b', 'pending'),
        task('c', 'running'),
      ]),
    ).toBe('active');
  });

  it('is waiting_human, not failed, while a blocked Task could still unblock work', () => {
    expect(statusOf([task('a', 'failed'), task('b', 'blocked', blocker('human'))])).toBe(
      'waiting_human',
    );
  });

  it('is failed once the closure of a failed execution has written its report', () => {
    expect(deriveJobStatus(runs('failed', 'queued'))).toBe('active');
    expect(deriveJobStatus(runs('failed', 'succeeded'))).toBe('failed');
  });
});
