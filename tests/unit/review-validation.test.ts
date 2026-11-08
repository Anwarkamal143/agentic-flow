/**
 * Code checks on a reviewer's proposal, after its schema passed. Each problem
 * names its rule, so the one re-prompt can carry it back to the reviewer.
 */
import { validateReview, type FindingProposal, type ReviewProposal } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const finding = (over: Partial<FindingProposal> = {}): FindingProposal => ({
  severity: 'low',
  faultOrigin: 'implementation',
  location: 'src/math.ts:5',
  problem: 'No test for negative numbers.',
  why: 'The Specification lists negative numbers as an edge case.',
  recommendation: 'Add sum(-2, -3).',
  blocking: false,
  ...over,
});

const review = (over: Partial<ReviewProposal> = {}): ReviewProposal => ({
  outcome: 'approved',
  summary: 'sum() is correct.',
  findings: [],
  criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'sum(2, 3) is 5 in the diff' }],
  ...over,
});

const rules = (r: ReviewProposal) => validateReview(r, { criteria: ['AC-01'] }).map((i) => i.rule);

describe('validateReview', () => {
  it('accepts an approval whose findings do not block', () => {
    expect(rules(review({ findings: [finding()] }))).toEqual([]);
  });

  it('accepts changes_requested with a blocking finding', () => {
    expect(
      rules(review({ outcome: 'changes_requested', findings: [finding({ blocking: true })] })),
    ).toEqual([]);
  });

  it('rejects an approval with a blocking finding', () => {
    expect(rules(review({ findings: [finding({ blocking: true })] }))).toEqual([
      'review.outcome_consistent',
    ]);
  });

  it('rejects changes_requested that names no blocking finding', () => {
    expect(rules(review({ outcome: 'changes_requested', findings: [finding()] }))).toEqual([
      'review.outcome_consistent',
    ]);
  });

  it.each(['critical', 'high'] as const)('rejects a %s finding marked not blocking', (severity) => {
    expect(
      rules(
        review({
          outcome: 'changes_requested',
          findings: [finding({ severity, blocking: false })],
        }),
      ),
    ).toEqual(['review.blocking_severity']);
  });

  it('rejects a verdict on a criterion the Task does not cover, and two verdicts on one', () => {
    const verdict = { verdict: 'pass' as const, detail: '' };
    expect(
      rules(
        review({
          criteria: [
            { code: 'AC-01', ...verdict },
            { code: 'AC-01', ...verdict },
            { code: 'AC-09', ...verdict },
          ],
        }),
      ),
    ).toEqual(['review.criteria_unique', 'review.criteria_known']);
  });
});
