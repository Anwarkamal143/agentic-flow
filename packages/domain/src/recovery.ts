/**
 * Crash recovery (ARCHITECTURE §12, ADR-0012): what the runtime does at
 * startup with an Attempt that a previous runtime left in progress. The
 * runtime gathers the facts (is the recorded process alive and still ours,
 * is the Worktree clean); this rule decides. No I/O.
 */
import type { Blocker } from './rework.js';

/**
 * The Attempt's recorded process, as recovery finds it. `alive`: running, and
 * provably the same process (pid plus start time). `finished`: it exited while
 * no runtime watched, and its exit status was written. `dead`: gone without an
 * exit status (killed, or the machine stopped). `none`: no process is recorded.
 */
export type RecoveredProcess = 'alive' | 'finished' | 'dead' | 'none';

/** `unknown`: the Worktree is missing or git can't read it. */
export type RecoveredWorktree = 'clean' | 'dirty' | 'unknown';

export interface RecoveryInput {
  attemptState: 'running' | 'verifying' | 'in_review';
  process: RecoveredProcess;
  worktree: RecoveredWorktree;
  /** Retries the Task has had already. */
  retriesUsed: number;
  maxRetries: number;
}

/**
 * `reattach`: watch the Harness process (or read the result it left) and go on
 * from there; nothing new is started. `resume`: the factory re-runs its own
 * step (its verification commands, or the review at the same head); a live
 * verification command is stopped first. `retry`: the Attempt is
 * `interrupted` and the Task goes back to `ready` for a Retry. `blocked`: the
 * Attempt is `interrupted` and the Task gets a recovery Blocker; the Worktree
 * is preserved, or `quarantined` when its state is unknown. Every outcome but
 * `reattach` stops a live process before acting, so no second process ever
 * runs beside it.
 */
export type RecoveryAction =
  | { kind: 'reattach' }
  | { kind: 'resume'; from: 'verification' | 'review' }
  | { kind: 'retry' }
  | {
      kind: 'blocked';
      quarantine: boolean;
      blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'>;
    };

export function decideRecovery(input: RecoveryInput): RecoveryAction {
  if (input.worktree === 'unknown') {
    return {
      kind: 'blocked',
      quarantine: true,
      blocker: {
        kind: 'recovery',
        reason: 'recovery_uncertain',
        detail: 'after the runtime stopped, the Worktree is missing or git cannot read it',
        requiredAction:
          'inspect the quarantined Worktree; the factory never deletes it, and nothing more runs there',
      },
    };
  }
  const watchable = input.process === 'alive' || input.process === 'finished';
  if (input.attemptState === 'verifying') return { kind: 'resume', from: 'verification' };
  if (input.attemptState === 'in_review') {
    return watchable ? { kind: 'reattach' } : { kind: 'resume', from: 'review' };
  }
  if (watchable) return { kind: 'reattach' };
  // The developer Harness process is gone: the Attempt was interrupted.
  if (input.worktree === 'dirty') {
    return {
      kind: 'blocked',
      quarantine: false,
      blocker: {
        kind: 'recovery',
        reason: 'recovery_uncertain',
        detail:
          'the Harness process died with the runtime and left uncommitted changes, so a Retry could build on half-done work',
        requiredAction:
          'look at the uncommitted changes in the preserved Worktree and decide how the Task goes on',
      },
    };
  }
  if (input.retriesUsed >= input.maxRetries) {
    return {
      kind: 'blocked',
      quarantine: false,
      blocker: {
        kind: 'recovery',
        reason: 'retry_cap_reached',
        detail: `the Harness process died with the runtime, and the Task has had ${String(input.retriesUsed)} of at most ${String(input.maxRetries)} Retries`,
        requiredAction:
          'find out why the Attempts keep being interrupted, then decide how the Task goes on',
      },
    };
  }
  return { kind: 'retry' };
}
