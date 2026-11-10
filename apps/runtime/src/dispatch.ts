/**
 * The order the Task scheduler takes ready Tasks in (ARCHITECTURE §12 step 1,
 * ADR-0017). The MVP form of `effective_priority`: the Task's priority first
 * (higher `tasks.priority` runs first), then the time it became ready (the
 * earliest first), then plan order. Aging and the project share penalty are v1.
 */
import { schema } from '@factory/db';
import { asc, desc, sql } from 'drizzle-orm';

/**
 * When a Task last became ready: the `seq` of its latest `task.ready` event,
 * or of `task.created` for a Task created ready. Events are written in the
 * same transaction as the state change (outbox), so this is the commit order
 * of the transition, not a clock reading.
 */
const readySeq = sql`(
  select max(e.seq) from events e
  where e.job_id = ${schema.tasks.jobId}
    and e.entity_kind = 'task'
    and e.entity_id = ${schema.tasks.id}
    and e.type in ('task.ready', 'task.created')
)`;

/** `ORDER BY` terms for selecting ready Tasks (join `tasks`). */
export const READY_TASK_ORDER = [
  desc(schema.tasks.priority),
  asc(readySeq),
  asc(sql`"tasks"."rowid"`),
] as const;
