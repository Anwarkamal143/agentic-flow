/**
 * The Delivery Report v3's branch list (ADR-0028): every Task Branch, which
 * are leaves, and which to fetch. No I/O.
 */
import type { TaskState } from './execution.js';

const isApproved = (state: TaskState) => state === 'approved' || state === 'integrated';

/**
 * For each Task, in the order given (Plan order): `leaf` when no other Task
 * depends on it; `offered` (one `git fetch`) when it is approved and no
 * approved Task depends on it. Its branch then holds every approved Task
 * beneath it, through the Dependency Base. A failed or cancelled leaf is
 * listed, never offered; the approved Tasks beneath it are offered instead
 * (the partial results). Pure.
 */
export function deliveryBranches(
  tasks: readonly { key: string; state: TaskState; dependsOn: readonly string[] }[],
): { key: string; leaf: boolean; offered: boolean }[] {
  return tasks.map((t) => {
    const dependents = tasks.filter((o) => o.dependsOn.includes(t.key));
    return {
      key: t.key,
      leaf: dependents.length === 0,
      offered: isApproved(t.state) && !dependents.some((o) => isApproved(o.state)),
    };
  });
}
