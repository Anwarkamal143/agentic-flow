/**
 * Adding up the usage of an Attempt's Harness Runs (ARCHITECTURE §13): the
 * total is only as trustworthy as its least trusted part. Pure; tested
 * through `@factory/domain`.
 */
import { addUsage, costTagOf, type Usage } from '@factory/domain';
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
      costTag: 'actual',
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
      costTag: 'unknown',
      durationMs: 1_300,
    });
  });

  it('keeps a subscription cost as unknown/subscription, never as a figure', () => {
    const subscription: Usage = {
      ...actual,
      costUsd: null,
      costTag: 'unknown/subscription',
    };
    const total = addUsage(subscription, subscription);
    expect(total.tag).toBe('actual');
    expect(total.costTag).toBe('unknown/subscription');
    expect(total.costUsd).toBeNull();
  });

  it('ranks a subscription cost below an estimate and above an unknown one', () => {
    const subscription: Usage = { ...actual, costUsd: null, costTag: 'unknown/subscription' };
    expect(addUsage(subscription, { ...actual, costTag: 'estimated' }).costTag).toBe(
      'unknown/subscription',
    );
    expect(addUsage(subscription, { ...actual, tag: 'unknown', costTag: 'unknown' }).costTag).toBe(
      'unknown',
    );
  });

  it('reads usage recorded before cost tags existed by its one tag', () => {
    expect(costTagOf({ tag: 'estimated' })).toBe('estimated');
    expect(addUsage(actual, { ...actual, tag: 'unknown' }).costTag).toBe('unknown');
  });
});
