/**
 * `repository_not_writable` and Partial Completion (#108, ADR-0052,
 * ADR-0068). Before a Task's first Attempt the factory checks that it can
 * deliver to the Task's Repository: the Factory Clone is writable and, with
 * GitHub Coordinates, the token has push permission. A failure blocks the
 * Task with the exact reason; the same Blocker replaces `delivery_failed`
 * when GitHub refuses a push for lack of permission. Dependent Tasks wait;
 * once every other Repository's Tasks are approved, those Repositories are
 * delivered and the held ones are reported as not delivered: a Partial
 * Completion, never a terminal status. No I/O.
 */
import type { RepositoryDeliveryStatus, TaskState } from './execution.js';
import type { Blocker } from './rework.js';

/** What the GitHub port's permission read returned, without importing the port. */
export type PushPermissionRead =
  | { ok: true; push: boolean }
  | {
      ok: false;
      kind: 'rate_limited' | 'transient' | 'refused';
      status: number | null;
      reason: string;
    };

export type Writability =
  | { kind: 'writable' }
  /** The exact reason, for the Blocker's detail. */
  | { kind: 'not_writable'; detail: string }
  /**
   * GitHub could not be asked (a rate limit, a 5xx, a dropped connection):
   * not a verdict, so the Task goes on and the push is the last check.
   */
  | { kind: 'unchecked'; detail: string };

/**
 * The preflight verdict for one Repository: the Factory Clone first, then
 * GitHub's `permissions.push` when it has GitHub Coordinates (`github: null`
 * otherwise). A refused read (a 401, a 403, a 404) is not writable too: the
 * token can't see the repository it would push to. Pure.
 */
export function repositoryWritability(input: {
  repository: { name: string; clonePath: string };
  clone: { writable: true } | { writable: false; problem: string };
  github: { label: string; read: PushPermissionRead } | null;
}): Writability {
  const { repository, clone, github } = input;
  if (!clone.writable) {
    return {
      kind: 'not_writable',
      detail: `the Factory Clone of ${repository.name} at ${repository.clonePath} is not writable by the factory (${clone.problem})`,
    };
  }
  if (github === null) return { kind: 'writable' };
  const { read, label } = github;
  const cannotPush = `so the factory could not push ${repository.name}'s Integration Branch`;
  if (read.ok) {
    return read.push
      ? { kind: 'writable' }
      : {
          kind: 'not_writable',
          detail: `the GitHub token has no push permission on ${label} (GitHub reports the repository's permissions.push as false), ${cannotPush}`,
        };
  }
  const status = read.status === null ? '' : ` ${String(read.status)}`;
  if (read.kind === 'refused') {
    return {
      kind: 'not_writable',
      detail: `the GitHub token can't read ${label} (refused${status}: ${read.reason}), ${cannotPush}`,
    };
  }
  return {
    kind: 'unchecked',
    detail: `the push permission on ${label} could not be read (${read.kind}${status}: ${read.reason}); the push checks it`,
  };
}

/**
 * Whether git's output for a refused push says GitHub refused it for lack of
 * permission (over HTTPS: "Permission to owner/name.git denied", a 403; or
 * "Write access to repository not granted"), not for a reason a retry or a
 * Rework addresses. Pure.
 */
export function isPushPermissionRefusal(gitOutput: string): boolean {
  return (
    /permission to \S+ denied/i.test(gitOutput) ||
    /write access to repository not granted/i.test(gitOutput) ||
    /returned error: 403\b/.test(gitOutput)
  );
}

const IN_PROGRESS: readonly TaskState[] = [
  'ready',
  'claimed',
  'running',
  'verifying',
  'in_review',
  'changes_requested',
];

/**
 * The Repositories held by `repository_not_writable` when every other
 * Repository of the newest Plan can be delivered now, or `null`. A Repository
 * is held when one of its Tasks is blocked `repository_not_writable`. It
 * applies only once nothing is in progress, no Task failed, no Task is blocked
 * for another reason, and every Task of every other Repository is approved: a
 * Task elsewhere that waits on a held one keeps the whole Job waiting
 * (dependents wait). `blocker` is the first held Task's, in Plan order. Pure.
 */
export function partialDelivery(
  tasks: readonly { repositoryId: string; state: TaskState; blocker: Blocker | null }[],
): { held: string[]; blocker: Blocker } | null {
  if (tasks.some((t) => IN_PROGRESS.includes(t.state) || t.state === 'failed')) return null;
  const blocked = tasks.filter((t) => t.state === 'blocked');
  if (blocked.some((t) => t.blocker?.reason !== 'repository_not_writable')) return null;
  const first = blocked[0]?.blocker;
  if (first == null) return null;
  const held = [...new Set(blocked.map((t) => t.repositoryId))];
  const others = tasks.filter((t) => !held.includes(t.repositoryId));
  if (others.length === 0 || others.some((t) => t.state !== 'approved')) return null;
  return { held, blocker: first };
}

/** The statuses that count as delivered: a PR opened or merged, or an approved local branch. */
const DELIVERED: readonly RepositoryDeliveryStatus[] = [
  'merged',
  'awaiting_merge',
  'delivered_locally',
];

/**
 * Partial Completion (GLOSSARY): some Repositories of the Job delivered and
 * others not, with the line the Delivery Report and `job show` print; `null`
 * when every Repository, or none, was delivered. Pure.
 */
export function partialCompletion(
  statuses: readonly RepositoryDeliveryStatus[],
): { delivered: number; total: number; line: string } | null {
  const delivered = statuses.filter((s) => DELIVERED.includes(s)).length;
  const total = statuses.length;
  if (delivered === 0 || delivered === total) return null;
  return {
    delivered,
    total,
    line: `partial completion: ${String(delivered)} of ${String(total)} delivered`,
  };
}
