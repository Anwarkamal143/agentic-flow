/**
 * The `plan_approval` Stage (PRODUCT_SPEC §4, ADR-0016). It runs no Harness:
 * entering it either skips it (`planApproval: skip`) or opens a `plan` Inbox
 * Item and waits `waiting_human` on it, in the transaction that finished
 * `planning`. A human's decision ends it `succeeded` or `rejected`.
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

function openPlanItem(tx: Tx, jobId: string, stageRunId: string, actor: string): void {
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
