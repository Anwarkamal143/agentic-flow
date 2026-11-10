/**
 * "Request changes" at `plan_approval` (PRODUCT_SPEC §4, ARCHITECTURE §4.7,
 * ADR-0019): a Replan with the human's feedback, bounded by `maxReplans`.
 * A Plan Edit is not a Replan, so this rule never applies to it. Pure.
 */
import { checkPlanChangeRequest, PLAN_APPROVAL_OPTIONS } from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('a request for changes to a Plan', () => {
  it('is offered as an option of every plan Inbox Item', () => {
    expect(PLAN_APPROVAL_OPTIONS.map((o) => o.id)).toEqual([
      'approve',
      'reject',
      'request_changes',
    ]);
  });

  it('is accepted with feedback while Replans remain', () => {
    expect(
      checkPlanChangeRequest({ replansUsed: 0, maxReplans: 2 }, 'split the Task'),
    ).toBeUndefined();
    expect(checkPlanChangeRequest({ replansUsed: 1, maxReplans: 2 }, 'again')).toBeUndefined();
  });

  it('is refused without feedback: the planner has nothing to act on', () => {
    for (const feedback of [undefined, '', '   ']) {
      expect(checkPlanChangeRequest({ replansUsed: 0, maxReplans: 2 }, feedback)).toMatchObject({
        code: 'feedback_required',
      });
    }
  });

  it('is refused at the cap, naming what remains', () => {
    const refusal = checkPlanChangeRequest({ replansUsed: 2, maxReplans: 2 }, 'more');
    expect(refusal).toMatchObject({ code: 'replan_limit_reached' });
    expect(refusal?.message).toContain('2 of 2');
    expect(refusal?.message).toContain('edit, approve, reject or cancel');
    expect(checkPlanChangeRequest({ replansUsed: 0, maxReplans: 0 }, 'x')).toMatchObject({
      code: 'replan_limit_reached',
    });
  });
});
