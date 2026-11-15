/**
 * The re-anchoring rule (#62, ADR-0041; Phase C grilling Q12): after a moved
 * base is merged into the Integration Branch, the approving Integration Review
 * is re-anchored to the new SHAs when the diff from the merge-base to the head
 * is unchanged (`git patch-id --stable`) and the policy is `if_diff_changed`;
 * otherwise the Integration Review runs again.
 */
import { describe, expect, it } from 'vitest';
import { reanchorDecision } from '@factory/domain';

const original = { id: 'rev_1' };

describe('reanchorDecision', () => {
  it('re-anchors the original Review when the diff is unchanged under if_diff_changed', () => {
    const d = reanchorDecision({
      patchIdBefore: 'abc',
      patchIdAfter: 'abc',
      policy: 'if_diff_changed',
      original,
    });
    expect(d).toMatchObject({ kind: 'reanchor', reviewId: 'rev_1' });
    expect(d.reason).toMatch(/unchanged/);
  });

  it('re-runs the Integration Review when the diff changed', () => {
    const d = reanchorDecision({
      patchIdBefore: 'abc',
      patchIdAfter: 'def',
      policy: 'if_diff_changed',
      original,
    });
    expect(d.kind).toBe('rerun');
    expect(d.reason).toMatch(/diff changed/);
  });

  it('re-runs it under always, even when the diff is unchanged', () => {
    const d = reanchorDecision({
      patchIdBefore: 'abc',
      patchIdAfter: 'abc',
      policy: 'always',
      original,
    });
    expect(d.kind).toBe('rerun');
    expect(d.reason).toMatch(/always/);
  });

  it('re-runs it when no approving Integration Review exists to re-anchor (it was skipped)', () => {
    const d = reanchorDecision({
      patchIdBefore: 'abc',
      patchIdAfter: 'abc',
      policy: 'if_diff_changed',
      original: null,
    });
    expect(d.kind).toBe('rerun');
    expect(d.reason).toMatch(/no approving Integration Review/);
  });

  it('treats two empty diffs as unchanged, and an empty against a non-empty one as changed', () => {
    expect(
      reanchorDecision({
        patchIdBefore: null,
        patchIdAfter: null,
        policy: 'if_diff_changed',
        original,
      }).kind,
    ).toBe('reanchor');
    expect(
      reanchorDecision({
        patchIdBefore: 'abc',
        patchIdAfter: null,
        policy: 'if_diff_changed',
        original,
      }).kind,
    ).toBe('rerun');
  });
});
