/**
 * Replan carry-over (ARCHITECTURE §4.7, ADR-0029): which of a Job's Tasks a
 * new Plan keeps. One pure decision, so every Replan (requested, from an
 * Inbox option, or "request changes") and every Plan Edit applies the same
 * rule. No I/O.
 */
import type { TaskState } from './execution.js';
import type { PlanTaskProposal } from './proposals.js';

/** A Task of the Job as the carry-over sees it. */
export interface CarryOverTask {
  id: string;
  key: string;
  state: TaskState;
  /** The Plan entry it was created (or last carried over) from, its repository given by id. */
  entry: PlanTaskProposal;
  /** `approved` only: its current Evidence and review still match its `(head_sha, base_sha)`. */
  approvalHolds: boolean;
  /** `blocked` only: its Blocker's Inbox Item is what triggered this Replan. */
  resolvedByReplan: boolean;
}

/** Why an unfinished Task was not carried over. */
export type CarryOverMiss =
  | 'removed'
  | 'definition_changed'
  | 'dependency_not_carried'
  | 'approval_stale'
  | 'resolved_by_replan';

export interface CarryOverPlan {
  /** Kept with its id; `to` is its state under the new Plan (`pending` recomputed). */
  carried: { key: string; taskId: string; from: TaskState; to: TaskState }[];
  /** Unfinished and not kept: cancelled by the Replan, its Worktree preserved. */
  cancelled: { key: string; taskId: string; why: CarryOverMiss }[];
  /** New Tasks (new id, fresh counts, fresh Worktree); `replaces` names an earlier Task of that key. */
  created: { key: string; state: 'pending' | 'ready'; replaces: string | null }[];
}

/** Task states with an Attempt in flight: no Replan is decided while one is. */
const IN_FLIGHT: readonly TaskState[] = ['claimed', 'running', 'verifying', 'in_review'];
/** Finished: never carried over, never cancelled again. */
const FINISHED: readonly TaskState[] = ['cancelled', 'failed', 'integrated'];

/**
 * Decides the carry-over from the Job's Tasks (`current`) to the new Plan's
 * entries (`next`, their repository given by id). A Task carries over only if
 * it is unfinished, its key and whole entry are identical (dependencies
 * included), every Task it depends on carries over, an `approved` one still
 * holds, and a `blocked` one did not trigger this Replan. Throws while an
 * Attempt is in flight.
 */
export function decideCarryOver(
  current: readonly CarryOverTask[],
  next: readonly PlanTaskProposal[],
): CarryOverPlan {
  const flying = current.find((t) => IN_FLIGHT.includes(t.state));
  if (flying !== undefined) {
    throw new Error(`Task ${flying.key} is ${flying.state}: an Attempt is in flight`);
  }
  const live = new Map(
    current.filter((t) => !FINISHED.includes(t.state)).map((t) => [t.key, t] as const),
  );
  const nextByKey = new Map(next.map((e) => [e.key, e] as const));

  const misses = new Map<string, CarryOverMiss>();
  const carries = (key: string, seen: ReadonlySet<string> = new Set()): boolean => {
    const task = live.get(key);
    if (task === undefined || misses.has(key)) return false;
    const entry = nextByKey.get(key);
    const miss: CarryOverMiss | undefined =
      entry === undefined
        ? 'removed'
        : !sameValue(task.entry, entry)
          ? 'definition_changed'
          : task.state === 'approved' && !task.approvalHolds
            ? 'approval_stale'
            : task.state === 'blocked' && task.resolvedByReplan
              ? 'resolved_by_replan'
              : seen.has(key) || !entry.dependsOn.every((d) => carries(d, new Set([...seen, key])))
                ? 'dependency_not_carried'
                : undefined;
    if (miss !== undefined) misses.set(key, miss);
    return miss === undefined;
  };
  const kept = new Set([...live.keys()].filter((key) => carries(key)));

  const approvedAfter = (key: string) => kept.has(key) && live.get(key)?.state === 'approved';
  const allApproved = (deps: readonly string[]) => deps.every(approvedAfter);

  const plan: CarryOverPlan = { carried: [], cancelled: [], created: [] };
  for (const task of current) {
    if (FINISHED.includes(task.state)) continue;
    if (kept.has(task.key)) {
      const to =
        task.state === 'pending' && allApproved(task.entry.dependsOn) ? 'ready' : task.state;
      plan.carried.push({ key: task.key, taskId: task.id, from: task.state, to });
    } else {
      plan.cancelled.push({
        key: task.key,
        taskId: task.id,
        why: misses.get(task.key) ?? 'removed',
      });
    }
  }
  for (const entry of next) {
    if (kept.has(entry.key)) continue;
    const earlier = current.filter((t) => t.key === entry.key).at(-1);
    plan.created.push({
      key: entry.key,
      state: allApproved(entry.dependsOn) ? 'ready' : 'pending',
      replaces: earlier?.id ?? null,
    });
  }
  return plan;
}

/** What {@link approvalStillHolds} checks: the Task's last Attempt and what ran against it. */
export interface ApprovalRecord {
  attempt: { state: string; headSha: string | null; baseSha: string } | undefined;
  evidence: readonly { headSha: string; baseSha: string }[];
  reviews: readonly { headSha: string; baseSha: string }[];
}

/**
 * Whether an `approved` Task's approval still holds for carry-over: its last
 * Attempt passed on a recorded head, it has Evidence, and every Evidence and
 * review of that Attempt ran against exactly its `(head_sha, base_sha)`.
 */
export function approvalStillHolds(record: ApprovalRecord): boolean {
  const { attempt } = record;
  if (attempt?.state !== 'passed' || attempt.headSha === null) return false;
  if (record.evidence.length === 0) return false;
  const on = (r: { headSha: string; baseSha: string }) =>
    r.headSha === attempt.headSha && r.baseSha === attempt.baseSha;
  return record.evidence.every(on) && record.reviews.every(on);
}

/** Deep equality of JSON values, ignoring object key order. */
function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
