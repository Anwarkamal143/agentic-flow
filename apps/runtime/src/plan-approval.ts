/**
 * The `plan_approval` Stage (PRODUCT_SPEC §4, ADR-0016, ADR-0019). It runs no
 * Harness: entering it either skips it (`planApproval: skip`) or opens a
 * `plan` Inbox Item and waits `waiting_human` on it, in the transaction that
 * finished `planning`. A human's decision ends it `succeeded` or `rejected`,
 * or, on "request changes", `superseded` by a Replan: new Stage Runs of
 * `planning` and `plan_approval`.
 */
import { appendEvent, schema, type Tx } from '@factory/db';
import {
  EffectiveConfigSchema,
  PLAN_APPROVAL_OPTIONS,
  type ApprovalKind,
  type ExpiresPolicy,
} from '@factory/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import { readJobState, type JobState, type StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { settleExecution } from './execution.js';

type StageRunRow = JobState['stageRuns'][number];

/**
 * Queues the first `pending` Stage after `afterPosition`, inside the Job's
 * versioned change. `plan_approval` is entered instead of queued: skipped (and
 * the Stage after it queued) or left waiting on a new `plan` Inbox Item.
 */
export function queueNextStage(
  tx: Tx,
  jobId: string,
  step: StageRunStepper,
  afterPosition: number,
  actor: string,
): void {
  const { job, stageRuns } = readJobState(tx, jobId);
  const next = stageRuns.find((r) => r.position > afterPosition && r.state === 'pending');
  if (next === undefined) return;
  if (next.stageId !== 'plan_approval') {
    step(next, 'queued');
    if (next.stageId === 'execution') settleIfNothingToClaim(tx, jobId, step, next.id);
    return;
  }
  const policy = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson)).planApproval;
  if (policy.value === 'skip') {
    step(next, 'skipped', { reason: `planApproval: skip (from ${policy.source})` });
    queueNextStage(tx, jobId, step, next.position, actor);
    return;
  }
  step(next, 'queued');
  step(reread(tx, next.id), 'running');
  step(reread(tx, next.id), 'waiting_human', {
    reason: `planApproval: required (from ${policy.source}); waiting for a human to approve or reject the Plan`,
  });
  openPlanItem(tx, jobId, next.id, actor);
}

/**
 * After a Replan, the new Plan may hold no Task to claim (every one carried
 * over approved or blocked, ADR-0029): nothing would ever settle `execution`,
 * so it is run and settled here (`succeeded`, or waiting on its Blockers).
 */
function settleIfNothingToClaim(tx: Tx, jobId: string, step: StageRunStepper, runId: string): void {
  const plan = latestArtifact(tx, jobId, 'plan');
  const ready = tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        eq(schema.tasks.planArtifactId, plan?.id ?? ''),
        eq(schema.tasks.state, 'ready'),
      ),
    )
    .get();
  if (ready !== undefined) return;
  step(reread(tx, runId), 'running');
  settleExecution(tx, readJobState(tx, jobId), step);
}

/** Opens the `plan` Inbox Item for the Job's newest Plan, holding `stageRunId`. */
export function openPlanItem(tx: Tx, jobId: string, stageRunId: string, actor: string): string {
  const plan = latestArtifact(tx, jobId, 'plan');
  if (plan === undefined) throw new Error(`Job ${jobId} reached plan_approval without a Plan`);
  const spec = latestArtifact(tx, jobId, 'spec');
  const id = newId('apr');
  const kind: ApprovalKind = 'plan';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId,
      stageRunId,
      kind,
      subjectRef: plan.id,
      question: 'Approve this Plan?',
      why: 'Every new Plan waits for a human before any Task runs (planApproval: required). Review it with: factory plan show <job>.',
      optionsJson: JSON.stringify(PLAN_APPROVAL_OPTIONS),
      recommended: null,
      evidenceJson: JSON.stringify(spec === undefined ? [plan.id] : [spec.id, plan.id]),
      state: 'open',
      deferred: false,
      requestedBy: actor,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId,
    type: 'approval.opened',
    actor,
    payload: { kind, subjectRef: plan.id, stageRunId },
  });
  return id;
}

/**
 * "Request changes" (a Replan at `plan_approval`, ARCHITECTURE §4.7): the
 * waiting `plan_approval` Stage Run is `superseded`, one Replan is counted,
 * and new Stage Runs of
 * `planning` (queued) and `plan_approval` (pending) are added. The planner then
 * re-plans from the current Plan and the item's feedback (`replanRequestOf`).
 * The caller has checked the cap and the feedback. The replaced Plan's Tasks
 * stay as they are until the new Plan is stored: the carry-over then keeps
 * the unaffected ones and cancels the rest (`persistPlanTasks`, ADR-0029).
 */
export function startReplan(
  tx: Tx,
  input: { jobId: string; run: StageRunRow; planArtifactId: string; approvalId: string },
  step: StageRunStepper,
  actor: string,
): void {
  const { jobId, run } = input;
  step(run, 'superseded', {
    reason: `${actor} requested changes to Plan ${input.planArtifactId}; the planner re-plans`,
  });
  const { job, stageRuns } = readJobState(tx, jobId);
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const replansUsed = job.replansUsed + 1;
  tx.update(schema.jobs).set({ replansUsed }).where(eq(schema.jobs.id, jobId)).run();
  appendEvent(tx, {
    entityKind: 'job',
    entityId: jobId,
    jobId,
    type: 'job.replanned',
    actor,
    payload: {
      replansUsed,
      maxReplans: config.maxReplans.value,
      planArtifactId: input.planArtifactId,
      approvalId: input.approvalId,
    },
  });
  const planning = latestRunOf(stageRuns, 'planning');
  const nextPlanning = addStageRun(tx, jobId, planning, actor);
  addStageRun(tx, jobId, run, actor);
  step(nextPlanning, 'queued');
}

/** Adds the next Stage Run (`attempt + 1`, `pending`) of `of`'s Stage, with its event. */
function addStageRun(tx: Tx, jobId: string, of: StageRunRow, actor: string): StageRunRow {
  const id = newId('stg');
  tx.insert(schema.stageRuns)
    .values({
      id,
      jobId,
      stageId: of.stageId,
      position: of.position,
      state: 'pending',
      attempt: of.attempt + 1,
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'stage_run',
    entityId: id,
    jobId,
    type: 'stage_run.created',
    actor,
    payload: { stageId: of.stageId, attempt: of.attempt + 1, replaces: of.id, reason: 'replan' },
  });
  return reread(tx, id);
}

function latestRunOf(runs: readonly StageRunRow[], stageId: string): StageRunRow {
  const run = runs.filter((r) => r.stageId === stageId).at(-1);
  if (run === undefined) throw new Error(`the Job has no ${stageId} Stage Run`);
  return run;
}

/** The newest Artifact of `kind` of the Job. */
export function latestArtifact(
  tx: Tx | Parameters<typeof readJobState>[0],
  jobId: string,
  kind: 'plan' | 'spec' | 'triage',
): typeof schema.artifacts.$inferSelect | undefined {
  return tx
    .select()
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.kind, kind)))
    .orderBy(desc(schema.artifacts.createdAt), desc(sql`"artifacts"."rowid"`))
    .limit(1)
    .get();
}

function reread(tx: Tx, id: string): StageRunRow {
  const row = tx.select().from(schema.stageRuns).where(eq(schema.stageRuns.id, id)).get();
  if (row === undefined) throw new Error(`no Stage Run ${id}`);
  return row;
}
