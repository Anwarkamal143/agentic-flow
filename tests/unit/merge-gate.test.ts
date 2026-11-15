/**
 * The Merge Gate (#58, ADR-0037): a pure function over persisted inputs that
 * returns each condition as pass, fail or pending with a reason. The checks
 * condition passes by grace ("no checks reported") only when no check was
 * named in `requiredChecks`; a named one that never reports stays pending.
 */
import {
  evaluateMergeGate,
  observedChecks,
  unresolvedChangeRequests,
  type MergeGateInput,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';
const PUSHED_AT = '2026-11-15T10:00:00.000Z';

function input(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    pr: {
      owner: 'acme',
      name: 'tiny-ts',
      state: 'open',
      baseBranch: 'main',
      headBranch: 'factory/job_01/integration',
      headSha: HEAD,
      baseSha: BASE,
      mergeableState: 'clean',
      headSeenAt: PUSHED_AT,
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
    policy: 'never_auto',
    approval: null,
    ...overrides,
  };
}

const condition = (i: MergeGateInput, id: string) =>
  evaluateMergeGate(i).conditions.find((c) => c.id === id);

describe('the Merge Gate', () => {
  it('passes every condition of a green PR but the never_auto policy, which waits for a human merge on GitHub', () => {
    const gate = evaluateMergeGate(input());
    expect(gate.conditions.map((c) => [c.id, c.status])).toEqual([
      ['target', 'pass'],
      ['reviewed_head', 'pass'],
      ['checks', 'pass'],
      ['reviews', 'pass'],
      ['mergeable', 'pass'],
      ['policy', 'pending'],
    ]);
    expect(gate.verdict).toBe('pending');
    expect(condition(input(), 'policy')?.reason).toMatch(/never_auto.*merge.*on GitHub/i);
  });

  it('fails the target condition on another repository, base or head, or a PR that is not open', () => {
    const wrongBase = input({ pr: { ...input().pr, baseBranch: 'release' } });
    expect(condition(wrongBase, 'target')).toMatchObject({ status: 'fail' });
    expect(condition(wrongBase, 'target')?.reason).toContain('its base is release, not main');
    const wrongRepo = input({ pr: { ...input().pr, owner: 'evil' } });
    expect(condition(wrongRepo, 'target')?.reason).toContain('evil/tiny-ts, not acme/tiny-ts');
    const wrongHead = input({ pr: { ...input().pr, headBranch: 'feature/x' } });
    expect(condition(wrongHead, 'target')?.status).toBe('fail');
    const closed = input({ pr: { ...input().pr, state: 'closed' } });
    expect(condition(closed, 'target')).toMatchObject({ status: 'fail', reason: 'it is closed' });
    expect(evaluateMergeGate(closed).verdict).toBe('fail');
  });

  it('fails when the PR head is not the SHA the Integration Review approved', () => {
    const moved = input({ reviewedHeadSha: BASE });
    expect(condition(moved, 'reviewed_head')).toMatchObject({ status: 'fail' });
    expect(condition(moved, 'reviewed_head')?.reason).toBe(
      'the PR head 111111111111 is not the reviewed 222222222222',
    );
    expect(condition(input({ reviewedHeadSha: null }), 'reviewed_head')?.status).toBe('fail');
  });

  it('accepts success, neutral and skipped checks; a failed one fails the condition', () => {
    const green = input({
      checks: [
        { name: 'build', outcome: 'success' },
        { name: 'lint', outcome: 'neutral' },
        { name: 'deploy', outcome: 'skipped' },
      ],
    });
    expect(condition(green, 'checks')).toMatchObject({
      status: 'pass',
      reason: 'build: success, lint: neutral, deploy: skipped',
    });
    const red = input({
      checks: [
        { name: 'build', outcome: 'success' },
        { name: 'test', outcome: 'failure' },
      ],
    });
    expect(condition(red, 'checks')).toMatchObject({ status: 'fail', reason: 'failed: test' });
  });

  it('a pending check blocks, even after the grace window', () => {
    const pending = input({
      checks: [
        { name: 'build', outcome: 'success' },
        { name: 'test', outcome: 'pending' },
      ],
      now: '2026-11-15T11:00:00.000Z',
    });
    expect(condition(pending, 'checks')).toMatchObject({
      status: 'pending',
      reason: 'pending: test',
    });
  });

  it('with no check reported, waits for the grace window, then passes with "no checks reported"', () => {
    const early = input({ checks: [], now: '2026-11-15T10:01:59.000Z' });
    expect(condition(early, 'checks')).toMatchObject({
      status: 'pending',
      reason:
        'no check reported on 111111111111 yet; the grace window ends at 2026-11-15T10:02:00.000Z',
    });
    const late = input({ checks: [], now: '2026-11-15T10:02:00.000Z' });
    expect(condition(late, 'checks')).toMatchObject({
      status: 'pass',
      reason: 'no checks reported on 111111111111 within 120 s of the push',
    });
  });

  it('narrows the checks to requiredChecks; a required check that never reports stays pending after the grace window', () => {
    const narrowed = input({
      checks: [
        { name: 'ci/build', outcome: 'success' },
        { name: 'optional-lint', outcome: 'failure' },
      ],
      requiredChecks: ['ci/build'],
    });
    expect(condition(narrowed, 'checks')).toMatchObject({
      status: 'pass',
      reason: 'ci/build: success',
    });
    const missing = input({
      checks: [],
      requiredChecks: ['ci/build'],
      now: '2026-11-15T12:00:00.000Z',
    });
    expect(condition(missing, 'checks')).toMatchObject({
      status: 'pending',
      reason: 'required, not reported: ci/build',
    });
    const failedRequired = input({
      checks: [{ name: 'ci/build', outcome: 'failure' }],
      requiredChecks: ['ci/build', 'ci/test'],
    });
    expect(condition(failedRequired, 'checks')?.status).toBe('fail');
  });

  it('fails on blocking Findings or an unresolved CHANGES_REQUESTED review', () => {
    expect(condition(input({ blockingFindings: 2 }), 'reviews')).toMatchObject({
      status: 'fail',
      reason: '2 blocking Findings open',
    });
    expect(condition(input({ changesRequestedBy: ['octo'] }), 'reviews')).toMatchObject({
      status: 'fail',
      reason: 'changes requested on GitHub by octo',
    });
  });

  it('reads mergeable_state as its own condition: clean passes, dirty fails, blocked or unknown waits', () => {
    const at = (mergeableState: string | null) =>
      condition(input({ pr: { ...input().pr, mergeableState } }), 'mergeable')?.status;
    expect(at('clean')).toBe('pass');
    expect(at('unstable')).toBe('pass');
    expect(at('dirty')).toBe('fail');
    expect(at('blocked')).toBe('pending');
    expect(at('unknown')).toBe('pending');
    expect(at(null)).toBe('pending');
  });

  it('fails the verdict when any condition fails, whatever is pending', () => {
    const gate = evaluateMergeGate(input({ checks: [{ name: 'test', outcome: 'failure' }] }));
    expect(gate.verdict).toBe('fail');
  });
});

describe('observedChecks', () => {
  it('counts the newest run of each check name and the newest status of each context', () => {
    const checks = observedChecks(
      [
        { id: 1, name: 'test', status: 'completed', conclusion: 'failure', detailsUrl: null },
        { id: 7, name: 'test', status: 'completed', conclusion: 'success', detailsUrl: 'u7' },
        { id: 3, name: 'build', status: 'in_progress', conclusion: null, detailsUrl: null },
        { id: 4, name: 'e2e', status: 'completed', conclusion: 'timed_out', detailsUrl: null },
      ],
      [
        { context: 'ci/lint', state: 'success', targetUrl: 'l2' },
        { context: 'ci/lint', state: 'failure', targetUrl: 'l1' },
        { context: 'ci/docs', state: 'error', targetUrl: null },
      ],
    );
    expect(checks.map((c) => [c.source, c.name, c.outcome, c.url])).toEqual([
      ['check_run', 'build', 'pending', null],
      ['check_run', 'e2e', 'failure', null],
      ['check_run', 'test', 'success', 'u7'],
      ['status', 'ci/docs', 'failure', null],
      ['status', 'ci/lint', 'success', 'l2'],
    ]);
  });
});

describe('unresolvedChangeRequests', () => {
  it("names each user whose latest deciding review requests changes; a later approval resolves it, a comment doesn't", () => {
    expect(
      unresolvedChangeRequests([
        { id: 1, state: 'CHANGES_REQUESTED', author: 'ann' },
        { id: 2, state: 'COMMENTED', author: 'ann' },
        { id: 3, state: 'CHANGES_REQUESTED', author: 'bob' },
        { id: 4, state: 'APPROVED', author: 'bob' },
      ]),
    ).toEqual(['ann']);
  });
});
