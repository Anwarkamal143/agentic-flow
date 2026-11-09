/**
 * Crash recovery (ARCHITECTURE §12, ADR-0012): what the runtime does on
 * startup with an Attempt a previous runtime left unfinished. A Harness
 * process that is still alive, or that finished while no runtime watched, is
 * re-attached; a dead one makes the Attempt `interrupted`, and the Task gets a
 * Retry only if its Worktree is clean and Retries remain. A Retry never counts
 * toward the Rework cap. Pure; tested through `@factory/domain`.
 */
import {
  attemptsCountedForRework,
  decideRecovery,
  routeFailedAttempt,
  type RecoveryInput,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const running = (over: Partial<RecoveryInput> = {}): RecoveryInput => ({
  attemptState: 'running',
  process: 'dead',
  worktree: 'clean',
  retriesUsed: 0,
  maxRetries: 2,
  ...over,
});

describe('crash recovery', () => {
  it('re-attaches a developer Harness process that is alive, or that finished unwatched', () => {
    expect(decideRecovery(running({ process: 'alive' }))).toEqual({ kind: 'reattach' });
    expect(decideRecovery(running({ process: 'finished' }))).toEqual({ kind: 'reattach' });
  });

  it('retries an Attempt whose Harness process died, when the Worktree is clean', () => {
    expect(decideRecovery(running({ process: 'dead' }))).toEqual({ kind: 'retry' });
    expect(decideRecovery(running({ process: 'none' }))).toEqual({ kind: 'retry' });
  });

  it('blocks instead of retrying when the dead Attempt left uncommitted changes', () => {
    expect(decideRecovery(running({ worktree: 'dirty' }))).toMatchObject({
      kind: 'blocked',
      quarantine: false,
      blocker: { kind: 'recovery', reason: 'recovery_uncertain' },
    });
  });

  it('blocks when the Retries are used up', () => {
    expect(decideRecovery(running({ retriesUsed: 2, maxRetries: 2 }))).toMatchObject({
      kind: 'blocked',
      quarantine: false,
      blocker: { kind: 'recovery', reason: 'retry_cap_reached' },
    });
    expect(decideRecovery(running({ maxRetries: 0 }))).toMatchObject({
      kind: 'blocked',
      blocker: { reason: 'retry_cap_reached' },
    });
  });

  it('quarantines a Worktree of unknown status and blocks, even with a live process', () => {
    for (const process of ['alive', 'finished', 'dead', 'none'] as const) {
      for (const attemptState of ['running', 'verifying', 'in_review'] as const) {
        expect(
          decideRecovery(running({ attemptState, process, worktree: 'unknown' })),
        ).toMatchObject({
          kind: 'blocked',
          quarantine: true,
          blocker: { kind: 'recovery', reason: 'recovery_uncertain' },
        });
      }
    }
  });

  it("resumes the factory's own verification, whatever happened to its command", () => {
    for (const process of ['alive', 'finished', 'dead', 'none'] as const) {
      expect(decideRecovery(running({ attemptState: 'verifying', process }))).toEqual({
        kind: 'resume',
        from: 'verification',
      });
    }
    // The Harness is done by then: leftovers are the factory's to commit (a WIP commit).
    expect(decideRecovery(running({ attemptState: 'verifying', worktree: 'dirty' }))).toEqual({
      kind: 'resume',
      from: 'verification',
    });
  });

  it('re-attaches a live or finished reviewer, else runs the review again at the same head', () => {
    expect(decideRecovery(running({ attemptState: 'in_review', process: 'alive' }))).toEqual({
      kind: 'reattach',
    });
    expect(decideRecovery(running({ attemptState: 'in_review', process: 'finished' }))).toEqual({
      kind: 'reattach',
    });
    for (const process of ['dead', 'none'] as const) {
      expect(decideRecovery(running({ attemptState: 'in_review', process }))).toEqual({
        kind: 'resume',
        from: 'review',
      });
    }
  });
});

describe('Retries and the Rework cap', () => {
  it('does not count a Retry toward max_attempts', () => {
    const causes = [{ cause: 'initial' }, { cause: 'retry' }] as const;
    expect(attemptsCountedForRework(causes)).toBe(1);
    expect(
      routeFailedAttempt({
        exitReason: 'gates_failed',
        findings: [{ faultOrigin: 'implementation', blocking: true }],
        n: attemptsCountedForRework(causes),
        maxAttempts: 2,
      }),
    ).toEqual({ kind: 'rework' });
    expect(
      attemptsCountedForRework([{ cause: 'initial' }, { cause: 'retry' }, { cause: 'rework' }]),
    ).toBe(2);
  });
});
