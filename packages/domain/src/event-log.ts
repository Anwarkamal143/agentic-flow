/**
 * Event-log rules a client of the event stream needs. Imports nothing, so a
 * browser bundle can take it without the rest of the domain
 * (`@factory/domain/event-log`).
 */

/** What identifies and orders an event: its `seq` (ARCHITECTURE §4.1). */
export interface LoggedEvent {
  seq: number;
}

/**
 * One timeline from the events already shown and newly delivered ones (the
 * dashboard's loaded page plus its SSE stream). `seq` identifies an event:
 * a re-delivered `seq` is dropped and the first copy kept, and the result is
 * in `seq` order. Returns `existing` itself when nothing new arrived. Pure.
 */
export function mergeEventLog<E extends LoggedEvent>(
  existing: readonly E[],
  incoming: readonly E[],
): readonly E[] {
  const seen = new Set(existing.map((e) => e.seq));
  const fresh: E[] = [];
  for (const e of incoming) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    fresh.push(e);
  }
  if (fresh.length === 0) return existing;
  return [...existing, ...fresh].sort((a, b) => a.seq - b.seq);
}
