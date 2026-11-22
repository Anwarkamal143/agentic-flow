/**
 * The Delivery Order (ADR-0052, GLOSSARY): the order in which a
 * multi-Repository Job's pull requests may merge, taken from the Plan's
 * cross-repo dependency edges. A Task in Repository B that depends on a Task
 * in Repository A puts A before B. A cycle between Repositories makes the
 * Plan invalid (`plan.delivery_order_cycle`), so a stored order is always
 * defined. Pure.
 */
import { z } from 'zod';

/** One Repository's place in the Delivery Order. */
export const DeliveryOrderEntrySchema = z.object({
  repositoryId: z.string(),
  name: z.string(),
  /**
   * The Repositories (by id, in Delivery Order) whose Tasks this Repository's
   * Tasks depend on directly: the PRs that must merge before this one's.
   */
  after: z.array(z.string()),
});
export type DeliveryOrderEntry = z.infer<typeof DeliveryOrderEntrySchema>;

/** Every Repository the Plan has Tasks in, upstream first. */
export const DeliveryOrderSchema = z.array(DeliveryOrderEntrySchema);
export type DeliveryOrder = z.infer<typeof DeliveryOrderSchema>;

export type DeliveryOrderResult =
  | { ok: true; order: DeliveryOrder }
  /** The Repositories of a cycle by name, the first repeated at the end. */
  | { ok: false; cycle: string[] };

/**
 * The Delivery Order of a Plan's Tasks. `repository` is a Repository id of
 * `repositories`; a Task in an unknown Repository and a dependency on an
 * unknown Task are ignored (other Plan rules report them). Only Repositories
 * with a Task are listed; Repositories no edge orders are listed by name,
 * then id (the smallest ready one first at each step).
 */
export function deliveryOrder(
  tasks: readonly { key: string; repository: string; dependsOn: readonly string[] }[],
  repositories: readonly { id: string; name: string }[],
): DeliveryOrderResult {
  const known = new Map(repositories.map((r) => [r.id, r]));
  const repoOfTask = new Map(
    tasks.filter((t) => known.has(t.repository)).map((t) => [t.key, t.repository]),
  );
  const byName = (a: string, b: string) => {
    const ra = known.get(a);
    const rb = known.get(b);
    return (ra?.name ?? '').localeCompare(rb?.name ?? '') || a.localeCompare(b);
  };
  const ids = [...new Set(repoOfTask.values())].sort(byName);
  // upstream.get(B) holds every A with a Task of B depending on a Task of A.
  const upstream = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const t of tasks) {
    const to = repoOfTask.get(t.key);
    if (to === undefined) continue;
    for (const dep of t.dependsOn) {
      const from = repoOfTask.get(dep);
      if (from !== undefined && from !== to) upstream.get(to)?.add(from);
    }
  }
  const cycle = findCycle(ids, upstream);
  if (cycle !== undefined) {
    return { ok: false, cycle: cycle.map((id) => known.get(id)?.name ?? id) };
  }
  const placed: string[] = [];
  const pending = new Set(ids);
  while (pending.size > 0) {
    const next = [...pending].find((id) =>
      [...(upstream.get(id) ?? [])].every((u) => placed.includes(u)),
    );
    if (next === undefined) throw new Error('no ready Repository in an acyclic order');
    placed.push(next);
    pending.delete(next);
  }
  return {
    ok: true,
    order: placed.map((id) => ({
      repositoryId: id,
      name: known.get(id)?.name ?? id,
      after: placed.filter((u) => upstream.get(id)?.has(u) === true),
    })),
  };
}

/** A cycle in the upstream → downstream graph, as ids in edge direction, if any. */
function findCycle(
  ids: readonly string[],
  upstream: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | undefined {
  // Walk downstream edges (A → B when B depends on A), from each id in name order.
  const downstream = new Map(ids.map((id) => [id, [] as string[]]));
  for (const id of ids) for (const u of upstream.get(id) ?? []) downstream.get(u)?.push(id);
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const next of downstream.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of ids) {
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}
