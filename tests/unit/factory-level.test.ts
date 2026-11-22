/**
 * The Factory Level (ADR-0049, ADR-0056): what the first start copies from
 * `config.json`, which file keys are stale, and setting one key. Pure; tested
 * through `@factory/domain`.
 */
import {
  bootstrapFactoryLevel,
  factoryConfigKeys,
  factoryGlobalConcurrency,
  setFactoryConfigKey,
  staleBootstrapKeys,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('the Factory Level', () => {
  it('copies config.json concurrency.global on the first start, and nothing else', () => {
    expect(bootstrapFactoryLevel({ concurrency: { global: 4 } })).toEqual({
      concurrency: { global: 4 },
    });
    expect(bootstrapFactoryLevel({ concurrency: {} })).toEqual({});
    expect(bootstrapFactoryLevel(undefined)).toEqual({});
  });

  it('names concurrency.global stale while config.json sets it', () => {
    expect(staleBootstrapKeys({ concurrency: { global: 1 } })).toEqual(['concurrency.global']);
    expect(staleBootstrapKeys({})).toEqual([]);
    expect(staleBootstrapKeys(undefined)).toEqual([]);
  });

  it('defaults concurrency.global to 3', () => {
    expect(factoryGlobalConcurrency({})).toBe(3);
    expect(factoryGlobalConcurrency({ concurrency: { global: 8 } })).toBe(8);
  });

  it('sets one key, validated, leaving the given config unchanged', () => {
    const before = {};
    expect(factoryConfigKeys()).toEqual([
      'maxAttempts',
      'maxRetries',
      'maxQuestions',
      'planApproval',
      'maxReplans',
      'review.rerunOnBaseChange',
      'mergePolicy',
      'concurrency.global',
      'concurrency.perRepository',
      'concurrency.perJob',
    ]);
    expect(setFactoryConfigKey(before, 'concurrency.global', 2)).toEqual({
      ok: true,
      config: { concurrency: { global: 2 } },
    });
    expect(before).toEqual({});
    expect(setFactoryConfigKey(before, 'concurrency.global', 65)).toMatchObject({
      ok: false,
      code: 'invalid_config_value',
    });
    expect(setFactoryConfigKey(before, 'concurrency.perProjectJobs', 2)).toMatchObject({
      ok: false,
      code: 'unknown_config_key',
    });
    expect(setFactoryConfigKey(before, 'maxAttempts', 2)).toEqual({
      ok: true,
      config: { maxAttempts: 2 },
    });
  });
});
