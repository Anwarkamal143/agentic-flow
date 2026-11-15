import { GITHUB_BACKOFF_CAP_MS, transientBackoffMs } from '@factory/domain';
import { describe, expect, it } from 'vitest';

describe('transientBackoffMs: the wait after consecutive transient GitHub failures (#66, Q23)', () => {
  it('doubles from the poll interval with each failure in a row', () => {
    expect(transientBackoffMs(1, 30_000)).toBe(60_000);
    expect(transientBackoffMs(2, 30_000)).toBe(120_000);
    expect(transientBackoffMs(3, 30_000)).toBe(240_000);
  });

  it('is capped at 5 minutes', () => {
    expect(GITHUB_BACKOFF_CAP_MS).toBe(300_000);
    expect(transientBackoffMs(4, 30_000)).toBe(300_000);
    expect(transientBackoffMs(60, 30_000)).toBe(300_000);
    expect(transientBackoffMs(2_000, 250)).toBe(300_000);
  });

  it('is the poll interval itself before any failure', () => {
    expect(transientBackoffMs(0, 30_000)).toBe(30_000);
  });

  it('never waits less than the poll interval, even one above the cap', () => {
    expect(transientBackoffMs(3, 600_000)).toBe(600_000);
  });
});
