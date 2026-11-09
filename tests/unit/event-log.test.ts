import { mergeEventLog, type FactoryEvent } from '@factory/domain';
import { describe, expect, it } from 'vitest';

function event(seq: number, type = 'job.created'): FactoryEvent {
  return {
    seq,
    ts: `2026-11-09T00:00:${String(seq).padStart(2, '0')}.000Z`,
    entityKind: 'job',
    entityId: 'job_1',
    jobId: 'job_1',
    type,
    actor: 'system:test',
    payload: {},
  };
}

const seqs = (events: readonly FactoryEvent[]) => events.map((e) => e.seq);

describe('mergeEventLog: one timeline from a loaded page and live events', () => {
  it('appends live events after the loaded ones', () => {
    expect(seqs(mergeEventLog([event(1), event(2)], [event(3), event(4)]))).toEqual([1, 2, 3, 4]);
  });

  it('drops an event delivered twice (a reconnect that replays what was already shown)', () => {
    expect(
      seqs(mergeEventLog([event(1), event(2), event(3)], [event(2), event(3), event(4)])),
    ).toEqual([1, 2, 3, 4]);
  });

  it('keeps the timeline in seq order when events arrive out of order', () => {
    expect(seqs(mergeEventLog([event(1), event(4)], [event(3), event(2)]))).toEqual([1, 2, 3, 4]);
  });

  it('keeps the first copy of a seq, so a re-delivered event never replaces what was shown', () => {
    const merged = mergeEventLog([event(1, 'job.created')], [event(1, 'job.cancelled')]);
    expect(merged.map((e) => e.type)).toEqual(['job.created']);
  });

  it('returns the loaded log unchanged when nothing new arrives', () => {
    const loaded = [event(1), event(2)];
    expect(mergeEventLog(loaded, [])).toBe(loaded);
    expect(mergeEventLog(loaded, [event(2)])).toBe(loaded);
  });
});
