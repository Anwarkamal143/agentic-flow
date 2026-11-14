/**
 * Versioned decisions on Inbox Items (ARCHITECTURE §5, §16; PRODUCT_SPEC §10):
 * a decision names the item's version and subject, and only a human decides.
 * Pure; tested through `@factory/domain`.
 */
import { checkInboxChange, PLAN_APPROVAL_OPTIONS, type InboxItemRef } from '@factory/domain';
import { describe, expect, it } from 'vitest';

const item: InboxItemRef = {
  state: 'open',
  version: 3,
  subjectRef: 'art_plan1',
  options: PLAN_APPROVAL_OPTIONS,
};
const ok = {
  actor: 'user:local',
  expectedVersion: 3,
  subjectRef: 'art_plan1',
  option: 'approve',
};

describe('a decision on an Inbox Item', () => {
  it('is accepted when it names the open item at its version and subject', () => {
    expect(checkInboxChange(item, ok)).toBeUndefined();
    expect(checkInboxChange(item, { ...ok, option: 'reject' })).toBeUndefined();
  });

  it('is refused from an agent actor, whatever else it names', () => {
    expect(checkInboxChange(item, { ...ok, actor: 'agent:fake/att_1' })).toMatchObject({
      code: 'actor_not_allowed',
    });
    expect(checkInboxChange(item, { ...ok, actor: 'system:scheduler' })).toMatchObject({
      code: 'actor_not_allowed',
    });
  });

  it('is refused at another version, naming both versions', () => {
    const refusal = checkInboxChange(item, { ...ok, expectedVersion: 2 });
    expect(refusal).toMatchObject({ code: 'version_conflict' });
    expect(refusal?.message).toContain('version 3');
    expect(refusal?.message).toContain('not 2');
  });

  it('is refused on another subject (a replaced Plan)', () => {
    const refusal = checkInboxChange(item, { ...ok, subjectRef: 'art_plan0' });
    expect(refusal).toMatchObject({ code: 'subject_mismatch' });
    expect(refusal?.message).toContain('art_plan1');
  });

  it('is refused once the item is no longer open', () => {
    for (const state of ['decided', 'cancelled', 'superseded'] as const) {
      expect(checkInboxChange({ ...item, state }, ok), state).toMatchObject({
        code: 'item_not_open',
      });
    }
  });

  it('is refused for an option the item does not offer', () => {
    expect(checkInboxChange(item, { ...ok, option: 'replan' })).toMatchObject({
      code: 'unknown_option',
    });
  });

  it('defer and undefer need the version but no option or subject', () => {
    const defer = { actor: 'user:local', expectedVersion: 3 };
    expect(checkInboxChange(item, defer)).toBeUndefined();
    expect(checkInboxChange(item, { ...defer, expectedVersion: 4 })).toMatchObject({
      code: 'version_conflict',
    });
    expect(checkInboxChange(item, { ...defer, actor: 'agent:fake/att_1' })).toMatchObject({
      code: 'actor_not_allowed',
    });
  });
});
