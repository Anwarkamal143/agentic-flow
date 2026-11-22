/**
 * The order both claimers take their candidates in (ARCHITECTURE §12 step 1,
 * ADR-0050): the pure `fairOrder`, `priority_weight + aging − project share`,
 * over ready Tasks (the Task claimer) or queued proposal Stage Runs (the
 * proposal-Stage scheduler). Ties go to the longer wait, then to the order the
 * query gives: time ready by event `seq`, then plan order (ADR-0017).
 */
import type { FactoryDb } from '@factory/db';
import {
  fairOrder,
  TASK_PRIORITY_WEIGHT,
  TaskPrioritySchema,
  type FairCandidate,
} from '@factory/domain';
import { sql } from 'drizzle-orm';
import { projectLoad } from './project-slot.js';

/**
 * When a Task last became ready: its latest `task.ready` event, or
 * `task.created` for a Task created ready. Events are written in the same
 * transaction as the state change (outbox), so `seq` is the commit order of
 * the transition and `ts` its time.
 */
const taskReadyEvent = (column: 'seq' | 'ts') =>
  sql.raw(`(
  select e.${column} from events e
  where e.job_id = "tasks"."job_id"
    and e.entity_kind = 'task'
    and e.entity_id = "tasks"."id"
    and e.type in ('task.ready', 'task.created')
  order by e.seq desc limit 1
)`);
export const TASK_READY_SEQ = sql<number>`${taskReadyEvent('seq')}`;
export const TASK_READY_TS = sql<string | null>`${taskReadyEvent('ts')}`;

/** When a proposal Stage Run was queued: its latest `stage_run.queued` event. */
const stageQueuedEvent = (column: 'seq' | 'ts') =>
  sql.raw(`(
  select e.${column} from events e
  where e.job_id = "stage_runs"."job_id"
    and e.entity_kind = 'stage_run'
    and e.entity_id = "stage_runs"."id"
    and e.type = 'stage_run.queued'
  order by e.seq desc limit 1
)`);
export const STAGE_QUEUED_SEQ = sql<number>`${stageQueuedEvent('seq')}`;
export const STAGE_QUEUED_TS = sql<string | null>`${stageQueuedEvent('ts')}`;

/** The weight of a Job's priority (`jobs.priority`, `normal` until Jobs can set one). */
export function jobPriorityWeight(priority: string): number {
  const parsed = TaskPrioritySchema.safeParse(priority);
  return parsed.success ? TASK_PRIORITY_WEIGHT[parsed.data] : 0;
}

/** `candidates` (in the query's tie-break order) in fair order, by the load now. */
export function fairly<C extends FairCandidate>(db: FactoryDb, candidates: readonly C[]): C[] {
  if (candidates.length < 2) return [...candidates];
  return fairOrder(candidates, { now: Date.now(), ...projectLoad(db) });
}
