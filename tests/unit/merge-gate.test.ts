/**
 * The Merge Gate (#58, ADR-0037): a pure function over persisted inputs that
 * returns each condition as pass, fail or pending with a reason. The checks
 * condition passes by grace ("no checks reported") only when no check was
 * named in `requiredChecks`; a named one that never reports stays pending.
 */
import {
  evaluateMergeGate,
  failingChecks,
  observedChecks,
  readyButForPolicy,
  rerunPlan,
  describeRerunnability,
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

describe('the Merge Gate in Delivery Order (multi-repo, #106, ADR-0052)', () => {
  const api = {
    repository: 'api',
    pullRequest: 'acme/api#12',
    state: 'open',
    mergeApproved: false,
  } as const;

  it('has no Delivery Order condition when the Repository comes after none (a single-repo Job, or the first)', () => {
    expect(evaluateMergeGate(input()).conditions.map((c) => c.id)).not.toContain('delivery_order');
    expect(evaluateMergeGate(input({ earlier: [] })).conditions.map((c) => c.id)).not.toContain(
      'delivery_order',
    );
  });

  it('waits, before the policy, until the earlier PR in Delivery Order has merged, naming it', () => {
    const waiting = evaluateMergeGate(input({ earlier: [api] }));
    expect(waiting.conditions.map((c) => c.id)).toEqual([
      'target',
      'reviewed_head',
      'checks',
      'reviews',
      'mergeable',
      'delivery_order',
      'policy',
    ]);
    expect(waiting.conditions.find((c) => c.id === 'delivery_order')).toEqual({
      id: 'delivery_order',
      label: 'The earlier PR in Delivery Order has merged',
      status: 'pending',
      reason:
        'waits for acme/api#12 (api) to merge: this Repository comes after api in the Delivery Order',
    });
    expect(readyButForPolicy(waiting)).toBe(false);
  });

  it('passes once every earlier PR has merged', () => {
    const merged = input({ earlier: [{ ...api, state: 'merged' }], policy: 'human_approval' });
    expect(condition(merged, 'delivery_order')).toMatchObject({
      status: 'pass',
      reason: 'acme/api#12 (api) has merged',
    });
    expect(readyButForPolicy(evaluateMergeGate(merged))).toBe(true);
  });

  it('under human_approval, passes when the earlier merge is approved: the factory merges it first', () => {
    const approved = input({
      earlier: [{ ...api, mergeApproved: true }],
      policy: 'human_approval',
    });
    expect(condition(approved, 'delivery_order')).toMatchObject({
      status: 'pass',
      reason:
        'acme/api#12 (api): its merge is approved, and the factory merges it first, in Delivery Order',
    });
    // Under never_auto a human merges on GitHub: an approval is no merge.
    const neverAuto = input({ earlier: [{ ...api, mergeApproved: true }] });
    expect(condition(neverAuto, 'delivery_order')?.status).toBe('pending');
  });

  it('names an earlier Repository with no pull request, or a closed one, and waits on every earlier one', () => {
    const gate = evaluateMergeGate(
      input({
        earlier: [
          { repository: 'lib', pullRequest: null, state: null, mergeApproved: false },
          { ...api, state: 'closed' },
          { repository: 'db', pullRequest: 'acme/db#3', state: 'merged', mergeApproved: false },
        ],
      }),
    );
    expect(gate.conditions.find((c) => c.id === 'delivery_order')).toMatchObject({
      status: 'pending',
      reason:
        'waits for lib (no pull request opened yet) and acme/api#12 (api, closed without merging) to merge: this Repository comes after lib, api and db in the Delivery Order',
    });
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

  it("keeps a check run's output summary (or title) and a status's description, for the CI failure's context", () => {
    const checks = observedChecks(
      [
        {
          id: 1,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: 'u1',
          summary: '2 tests failed',
        },
        { id: 2, name: 'build', status: 'completed', conclusion: 'success', detailsUrl: null },
      ],
      [{ context: 'ci/lint', state: 'failure', targetUrl: null, description: 'lint errors' }],
    );
    expect(checks.map((c) => [c.name, c.summary])).toEqual([
      ['build', null],
      ['test', '2 tests failed'],
      ['ci/lint', 'lint errors'],
    ]);
  });
  it('records the app that made each check run (a status has none), so rerun_checks can tell what it can re-run', () => {
    const checks = observedChecks(
      [
        {
          id: 1,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: null,
          app: 'github-actions',
        },
        { id: 2, name: 'circle', status: 'completed', conclusion: 'failure', detailsUrl: null },
      ],
      [{ context: 'ci/lint', state: 'failure', targetUrl: null }],
    );
    expect(checks.map((c) => [c.name, c.app])).toEqual([
      ['circle', null],
      ['test', 'github-actions'],
      ['ci/lint', null],
    ]);
  });
});

describe('the checks that fail the gate (ci_failed, #61)', () => {
  const check = (name: string, outcome: 'success' | 'failure' | 'pending', source = 'check_run') =>
    ({ source, name, outcome, url: `https://ci.example/${name}`, summary: null }) as const;

  it('are every failed check when no check is required, in the order given', () => {
    const checks = [check('build', 'failure'), check('lint', 'success'), check('test', 'failure')];
    expect(failingChecks(checks, []).map((c) => c.name)).toEqual(['build', 'test']);
  });

  it('are only the required ones when the Repository names required checks: a failed optional check fails nothing', () => {
    const checks = [check('build', 'failure'), check('flaky', 'failure'), check('test', 'pending')];
    expect(failingChecks(checks, ['build', 'test']).map((c) => c.name)).toEqual(['build']);
    expect(failingChecks(checks, ['test'])).toEqual([]);
  });

  it('agree with the gate: the checks condition fails exactly when some check fails', () => {
    const checks = [check('flaky', 'failure'), check('build', 'success')];
    expect(condition(input({ checks, requiredChecks: ['build'] }), 'checks')?.status).toBe('pass');
    expect(failingChecks(checks, ['build'])).toEqual([]);
    expect(condition(input({ checks, requiredChecks: [] }), 'checks')?.status).toBe('fail');
  });
});

describe('rerunPlan', () => {
  const ACTIONS = 'github-actions';
  const run = (
    id: number,
    name: string,
    conclusion: string | null,
    opts: { status?: string; app?: string | null; suite?: number | null } = {},
  ) => ({
    id,
    name,
    status: opts.status ?? 'completed',
    conclusion,
    detailsUrl: null,
    app: opts.app === undefined ? ACTIONS : opts.app,
    checkSuiteId: opts.suite === undefined ? 100 : opts.suite,
  });
  const ci = { id: 9001, name: 'ci', status: 'completed', checkSuiteId: 100 };
  const nightly = { id: 9002, name: 'nightly', status: 'completed', checkSuiteId: 200 };

  it('re-runs the workflow run of the newest run of each failed Actions check, once per workflow run', () => {
    const plan = rerunPlan({
      runs: [
        run(1, 'build', 'failure'),
        run(5, 'build', 'failure'),
        run(2, 'test', 'failure'),
        run(6, 'test', 'success'),
        run(3, 'lint', 'timed_out'),
        run(4, 'e2e', null, { status: 'in_progress' }),
        run(7, 'docs', 'failure', { suite: 200 }),
      ],
      failedStatuses: [],
      workflowRuns: [ci, nightly],
      requiredChecks: [],
    });
    expect(plan).toEqual({
      workflowRuns: [
        { id: 9001, name: 'ci', checks: ['build', 'lint'] },
        { id: 9002, name: 'nightly', checks: ['docs'] },
      ],
      notRerun: [],
    });
  });

  it('only counts required checks when the Repository names them', () => {
    const plan = rerunPlan({
      runs: [run(1, 'build', 'failure'), run(2, 'flaky', 'failure', { suite: 200 })],
      failedStatuses: [],
      workflowRuns: [ci, nightly],
      requiredChecks: ['build'],
    });
    expect(plan.workflowRuns).toEqual([{ id: 9001, name: 'ci', checks: ['build'] }]);
  });

  it("names what it can't re-run: another app's check run, a commit status, a run with no workflow run, a workflow still running", () => {
    const plan = rerunPlan({
      runs: [
        run(1, 'build', 'failure'),
        run(2, 'circle', 'failure', { app: 'circleci-checks', suite: 300 }),
        run(3, 'orphan', 'failure', { suite: 400 }),
        run(4, 'docs', 'failure', { suite: 200 }),
      ],
      failedStatuses: ['legacy/ci'],
      workflowRuns: [ci, { ...nightly, status: 'in_progress' }],
      requiredChecks: [],
    });
    expect(plan.workflowRuns).toEqual([{ id: 9001, name: 'ci', checks: ['build'] }]);
    expect(plan.notRerun).toEqual([
      { name: 'circle', why: 'other_app', app: 'circleci-checks' },
      { name: 'docs', why: 'workflow_running', workflow: 'nightly' },
      { name: 'orphan', why: 'no_workflow_run' },
      { name: 'legacy/ci', why: 'commit_status' },
    ]);
  });

  it('re-runs nothing when only checks from other apps and commit statuses fail', () => {
    const plan = rerunPlan({
      runs: [run(1, 'circle', 'failure', { app: 'circleci-checks', suite: null })],
      failedStatuses: ['legacy/ci'],
      workflowRuns: [ci],
      requiredChecks: [],
    });
    expect(plan.workflowRuns).toEqual([]);
    expect(plan.notRerun.map((n) => n.name)).toEqual(['circle', 'legacy/ci']);
  });
});

describe('describeRerunnability', () => {
  it('reads from what the poller recorded: only an Actions check run can be re-run', () => {
    expect(
      describeRerunnability([
        { name: 'build', source: 'check_run', app: 'github-actions' },
        { name: 'circle', source: 'check_run', app: 'circleci-checks' },
        { name: 'old', source: 'check_run', app: null },
        { name: 'legacy/ci', source: 'status', app: null },
      ]),
    ).toBe(
      "rerun_checks can re-run build (GitHub Actions), once its workflow run has finished; it can't re-run circle (a check run made by the app circleci-checks), old (a check run made by an unknown app), legacy/ci (a commit status)",
    );
    expect(
      describeRerunnability([{ name: 'build', source: 'check_run', app: 'github-actions' }]),
    ).toBe('rerun_checks can re-run build (GitHub Actions), once its workflow run has finished');
    expect(describeRerunnability([{ name: 'legacy/ci', source: 'status', app: null }])).toBe(
      "rerun_checks can't re-run legacy/ci (a commit status)",
    );
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
