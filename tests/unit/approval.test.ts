/**
 * The approval rule (ARCHITECTURE §4.4, PRODUCT_SPEC §8): a Task is approved
 * only when every Gate passed on the current `(head_sha, base_sha)`, the
 * review approved it, and no mandatory Acceptance Criterion it covers lacks
 * passing Evidence. Pure; tested through `@factory/domain`.
 */
import { decideApproval, type ApprovalInput } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const at = { headSha: HEAD, baseSha: BASE };

/** Everything passing on the current commit. */
function passing(): ApprovalInput {
  return {
    current: at,
    verification: [
      { key: 'test', required: true, exitCode: 0, timedOut: false, ...at },
      { key: 'typecheck', required: true, exitCode: 0, timedOut: false, ...at },
    ],
    criteria: [
      {
        code: 'AC-01',
        mandatory: true,
        evidence: [{ source: 'review', verdict: 'pass', ...at }],
      },
    ],
    review: { outcome: 'approved', blockingFindings: 0, ...at },
  };
}

describe('decideApproval', () => {
  it('approves when every Gate passed on the current commit and the review approved', () => {
    const decision = decideApproval(passing());

    expect(decision).toEqual({
      approved: true,
      problems: [],
      criteria: [{ code: 'AC-01', mandatory: true, verdict: 'pass' }],
    });
  });

  it('treats a review recorded for an older head SHA as stale', () => {
    const input = passing();
    input.review = { outcome: 'approved', blockingFindings: 0, headSha: OLD_HEAD, baseSha: BASE };

    const decision = decideApproval(input);

    expect(decision.approved).toBe(false);
    expect(decision.problems.join('\n')).toMatch(/review .*stale/i);
  });

  it('treats a review recorded against another base as stale', () => {
    const input = passing();
    input.review = { outcome: 'approved', blockingFindings: 0, headSha: HEAD, baseSha: OLD_HEAD };

    expect(decideApproval(input).approved).toBe(false);
  });

  it('refuses approval without a review', () => {
    const input = passing();
    input.review = null;

    const decision = decideApproval(input);

    expect(decision.approved).toBe(false);
    expect(decision.problems.join('\n')).toMatch(/no review/i);
  });

  it('refuses approval when the review requested changes', () => {
    const input = passing();
    input.review = { outcome: 'changes_requested', blockingFindings: 2, ...at };

    const decision = decideApproval(input);

    expect(decision.approved).toBe(false);
    expect(decision.problems.join('\n')).toMatch(/changes requested.*2 blocking/i);
  });

  it('blocks approval when a mandatory criterion has no Evidence', () => {
    const input = passing();
    input.criteria = [{ code: 'AC-01', mandatory: true, evidence: [] }];

    const decision = decideApproval(input);

    expect(decision.approved).toBe(false);
    expect(decision.criteria).toEqual([{ code: 'AC-01', mandatory: true, verdict: 'not_tested' }]);
    expect(decision.problems).toContain('mandatory AC-01 has Evidence not_tested, not pass');
  });

  it.each(['fail', 'blocked', 'not_tested'] as const)(
    'blocks approval when a mandatory criterion has Evidence %s',
    (verdict) => {
      const input = passing();
      input.criteria = [
        { code: 'AC-01', mandatory: true, evidence: [{ source: 'review', verdict, ...at }] },
      ];

      expect(decideApproval(input).approved).toBe(false);
    },
  );

  it('does not let an optional criterion without Evidence block approval', () => {
    const input = passing();
    input.criteria.push({ code: 'AC-02', mandatory: false, evidence: [] });

    const decision = decideApproval(input);

    expect(decision.approved).toBe(true);
    expect(decision.criteria[1]).toEqual({
      code: 'AC-02',
      mandatory: false,
      verdict: 'not_tested',
    });
  });

  it('ignores criterion Evidence recorded for an older head', () => {
    const input = passing();
    input.criteria = [
      {
        code: 'AC-01',
        mandatory: true,
        evidence: [{ source: 'review', verdict: 'pass', headSha: OLD_HEAD, baseSha: BASE }],
      },
    ];

    const decision = decideApproval(input);

    expect(decision.criteria[0]?.verdict).toBe('not_tested');
    expect(decision.approved).toBe(false);
  });

  it('combines both sources: a failing command outweighs a passing review verdict', () => {
    const input = passing();
    input.criteria = [
      {
        code: 'AC-01',
        mandatory: true,
        evidence: [
          { source: 'commands', verdict: 'fail', ...at },
          { source: 'review', verdict: 'pass', ...at },
        ],
      },
    ];

    expect(decideApproval(input).criteria[0]?.verdict).toBe('fail');
  });

  it('combines both sources: a pass from one is enough when the other did not test it', () => {
    const input = passing();
    input.criteria = [
      {
        code: 'AC-01',
        mandatory: true,
        evidence: [
          { source: 'commands', verdict: 'not_tested', ...at },
          { source: 'review', verdict: 'pass', ...at },
        ],
      },
    ];

    expect(decideApproval(input)).toMatchObject({
      approved: true,
      criteria: [{ verdict: 'pass' }],
    });
  });

  it('refuses approval when a required verification command failed or is stale', () => {
    const failed = passing();
    failed.verification[0] = { key: 'test', required: true, exitCode: 1, timedOut: false, ...at };
    const stale = passing();
    stale.verification[1] = {
      key: 'typecheck',
      required: true,
      exitCode: 0,
      timedOut: false,
      headSha: OLD_HEAD,
      baseSha: BASE,
    };

    expect(decideApproval(failed).problems).toContain('verification test exited 1');
    expect(decideApproval(stale).problems.join('\n')).toMatch(/typecheck .*stale/);
  });

  it('lets a failing command that is not required pass', () => {
    const input = passing();
    input.verification.push({
      key: 'lint',
      required: false,
      exitCode: 1,
      timedOut: false,
      ...at,
    });

    expect(decideApproval(input).approved).toBe(true);
  });
});
