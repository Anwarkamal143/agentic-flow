import { harnessRunCost, type ModelTokens } from '@factory/domain';
import { describe, expect, it } from 'vitest';

/** One model's usage as Claude Code's `modelUsage` reports it (shape seen on 2.1.x). */
function opus(over: Partial<ModelTokens> = {}): ModelTokens {
  return {
    model: 'claude-opus-5-5',
    inputTokens: 2,
    outputTokens: 4,
    cacheReadTokens: 649,
    cacheWriteTokens: 2273,
    listCostUsd: 0.0184018,
    ...over,
  };
}

describe('harnessRunCost: what a Harness Run cost, and how far that can be trusted', () => {
  it('is unknown/subscription for a Run billed to the subscription login, whatever the CLI estimates', () => {
    expect(harnessRunCost({ billedTo: 'subscription', models: [opus()] })).toEqual({
      costUsd: null,
      costTag: 'unknown/subscription',
    });
  });

  it('is unknown when it is not known what the Run was billed to', () => {
    expect(harnessRunCost({ billedTo: undefined, models: [opus()] })).toEqual({
      costUsd: null,
      costTag: 'unknown',
    });
  });

  it('is the list-price estimate, tagged estimated, for a Run billed to an API key', () => {
    const cost = harnessRunCost({
      billedTo: 'api_key',
      models: [opus(), opus({ model: 'claude-haiku-5-5', listCostUsd: 0.001 })],
    });
    expect(cost.costTag).toBe('estimated');
    expect(cost.costUsd).toBeCloseTo(0.0194018, 10);
  });

  it('uses the configured price table for a model it lists (USD per million tokens)', () => {
    const cost = harnessRunCost({
      billedTo: 'api_key',
      models: [
        opus({
          inputTokens: 1_000_000,
          outputTokens: 2_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      ],
      prices: {
        'claude-opus-5-5': {
          inputUsdPerMTok: 3,
          outputUsdPerMTok: 10,
          cacheReadUsdPerMTok: 0.3,
          cacheWriteUsdPerMTok: 3.75,
        },
      },
    });
    // 1 M input at $3 + 2 M output at $10.
    expect(cost).toEqual({ costUsd: 23, costTag: 'estimated' });
  });

  it('prices cache reads and writes at their own rates', () => {
    const cost = harnessRunCost({
      billedTo: 'api_key',
      models: [
        opus({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 1_000_000,
        }),
      ],
      prices: {
        'claude-opus-5-5': {
          inputUsdPerMTok: 3,
          outputUsdPerMTok: 10,
          cacheReadUsdPerMTok: 0.25,
          cacheWriteUsdPerMTok: 4,
        },
      },
    });
    // 2 M cache reads at $0.25 + 1 M cache writes at $4.
    expect(cost).toEqual({ costUsd: 4.5, costTag: 'estimated' });
  });

  it('is unknown when a model has neither a configured price nor a list cost', () => {
    expect(
      harnessRunCost({
        billedTo: 'api_key',
        models: [opus(), opus({ model: 'x', listCostUsd: null })],
      }),
    ).toEqual({ costUsd: null, costTag: 'unknown' });
  });

  it('is unknown when the Run reported no per-model usage', () => {
    expect(harnessRunCost({ billedTo: 'api_key', models: [] })).toEqual({
      costUsd: null,
      costTag: 'unknown',
    });
  });
});
