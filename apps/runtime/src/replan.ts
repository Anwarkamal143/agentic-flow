/**
 * Replanning during execution (ARCHITECTURE §4.7, ADR-0029): a Replan asked
 * for by the operator (`requestReplan`) or by an Inbox option ("replan" on a
 * cap Blocker, "replan with this request as feedback" on a scope change
 * Question). The request is stored once (a `replan_request` Artifact) and
 * counted against `maxReplans` in the transaction that records it, with
 * `jobs.replan_requested` and its event. From then on no Task is claimed;
 * `planning` starts only once no Attempt is in flight. At the cap the request
 * waits in a `replan_cap_reached` Blocker Approval instead. Everything here
 * runs inside the caller's versioned Job transaction.
 */
import { appendEvent, schema, type Tx } from '@factory/db';
import {
  blockerOptions,
  EffectiveConfigSchema,
  JobStatusSchema,
  TERMINAL_JOB_STATUSES,
  type ApprovalKind,
  type ExpiresPolicy,
  type ReplanRequestContent,
} from '@factory/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { readJobState, type JobState, type StageRunStepper } from './engine.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { latestArtifact } from './plan-approval.js';

type StageRunRow = JobState['stageRuns'][number];

/** Task states whose Attempt is in flight: planning waits for them (ARCHITECTURE §4.7). */
const IN_FLIGHT = ['claimed', 'running', 'verifying', 'in_review'];
/** `execution` states a Replan may replace. */
const ACTIVE_EXECUTION = ['queued', 'running', 'waiting_human', 'blocked'];

/** What a Replan request did: started (it waits, or planning began), or held at the cap. */
export type ReplanOutcome =
  { kind: 'requested'; planningStarted: boolean } | { kind: 'capped'; approvalId: string };

/** The Job's newest Stage Run of `stageId`. */
export function latestStageRun(state: JobState, stageId: string): StageRunRow | undefined {
  return state.stageRuns.filter((r) => r.stageId === stageId).at(-1);
}

/**
 * Records a Replan request: refused unless the Job is executing with no
 * Replan pending. Under `maxReplans` it counts one Replan and sets
 * `replan_requested` (planning starts at once when nothing is in flight); at
 * the cap it opens a `replan_cap_reached` Blocker Approval holding it.
 */
export function requestReplanIn(
  tx: Tx,
  artifacts: Pick<ArtifactStore, 'writeContent' | 'record'>,
  input: { jobId: string; feedback: string; actor: string; approvalId: string | null },
  step: StageRunStepper,
): ReplanOutcome {
  const state = readJobState(tx, input.jobId);
  refuseUnlessReplannable(tx, state);
  const plan = latestArtifact(tx, input.jobId, 'plan');
  if (plan === undefined) throw new Error(`Job ${input.jobId} executes without a Plan`);
  const content: ReplanRequestContent = {
    planArtifactId: plan.id,
    feedback: input.feedback,
    requestedBy: input.actor,
    approvalId: input.approvalId,
  };
  const request = artifacts.record(
    tx,
    { jobId: input.jobId, kind: 'replan_request', content: artifacts.writeContent(content) },
    input.actor,
  );
  const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
  if (state.job.replansUsed >= config.maxReplans.value) {
    const approvalId = openReplanCapItem(tx, state, {
      requestId: request.id,
      actor: input.actor,
      replansUsed: state.job.replansUsed,
      maxReplans: config.maxReplans.value,
    });
    return { kind: 'capped', approvalId };
  }
  return beginReplan(tx, input.jobId, { requestId: request.id, ...content }, step);
}

/**
 * "Grant one more Replan" on a `replan_cap_reached` Approval: `maxReplans`
 * becomes one more than were used (audited, `user:local`), and the held
 * request starts as if it had been under the cap.
 */
export function grantReplanIn(
  tx: Tx,
  item: { id: string; jobId: string; subjectRef: string },
  actor: string,
  readRequest: (artifactId: string) => ReplanRequestContent,
  step: StageRunStepper,
): ReplanOutcome {
  const state = readJobState(tx, item.jobId);
  refuseUnlessReplannable(tx, state, item.id);
  const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
  const from = config.maxReplans.value;
  const to = Math.max(state.job.replansUsed, from) + 1;
  tx.update(schema.jobs)
    .set({
      configSnapshotJson: JSON.stringify({ ...config, maxReplans: { value: to, source: 'job' } }),
    })
    .where(eq(schema.jobs.id, item.jobId))
    .run();
  const auditId = newId('aud');
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: new Date().toISOString(),
      actor,
      action: 'cap.raised',
      target: `job:${item.jobId}`,
      jobId: item.jobId,
      beforeJson: JSON.stringify({ maxReplans: from }),
      afterJson: JSON.stringify({ maxReplans: to }),
      policyRef: `inbox:${item.id}/grant_replan`,
      correlationId: item.id,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'job',
    entityId: item.jobId,
    jobId: item.jobId,
    type: 'audit.recorded',
    actor,
    payload: { auditId, action: 'cap.raised', cap: 'maxReplans', from, to, approvalId: item.id },
  });
  const request = readRequest(item.subjectRef);
  return beginReplan(tx, item.jobId, { requestId: item.subjectRef, ...request }, step);
}

/**
 * Starts `planning` for a requested Replan once no Attempt is in flight: the
 * newest `execution` is `superseded`, `replan_requested` cleared, and new
 * Stage Runs of `planning` (queued), `plan_approval` and `execution`
 * (pending) added. `true` when it started. Call wherever an Attempt settles.
 */
export function startRequestedReplan(
  tx: Tx,
  jobId: string,
  step: StageRunStepper,
  actor: string,
): boolean {
  const state = readJobState(tx, jobId);
  if (!state.job.replanRequested) return false;
  const execution = latestStageRun(state, 'execution');
  if (execution === undefined || !ACTIVE_EXECUTION.includes(execution.state)) return false;
  const flying = tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.jobId, jobId), inArray(schema.tasks.state, IN_FLIGHT)))
    .get();
  if (flying !== undefined) return false;

  step(execution, 'superseded', {
    reason: 'a Replan was requested; the planner re-plans now that no Attempt is in flight',
  });
  tx.update(schema.jobs).set({ replanRequested: false }).where(eq(schema.jobs.id, jobId)).run();
  const planning = requireLatest(state, 'planning');
  const nextPlanning = addStageRun(tx, jobId, planning, actor);
  addStageRun(tx, jobId, requireLatest(state, 'plan_approval'), actor);
  addStageRun(tx, jobId, execution, actor);
  step(nextPlanning, 'queued');
  appendEvent(tx, {
    entityKind: 'job',
    entityId: jobId,
    jobId,
    type: 'job.replanning',
    actor,
    payload: { replansUsed: state.job.replansUsed, supersededExecution: execution.id },
  });
  return true;
}

/** Counts the Replan, sets `replan_requested` with its event, and starts planning if it can. */
function beginReplan(
  tx: Tx,
  jobId: string,
  request: ReplanRequestContent & { requestId: string },
  step: StageRunStepper,
): ReplanOutcome {
  const job = readJobState(tx, jobId).job;
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const replansUsed = job.replansUsed + 1;
  tx.update(schema.jobs)
    .set({ replansUsed, replanRequested: true })
    .where(eq(schema.jobs.id, jobId))
    .run();
  appendEvent(tx, {
    entityKind: 'job',
    entityId: jobId,
    jobId,
    type: 'job.replan_requested',
    actor: request.requestedBy,
    payload: {
      feedback: request.feedback,
      replansUsed,
      maxReplans: config.maxReplans.value,
      planArtifactId: request.planArtifactId,
      requestArtifactId: request.requestId,
      approvalId: request.approvalId,
    },
  });
  const planningStarted = startRequestedReplan(tx, jobId, step, request.requestedBy);
  return { kind: 'requested', planningStarted };
}

/** 409 unless the Job is executing with no Replan pending (requested, or held at the cap). */
function refuseUnlessReplannable(tx: Tx, state: JobState, holdingItemId?: string): void {
  const status = JobStatusSchema.parse(state.job.status);
  if (TERMINAL_JOB_STATUSES.includes(status)) {
    throw new ApiFailure(409, 'job_terminal', `Job ${state.job.id} is already ${status}`);
  }
  const execution = latestStageRun(state, 'execution');
  if (execution === undefined || !ACTIVE_EXECUTION.includes(execution.state)) {
    throw new ApiFailure(
      409,
      'not_executing',
      `Job ${state.job.id} is not executing a Plan; before execution, use request changes at plan_approval (factory plan request-changes)`,
    );
  }
  if (state.job.replanRequested) {
    throw new ApiFailure(
      409,
      'replan_already_requested',
      `a Replan of Job ${state.job.id} is already requested and waits for the Attempts in flight`,
    );
  }
  const held = tx
    .select({ id: schema.approvals.id, optionsJson: schema.approvals.optionsJson })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, state.job.id),
        eq(schema.approvals.kind, 'blocker'),
        eq(schema.approvals.state, 'open'),
      ),
    )
    .all()
    .find((a) => a.id !== holdingItemId && a.optionsJson.includes('"grant_replan"'));
  if (held !== undefined) {
    throw new ApiFailure(
      409,
      'replan_cap_pending',
      `a Replan of Job ${state.job.id} already waits at the Replan cap in Inbox Item ${held.id}`,
    );
  }
}

/** Opens the Job-level `replan_cap_reached` Blocker Approval holding the request. */
function openReplanCapItem(
  tx: Tx,
  state: JobState,
  input: { requestId: string; actor: string; replansUsed: number; maxReplans: number },
): string {
  const options = blockerOptions('replan_cap_reached');
  if (options === undefined) throw new Error('replan_cap_reached has no options');
  const execution = latestStageRun(state, 'execution');
  const id = newId('apr');
  const kind: ApprovalKind = 'blocker';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: state.job.id,
      taskId: null,
      stageRunId: execution?.id ?? null,
      kind,
      subjectRef: input.requestId,
      question: 'The Job reached its Replan cap',
      questionsJson: null,
      why: `A Replan was asked for, but the Job has used ${String(input.replansUsed)} of ${String(input.maxReplans)} Replans (maxReplans). Grant one more to start it, or cancel the Job. Execution goes on meanwhile.`,
      optionsJson: JSON.stringify(options),
      recommended: null,
      evidenceJson: JSON.stringify([input.requestId]),
      state: 'open',
      deferred: false,
      requestedBy: input.actor,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId: state.job.id,
    type: 'approval.opened',
    actor: input.actor,
    payload: {
      kind,
      subjectRef: input.requestId,
      taskId: null,
      stageRunId: execution?.id ?? null,
      blocker: 'replan_cap_reached',
    },
  });
  return id;
}

function requireLatest(state: JobState, stageId: string): StageRunRow {
  const run = latestStageRun(state, stageId);
  if (run === undefined) throw new Error(`Job ${state.job.id} has no ${stageId} Stage Run`);
  return run;
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
  const row = tx.select().from(schema.stageRuns).where(eq(schema.stageRuns.id, id)).get();
  if (row === undefined) throw new Error(`no Stage Run ${id}`);
  return row;
}
