/**
 * The Merge Policy (#59, ADR-0038): stored on the Repository, `never_auto` by
 * default; a Job override may only make it stricter, and
 * `auto_if_low_risk_and_green` is refused until Phase E. Under
 * `human_approval` the `merge` item offers `merge` only while every other
 * Merge Gate condition passes.
 */
import {
  evaluateMergeGate,
  MergeMethodSchema,
  mergeItemOptions,
  MergePolicySchema,
  resolveMergePolicy,
  type MergeGateInput,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const HEAD = '1111111111111111111111111111111111111111';

function input(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    pr: {
      owner: 'acme',
      name: 'tiny-ts',
      state: 'open',
      baseBranch: 'main',
      headBranch: 'factory/job_01/integration',
      headSha: HEAD,
      baseSha: '2222222222222222222222222222222222222222',
      mergeableState: 'clean',
      headSeenAt: '2026-11-15T10:00:00.000Z',
    },
    expected: {
      owner: 'acme',
      name: 'tiny-ts',
      baseBranch: 'main',
      headBranch: 'factory/job_01/integration',
    },
    reviewedHeadSha: HEAD,
    checks: [{ name: 'build', outcome: 'success' }],
    requiredChecks: [],
    graceMs: 120_000,
    now: '2026-11-15T10:00:30.000Z',
    blockingFindings: 0,
    changesRequestedBy: [],
    policy: 'human_approval',
    approval: null,
    ...overrides,
  };
}

describe('the Merge Policy', () => {
  it('accepts never_auto and human_approval and refuses auto_if_low_risk_and_green until Phase E', () => {
    expect(MergePolicySchema.parse('never_auto')).toBe('never_auto');
    expect(MergePolicySchema.parse('human_approval')).toBe('human_approval');
    expect(MergePolicySchema.safeParse('auto_if_low_risk_and_green').success).toBe(false);
  });

  it('defaults the merge method to a merge commit and knows squash and rebase', () => {
    expect(MergeMethodSchema.options).toEqual(['merge', 'squash', 'rebase']);
  });

  it('lets a Job override only make the policy stricter: never_auto is stricter than human_approval', () => {
    expect(resolveMergePolicy('human_approval', undefined)).toEqual({
      ok: true,
      policy: { value: 'human_approval', source: 'repository' },
    });
    expect(resolveMergePolicy('human_approval', 'never_auto')).toEqual({
      ok: true,
      policy: { value: 'never_auto', source: 'job' },
    });
    expect(resolveMergePolicy('never_auto', 'never_auto')).toEqual({
      ok: true,
      policy: { value: 'never_auto', source: 'job' },
    });
    const loosened = resolveMergePolicy('never_auto', 'human_approval');
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) expect(loosened.message).toMatch(/only make .*stricter/);
  });
});

describe('the merge item under human_approval', () => {
  it('waits on the policy until a human approves, then passes it with who approved', () => {
    const waiting = evaluateMergeGate(input());
    expect(waiting.verdict).toBe('pending');
    const policy = waiting.conditions.find((c) => c.id === 'policy');
    expect(policy?.status).toBe('pending');
    expect(policy?.reason).toMatch(/^human_approval: .*Inbox/);
    const approved = evaluateMergeGate(
      input({ approval: { by: 'user:local', at: '2026-11-15T10:01:00.000Z' } }),
    );
    expect(approved.verdict).toBe('pass');
    expect(approved.conditions.find((c) => c.id === 'policy')?.reason).toContain('user:local');
  });

  it('offers merge only while every other gate condition passes, beside request_changes and cancel_job', () => {
    const green = evaluateMergeGate(input());
    expect(mergeItemOptions('human_approval', green).map((o) => o.id)).toEqual([
      'merge',
      'request_changes',
      'cancel_job',
    ]);
    const red = evaluateMergeGate(input({ checks: [{ name: 'build', outcome: 'failure' }] }));
    expect(mergeItemOptions('human_approval', red).map((o) => o.id)).toEqual([
      'request_changes',
      'cancel_job',
    ]);
    const pending = evaluateMergeGate(input({ pr: { ...input().pr, mergeableState: 'blocked' } }));
    expect(mergeItemOptions('human_approval', pending).map((o) => o.id)).toEqual([
      'request_changes',
      'cancel_job',
    ]);
    expect(mergeItemOptions('human_approval', null).map((o) => o.id)).toEqual([
      'request_changes',
      'cancel_job',
    ]);
  });

  it('never offers merge under never_auto, even with every other condition passing', () => {
    const green = evaluateMergeGate(input({ policy: 'never_auto' }));
    expect(mergeItemOptions('never_auto', green).map((o) => o.id)).toEqual([
      'request_changes',
      'cancel_job',
    ]);
  });
});
