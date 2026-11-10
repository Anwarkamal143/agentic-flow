import { describe, expect, it } from 'vitest';
import { EffectiveConfigSchema, resolveEffectiveConfig } from '@factory/domain';

describe('resolveEffectiveConfig: Phase B caps and concurrency', () => {
  it('takes the recipe defaults when the Project sets nothing', () => {
    const config = resolveEffectiveConfig({ project: {} });
    expect(config.maxReplans).toEqual({ value: 2, source: 'recipe' });
    expect(config.concurrency).toEqual({
      perRepository: { value: 2, source: 'recipe' },
      perJob: { value: 2, source: 'recipe' },
    });
  });

  it('takes Project values with their source level', () => {
    const config = resolveEffectiveConfig({
      project: { maxReplans: 0, concurrency: { perRepository: 1, perJob: 4 } },
    });
    expect(config.maxReplans).toEqual({ value: 0, source: 'project' });
    expect(config.concurrency).toEqual({
      perRepository: { value: 1, source: 'project' },
      perJob: { value: 4, source: 'project' },
    });
  });

  it('resolves each concurrency limit on its own', () => {
    const config = resolveEffectiveConfig({ project: { concurrency: { perJob: 1 } } });
    expect(config.concurrency).toEqual({
      perRepository: { value: 2, source: 'recipe' },
      perJob: { value: 1, source: 'project' },
    });
  });

  it('gives a Job frozen before Phase B the recipe defaults', () => {
    const frozen = {
      maxAttempts: { value: 3, source: 'recipe' },
    };
    const config = EffectiveConfigSchema.parse(frozen);
    expect(config.maxReplans).toEqual({ value: 2, source: 'recipe' });
    expect(config.concurrency.perRepository).toEqual({ value: 2, source: 'recipe' });
    expect(config.concurrency.perJob).toEqual({ value: 2, source: 'recipe' });
  });
});
