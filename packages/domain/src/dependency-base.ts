/**
 * The Dependency Base (ARCHITECTURE §10, GLOSSARY, ADR-0021): the commit a
 * dependent Task's Worktree starts from. It is local to the Job and is not
 * the Integration Branch (§14). No I/O: this decides which heads, git makes
 * the commit.
 */
import type { TaskState } from './execution.js';

/** One dependency of the Task, as recorded: its state and its approved head. */
export interface DependencyFact {
  key: string;
  state: TaskState;
  /** The head its passing Attempt was approved on; `null` when there is none. */
  headSha: string | null;
}

export type DependencyBasePlan =
  /** No dependency: the default branch, freshly fetched. */
  | { kind: 'default_branch' }
  /** One distinct dependency head: that commit itself. */
  | { kind: 'head'; sha: string }
  /** Several: merged in this order into one local commit in the Factory Clone. */
  | { kind: 'merge'; heads: string[] }
  /** A dependency is not approved (or has no head): the Task can't start yet. */
  | { kind: 'not_ready'; keys: string[] };

/** Decides the Dependency Base from the Task's dependencies, given in Plan order. */
export function planDependencyBase(deps: readonly DependencyFact[]): DependencyBasePlan {
  if (deps.length === 0) return { kind: 'default_branch' };
  const notReady = deps
    .filter((d) => !(d.state === 'approved' || d.state === 'integrated') || d.headSha === null)
    .map((d) => d.key);
  if (notReady.length > 0) return { kind: 'not_ready', keys: notReady };
  const heads = [...new Set(deps.map((d) => d.headSha ?? ''))];
  const [only] = heads;
  if (heads.length === 1 && only !== undefined) return { kind: 'head', sha: only };
  return { kind: 'merge', heads };
}
