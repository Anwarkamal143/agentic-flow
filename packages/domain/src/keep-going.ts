/**
 * Keep going (ARCHITECTURE §4.4, ADR-0028): when one Task is `blocked` or
 * `failed`, the Tasks that don't depend on it keep dispatching. A `failed`
 * Task's dependents can never start, so they are `cancelled` with reason
 * `dependency_failed`; the `execution` Stage ends only once nothing else can
 * make progress. The Job status then follows from the Stage Runs (spec issue
 * 9's precedence). No I/O.
 */
import type { TaskState } from './execution.js';
import type { Blocker } from './rework.js';

/** Task states in which the Task is still being worked on, or is about to be. */
const IN_PROGRESS: readonly TaskState[] = [
  'ready',
  'claimed',
  'running',
  'verifying',
  'in_review',
  'changes_requested',
];

/** States a Task never leaves (bar `approved → integrated`, which is Phase C). */
const FINISHED: readonly TaskState[] = ['approved', 'integrated', 'failed', 'cancelled'];

/**
 * The unfinished Tasks that depend on `failedId`, directly or transitively,
 * in the order given (Plan order). Each is to be `cancelled` with reason
 * `dependency_failed`. A dependent already finished (say, cancelled) is left
 * as it is, but what waits on it is still found.
 */
export function dependentsToCancel(
  failedId: string,
  tasks: readonly { id: string; state: TaskState; dependsOn: readonly string[] }[],
): string[] {
  const doomed = new Set<string>([failedId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (doomed.has(t.id)) continue;
      if (t.dependsOn.some((d) => doomed.has(d))) {
        doomed.add(t.id);
        grew = true;
      }
    }
  }
  return tasks
    .filter((t) => t.id !== failedId && doomed.has(t.id) && !FINISHED.includes(t.state))
    .map((t) => t.id);
}

export type ExecutionOutcome =
  /** Some Task is still in progress: `execution` keeps running. */
  | { kind: 'running' }
  /** Nothing is in progress and a Blocker holds a Task: the Stage waits on it (human ones first). */
  | { kind: 'waiting_human' | 'blocked'; blocker: Blocker }
  /** Nothing else can make progress and these Tasks failed. */
  | { kind: 'failed'; failedKeys: string[] }
  | { kind: 'succeeded' }
  /** No rule applies (no Task, or a cancelled Task with no failure): leave the Stage as it is. */
  | { kind: 'unchanged' };

/**
 * How the `execution` Stage stands, from the Tasks of the newest Plan, in
 * Plan order. In progress beats everything; then a Blocker, since its Task
 * (and its `pending` dependents) can still make progress once it is cleared;
 * only then `failed`. Pure.
 */
export function executionOutcome(
  tasks: readonly { key: string; state: TaskState; blocker: Blocker | null }[],
): ExecutionOutcome {
  if (tasks.some((t) => IN_PROGRESS.includes(t.state))) return { kind: 'running' };
  const blockers = tasks.flatMap((t) => (t.state === 'blocked' && t.blocker ? [t.blocker] : []));
  const blocker = blockers.find((b) => b.kind === 'human') ?? blockers[0];
  if (blocker !== undefined) {
    return { kind: blocker.kind === 'human' ? 'waiting_human' : 'blocked', blocker };
  }
  const failedKeys = tasks.filter((t) => t.state === 'failed').map((t) => t.key);
  if (failedKeys.length > 0) return { kind: 'failed', failedKeys };
  if (tasks.length > 0 && tasks.every((t) => t.state === 'approved')) return { kind: 'succeeded' };
  return { kind: 'unchanged' };
}
