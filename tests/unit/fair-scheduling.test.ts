/**
 * Fair scheduling across Projects (ADR-0050): the one ordering the Task claimer
 * and the proposal-Stage scheduler share, `priority_weight + 0.5 ×
 * floor(wait_s / 60) − in_flight ÷ project limit` (penalty 0 when the limit is
 * unlimited), and the per-Project limit a Job's claim must fit under. Pure;
 * tested through `@factory/domain`.
 */
import {
  effectivePriority,
  fairOrder,
  FAIRNESS_DEFAULTS,
  projectSlotDecision,
  resolveProjectJobLimit,
  type FairCandidate,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
/** An ISO time `s` seconds before NOW. */
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('effectivePriority', () => {
  it('is the priority weight when nothing has waited and nothing is in flight', () => {
    expect(effectivePriority({ priorityWeight: 1, waitSeconds: 0, inFlight: 0, limit: 2 })).toBe(1);
  });

  it('ages by 0.5 per whole minute waited', () => {
    const at = (waitSeconds: number) =>
      effectivePriority({ priorityWeight: 0, waitSeconds, inFlight: 0, limit: 'unlimited' });
    expect(at(59)).toBe(0);
    expect(at(60)).toBe(0.5);
    expect(at(119)).toBe(0.5);
    expect(at(300)).toBe(2.5);
  });

  it("subtracts the Project's Jobs in flight over its limit", () => {
    expect(effectivePriority({ priorityWeight: 0, waitSeconds: 0, inFlight: 1, limit: 2 })).toBe(
      -0.5,
    );
    expect(effectivePriority({ priorityWeight: 1, waitSeconds: 0, inFlight: 3, limit: 3 })).toBe(0);
  });

  it('has no penalty when the limit is unlimited', () => {
    expect(
      effectivePriority({ priorityWeight: 0, waitSeconds: 0, inFlight: 5, limit: 'unlimited' }),
    ).toBe(0);
  });

  it('takes its aging constants from the Factory Level', () => {
    expect(FAIRNESS_DEFAULTS).toEqual({ agingStep: 0.5, agingIntervalSeconds: 60 });
    expect(
      effectivePriority({
        priorityWeight: 0,
        waitSeconds: 10,
        inFlight: 0,
        limit: 'unlimited',
        constants: { agingStep: 1, agingIntervalSeconds: 5 },
      }),
    ).toBe(2);
  });
});

describe('fairOrder', () => {
  const candidate = (
    id: string,
    over: Partial<FairCandidate> = {},
  ): FairCandidate & { id: string } => ({
    id,
    projectId: 'prj_a',
    priorityWeight: 0,
    readyAt: ago(0),
    ...over,
  });
  const order = (
    candidates: (FairCandidate & { id: string })[],
    ctx: Partial<Parameters<typeof fairOrder>[1]> = {},
  ) =>
    fairOrder(candidates, {
      now: NOW,
      inFlight: new Map(),
      limits: new Map(),
      ...ctx,
    }).map((c) => c.id);

  it('takes higher priority first', () => {
    expect(
      order([candidate('low', { priorityWeight: -1 }), candidate('high', { priorityWeight: 1 })]),
    ).toEqual(['high', 'low']);
  });

  it('lets a low-priority candidate overtake a normal one after two minutes of waiting', () => {
    const normal = candidate('normal', { readyAt: ago(10) });
    expect(order([normal, candidate('low', { priorityWeight: -1, readyAt: ago(119) })])).toEqual([
      'normal',
      'low',
    ]);
    // At 2 minutes the two are equal, and the longer wait goes first; past 3 the low one is ahead.
    expect(order([normal, candidate('low', { priorityWeight: -1, readyAt: ago(120) })])).toEqual([
      'low',
      'normal',
    ]);
    expect(
      order([
        candidate('normal', { readyAt: ago(10) }),
        candidate('low', { priorityWeight: -1, readyAt: ago(180) }),
      ]),
    ).toEqual(['low', 'normal']);
  });

  it('puts a busy Project behind an idle one', () => {
    const busy = candidate('busy', { projectId: 'prj_busy', readyAt: ago(30) });
    const idle = candidate('idle', { projectId: 'prj_idle', readyAt: ago(5) });
    expect(
      order([busy, idle], {
        inFlight: new Map([['prj_busy', 1]]),
        limits: new Map([['prj_busy', 2]]),
      }),
    ).toEqual(['idle', 'busy']);
  });

  it('gives no penalty to an unlimited Project, however much it has in flight', () => {
    const busy = candidate('busy', { projectId: 'prj_busy', readyAt: ago(30) });
    const idle = candidate('idle', { projectId: 'prj_idle', readyAt: ago(5) });
    expect(order([busy, idle], { inFlight: new Map([['prj_busy', 4]]) })).toEqual(['busy', 'idle']);
  });

  it('breaks a tie by the longer wait, then keeps the given order', () => {
    expect(
      order([
        candidate('later', { readyAt: ago(1) }),
        candidate('first', { readyAt: ago(20) }),
        candidate('also-later', { readyAt: ago(1) }),
      ]),
    ).toEqual(['first', 'later', 'also-later']);
  });
});

describe('the per-Project Job limit', () => {
  it('is unlimited unless a level sets it, and the Project wins over the Factory Level', () => {
    expect(resolveProjectJobLimit({}, {})).toEqual({ value: 'unlimited', source: 'recipe' });
    expect(resolveProjectJobLimit({ concurrency: { perProjectJobs: 1 } }, {})).toEqual({
      value: 1,
      source: 'factory',
    });
    // Overridable upward or downward, unlimited included: a capacity value, not a permission.
    expect(
      resolveProjectJobLimit(
        { concurrency: { perProjectJobs: 1 } },
        { concurrency: { perProjectJobs: 'unlimited' } },
      ),
    ).toEqual({ value: 'unlimited', source: 'project' });
    expect(
      resolveProjectJobLimit(
        { concurrency: { perProjectJobs: 2 } },
        { concurrency: { perProjectJobs: 3 } },
      ),
    ).toEqual({ value: 3, source: 'project' });
  });

  it('lets a Job already in flight go on without a new slot', () => {
    expect(
      projectSlotDecision({ projectId: 'prj_a', limit: 1, held: ['prj_a:0'], jobHoldsSlot: true }),
    ).toEqual({ kind: 'held' });
  });

  it('gives a new Job the lowest free slot under the limit, and refuses one at the limit', () => {
    expect(
      projectSlotDecision({
        projectId: 'prj_a',
        limit: 2,
        held: ['prj_a:0', 'prj_b:0', 'prj_b:1'],
        jobHoldsSlot: false,
      }),
    ).toEqual({ kind: 'granted', resourceId: 'prj_a:1' });
    expect(
      projectSlotDecision({ projectId: 'prj_a', limit: 1, held: ['prj_a:0'], jobHoldsSlot: false }),
    ).toEqual({ kind: 'full', held: 1, max: 1 });
  });

  it('still takes a slot under an unlimited limit, so the Jobs in flight are counted', () => {
    expect(
      projectSlotDecision({
        projectId: 'prj_a',
        limit: 'unlimited',
        held: ['prj_a:0', 'prj_a:1'],
        jobHoldsSlot: false,
      }),
    ).toEqual({ kind: 'granted', resourceId: 'prj_a:2' });
  });
});
