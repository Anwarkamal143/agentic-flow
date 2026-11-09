/**
 * Adding up the usage of an Attempt's Harness Runs (ARCHITECTURE §13): the
 * total is only as trustworthy as its least trusted part. Pure; tested
 * through `@factory/domain`.
 */
import { addUsage, type Usage } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const actual: Usage = {
  tag: 'actual',
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.5,
  durationMs: 1_000,
};

describe('addUsage', () => {
  it('adds tokens, cost and duration of two measured Harness Runs', () => {
    expect(addUsage(actual, { ...actual, inputTokens: 50, costUsd: 0.25 })).toEqual({
      tag: 'actual',
      inputTokens: 150,
      outputTokens: 40,
      costUsd: 0.75,
      durationMs: 2_000,
    });
  });

  it('keeps the less trusted tag', () => {
    expect(addUsage(actual, { ...actual, tag: 'estimated' }).tag).toBe('estimated');
    expect(addUsage({ ...actual, tag: 'estimated' }, { ...actual, tag: 'unknown' }).tag).toBe(
      'unknown',
    );
  });

  it('gives no total for a figure either Harness Run did not report, but still adds the duration', () => {
    const unknown: Usage = {
      tag: 'unknown',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: 300,
    };
    expect(addUsage(actual, unknown)).toEqual({
      tag: 'unknown',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: 1_300,
    });
  });
});
