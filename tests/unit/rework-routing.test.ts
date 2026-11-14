/**
 * Rework routing (ARCHITECTURE §4.6): a failed Gate or a blocking review
 * Finding sends the Task back for a new Attempt, up to its `max_attempts`.
 * Hitting the cap stops with a human Blocker instead, so nothing loops; a
 * Specification Finding re-runs specification (#47) and a Plan Finding goes
 * back to planning (B4). Pure; tested through `@factory/domain`.
 */
import { routeFailedAttempt, type FaultOrigin } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const finding = (faultOrigin: FaultOrigin, blocking = true) => ({ faultOrigin, blocking });

describe('Rework routing', () => {
  it('reworks a failed Gate or a review that requested changes while Attempts remain', () => {
    for (const exitReason of ['gates_failed', 'changes_requested'] as const) {
      expect(
        routeFailedAttempt({
          exitReason,
          findings: [finding('implementation')],
          n: 1,
          maxAttempts: 3,
        }),
      ).toEqual({ kind: 'rework' });
    }
  });

  it('stops with a human Blocker when the Attempt was the last one allowed', () => {
    expect(
      routeFailedAttempt({
        exitReason: 'gates_failed',
        findings: [finding('implementation')],
        n: 3,
        maxAttempts: 3,
      }),
    ).toMatchObject({ kind: 'blocked', blocker: { kind: 'human', reason: 'rework_cap_reached' } });
  });

  it('routes a blocking Specification Finding to re-specification, before the Plan and the cap (#47)', () => {
    for (const n of [1, 3]) {
      expect(
        routeFailedAttempt({
          exitReason: 'changes_requested',
          findings: [finding('plan'), finding('spec'), finding('implementation')],
          n,
          maxAttempts: 3,
        }),
      ).toEqual({ kind: 'respecify' });
    }
  });

  it('routes a blocking Plan Finding back to planning, even on the last Attempt (B4)', () => {
    for (const n of [1, 3]) {
      expect(
        routeFailedAttempt({
          exitReason: 'changes_requested',
          findings: [finding('implementation'), finding('plan'), finding('infrastructure')],
          n,
          maxAttempts: 3,
        }),
      ).toEqual({ kind: 'replan' });
    }
  });

  it('blocks on infrastructure when a blocking Finding blames the infrastructure', () => {
    expect(
      routeFailedAttempt({
        exitReason: 'changes_requested',
        findings: [finding('infrastructure')],
        n: 1,
        maxAttempts: 3,
      }),
    ).toMatchObject({
      kind: 'blocked',
      blocker: { kind: 'infrastructure', reason: 'fault_origin_infrastructure' },
    });
  });

  it('ignores the Fault Origin of a Finding that does not block', () => {
    expect(
      routeFailedAttempt({
        exitReason: 'changes_requested',
        findings: [finding('implementation'), finding('spec', false)],
        n: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ kind: 'rework' });
  });

  it('fails, without Rework, an Attempt that ended for any reason other than a verdict on the work', () => {
    for (const exitReason of [
      'invalid_output',
      'not_done',
      'harness_failed',
      'review_failed',
      'factory_error',
    ] as const) {
      expect(routeFailedAttempt({ exitReason, findings: [], n: 1, maxAttempts: 3 })).toEqual({
        kind: 'fail',
      });
    }
  });
});
