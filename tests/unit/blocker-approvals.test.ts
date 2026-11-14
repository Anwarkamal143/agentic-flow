/**
 * Blocker Approvals (ARCHITECTURE §8.1, ADR-0026): which Blockers open an
 * Inbox Approval and with which fixed options, how big a grant may be, how a
 * grant or a "retry now" raises a cap, and when "retry now" must kill first.
 * Pure; tested through `@factory/domain`.
 */
import {
  blockerOptions,
  checkBlockerDecision,
  grantedCap,
  KILL_AND_RETRY_OPTIONS,
  retriesAfterRetryNow,
  retryNowCheck,
  type BlockerReason,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const ids = (reason: BlockerReason) => blockerOptions(reason)?.map((o) => o.id);

describe('the option sets of a Blocker Approval', () => {
  it('a Rework or question cap offers a grant, a Replan and cancelling the Job', () => {
    expect(ids('rework_cap_reached')).toEqual(['grant', 'replan', 'cancel_job']);
    expect(ids('question_cap_reached')).toEqual(['grant', 'replan', 'cancel_job']);
  });

  it('the Replan cap offers one more Replan and cancelling the Job (#45)', () => {
    expect(ids('replan_cap_reached')).toEqual(['grant_replan', 'cancel_job']);
    expect(checkBlockerDecision({ option: 'grant_replan' })).toEqual({ ok: true, grant: null });
    expect(checkBlockerDecision({ option: 'grant_replan', grant: 2 })).toMatchObject({
      ok: false,
      code: 'invalid_grant',
    });
  });

  it('an uncertain recovery or a Retry cap offers retry now and cancelling the Job', () => {
    expect(ids('recovery_uncertain')).toEqual(['retry_now', 'cancel_job']);
    expect(ids('retry_cap_reached')).toEqual(['retry_now', 'cancel_job']);
  });

  it('a Specification Finding no Specification change resolves offers Rework with guidance, a Replan under the current Specification and cancelling the Job (#47)', () => {
    expect(ids('spec_finding_unresolved')).toEqual(['rework', 'replan', 'cancel_job']);
    expect(checkBlockerDecision({ option: 'rework' })).toEqual({ ok: true, grant: null });
    expect(checkBlockerDecision({ option: 'rework', grant: 1 })).toMatchObject({
      ok: false,
      code: 'invalid_grant',
    });
  });

  it('a live process turns "retry now" into "kill and retry"', () => {
    expect(KILL_AND_RETRY_OPTIONS.map((o) => o.id)).toEqual(['kill_and_retry', 'cancel_job']);
  });

  it('a Question waiting for its answer, and the Blockers other tickets route, open no Blocker Approval', () => {
    for (const reason of [
      'awaiting_human',
      'fault_origin_plan',
      'fault_origin_spec',
      'fault_origin_infrastructure',
    ] as const) {
      expect(blockerOptions(reason), reason).toBeUndefined();
    }
  });

  it('every option is the factory’s, never agent-proposed', () => {
    for (const reason of [
      'rework_cap_reached',
      'recovery_uncertain',
      'replan_cap_reached',
      'spec_finding_unresolved',
    ] as const) {
      expect(blockerOptions(reason)?.every((o) => !o.agentProposed)).toBe(true);
    }
    expect(KILL_AND_RETRY_OPTIONS.every((o) => !o.agentProposed)).toBe(true);
  });
});

describe('a grant’s size', () => {
  it('defaults to +1 and goes up to +5', () => {
    expect(checkBlockerDecision({ option: 'grant' })).toEqual({ ok: true, grant: 1 });
    expect(checkBlockerDecision({ option: 'grant', grant: 5 })).toEqual({ ok: true, grant: 5 });
  });

  it('refuses 0, more than 5, or a fraction', () => {
    for (const grant of [0, 6, 1.5, -1]) {
      const result = checkBlockerDecision({ option: 'grant', grant });
      expect(result, String(grant)).toMatchObject({ ok: false, code: 'invalid_grant' });
    }
  });

  it('refuses a size on an option that grants nothing', () => {
    expect(checkBlockerDecision({ option: 'cancel_job', grant: 2 })).toMatchObject({
      ok: false,
      code: 'invalid_grant',
    });
    expect(checkBlockerDecision({ option: 'retry_now' })).toEqual({ ok: true, grant: null });
  });
});

describe('cap accounting', () => {
  it('a grant of +N allows exactly N more Attempts beyond those used', () => {
    expect(grantedCap({ used: 3, cap: 3 }, 1)).toBe(4);
    expect(grantedCap({ used: 3, cap: 3 }, 5)).toBe(8);
  });

  it('counts from the Attempts used when they already exceed the cap', () => {
    // A cap narrowed below what was used (say, by a Plan Task) still grants N more.
    expect(grantedCap({ used: 4, cap: 2 }, 2)).toBe(6);
  });

  it('"retry now" raises maxRetries by one only when no Retry is left', () => {
    expect(retriesAfterRetryNow({ retriesUsed: 2, maxRetries: 2 })).toBe(3);
    expect(retriesAfterRetryNow({ retriesUsed: 0, maxRetries: 2 })).toBeUndefined();
  });
});

describe('"retry now" re-checks the process first', () => {
  it('retries only when the recorded process is gone for sure', () => {
    expect(retryNowCheck('dead')).toBe('retry');
    expect(retryNowCheck('finished')).toBe('retry');
    expect(retryNowCheck('unrecorded')).toBe('retry');
  });

  it('offers kill and retry when it is alive, and never retries beside a process it can’t check', () => {
    expect(retryNowCheck('alive')).toBe('kill_first');
    expect(retryNowCheck('none')).toBe('unconfirmed');
  });
});
