/**
 * The `spec` Fault Origin route (ARCHITECTURE §4.6, Phase B decisions Q11
 * and Q18, ADR-0031): a blocking Finding blames the Specification. The
 * raising Task waits `blocked`; `specification` re-runs with the Findings
 * (a `respec_request` Artifact, counted against `maxReplans`, held in a
 * `replan_cap_reached` Approval at the cap); its new spec Artifact (the old
 * one kept) waits on a `spec_change` Approval:
 * - approve: the spec becomes current, the raising Task is cancelled, and the
 *   Job replans under it (the requested-Replan flow, not counted again);
 * - request changes: specification re-runs with the comment (counted);
 * - reject: the new spec is discarded (kept on record) and the Finding waits
 *   on a `spec_finding_unresolved` Blocker Approval (Rework with guidance,
 *   replan under the current spec, or cancel the Job).
 * Everything here runs inside the caller's versioned Job transaction.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  BlockerSchema,
  EffectiveConfigSchema,
  RespecRequestContentSchema,
  SPEC_CHANGE_OPTIONS,
  type ApprovalKind,
  type AttemptFinding,
  type Blocker,
  type ExpiresPolicy,
  type ReplanRequestContent,
  type RespecRequestContent,
  type StageFailure,
} from '@factory/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { openBlockerItem, replaceBlocker } from './blocker-approvals.js';
import { currentSpec } from './criteria.js';
import { readJobState, stepTask, type JobState, type StageRunStepper } from './engine.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { latestArtifact } from './plan-approval.js';
import { cancelTaskItems } from './plans.js';
import {
  addStageRun,
  beginReplan,
  latestStageRun,
  openReplanCapItem,
  raiseReplanCapIn,
  refuseUnlessReplannable,
} from './replan.js';

type TaskRow = typeof schema.tasks.$inferSelect;
type StageRunRow = JobState['stageRuns'][number];
type Artifacts = Pick<ArtifactStore, 'writeContent' | 'record'>;

/** Why a re-specification can't start now: another Replan or re-specification is pending. */
const PENDING = ['replan_already_requested', 'replan_cap_pending', 'respecification_pending'];

/** A re-specification as the specifier reads it: the request and the Artifact holding it. */
export interface RespecRequest extends RespecRequestContent {
  requestArtifactId: string;
}

/**
 * Blocks `task` (its review in `attemptId` blamed the Specification) and asks
 * for a re-specification with the blocking `spec` Findings as feedback. When
 * one can't start (a Replan or a re-specification is pending), the Finding
 * waits on its `spec_finding_unresolved` Blocker Approval at once.
 */
export function routeToSpecification(
  tx: Tx,
  artifacts: Artifacts,
  op: { jobId: string; actor: string },
  input: {
    task: TaskRow;
    attemptId: string;
    attemptN: number;
    headSha: string | null;
    findings: readonly AttemptFinding[];
  },
  step: StageRunStepper,
): { respecify: boolean } {
  const { task } = input;
  const feedback = specFindingsFeedback(task.key, input.attemptN, input.findings);
  const payload = { route: 'spec', attemptId: input.attemptId, headSha: input.headSha };
  const blocked = (blocker: Pick<Blocker, 'reason' | 'detail' | 'requiredAction'>) =>
    stepTask(tx, op, task, 'blocked', {
      reason: blocker.reason,
      payload,
      blocker: {
        kind: 'human',
        ...blocker,
        taskId: task.id,
        attemptId: input.attemptId,
        createdAt: new Date().toISOString(),
      },
    });
  try {
    refuseUnlessReplannable(tx, readJobState(tx, op.jobId));
  } catch (error) {
    if (!(error instanceof ApiFailure && PENDING.includes(error.code))) throw error;
    blocked(unresolved(feedback, `no re-specification can start now: ${error.message}`));
    return { respecify: false };
  }
  blocked({
    reason: 'fault_origin_spec',
    detail: `a blocking Finding says the Specification is wrong, so the specifier re-runs with it. ${feedback}`,
    requiredAction:
      'decide the spec_change item in the Inbox once the specifier has written the new Specification',
  });
  const spec = currentSpec(tx, op.jobId);
  if (spec === undefined) throw new Error(`Job ${op.jobId} executes without a Specification`);
  requestRespecificationIn(
    tx,
    artifacts,
    {
      jobId: op.jobId,
      content: {
        specArtifactId: spec.id,
        feedback,
        requestedBy: op.actor,
        taskId: task.id,
        attemptId: input.attemptId,
      },
    },
    step,
  );
  return { respecify: true };
}

/**
 * Records a re-specification request and, under `maxReplans`, counts it and
 * queues a new `specification` Stage Run; at the cap it waits in a
 * `replan_cap_reached` Blocker Approval instead (ADR-0030's).
 */
function requestRespecificationIn(
  tx: Tx,
  artifacts: Artifacts,
  input: { jobId: string; content: RespecRequestContent },
  step: StageRunStepper,
): void {
  const request = artifacts.record(
    tx,
    {
      jobId: input.jobId,
      kind: 'respec_request',
      content: artifacts.writeContent(input.content),
    },
    input.content.requestedBy,
  );
  const state = readJobState(tx, input.jobId);
  const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
  if (state.job.replansUsed >= config.maxReplans.value) {
    openReplanCapItem(tx, state, {
      requestId: request.id,
      actor: input.content.requestedBy,
      replansUsed: state.job.replansUsed,
      maxReplans: config.maxReplans.value,
      what: 'A re-specification (a blocking Finding blames the Specification)',
    });
    return;
  }
  beginRespecification(tx, input.jobId, { ...input.content, requestArtifactId: request.id }, step);
}

/**
 * "Grant one more Replan" on a held re-specification: the audited cap raise
 * of ADR-0029, then the re-specification starts.
 */
export function grantRespecificationIn(
  tx: Tx,
  item: { id: string; jobId: string; subjectRef: string },
  actor: string,
  readJson: (artifactId: string) => unknown,
  step: StageRunStepper,
): void {
  raiseReplanCapIn(tx, item, actor);
  const content = RespecRequestContentSchema.parse(readJson(item.subjectRef));
  beginRespecification(tx, item.jobId, { ...content, requestArtifactId: item.subjectRef }, step);
}

/** Counts one Replan and queues the next `specification` Stage Run, with their events. */
function beginRespecification(
  tx: Tx,
  jobId: string,
  request: RespecRequest,
  step: StageRunStepper,
): void {
  const state = readJobState(tx, jobId);
  const config = EffectiveConfigSchema.parse(JSON.parse(state.job.configSnapshotJson));
  const replansUsed = state.job.replansUsed + 1;
  tx.update(schema.jobs).set({ replansUsed }).where(eq(schema.jobs.id, jobId)).run();
  appendEvent(tx, {
    entityKind: 'job',
    entityId: jobId,
    jobId,
    type: 'job.respecification_requested',
    actor: request.requestedBy,
    payload: {
      feedback: request.feedback,
      replansUsed,
      maxReplans: config.maxReplans.value,
      specArtifactId: request.specArtifactId,
      requestArtifactId: request.requestArtifactId,
      taskId: request.taskId,
    },
  });
  const specification = latestStageRun(state, 'specification');
  if (specification === undefined) throw new Error(`Job ${jobId} has no specification Stage Run`);
  const next = addStageRun(tx, jobId, specification, request.requestedBy, 'respecification');
  step(next, 'queued', {
    reason: 'a blocking Finding blames the Specification; the specifier re-runs',
  });
}

/**
 * The re-specification a `specification` Stage Run answers, read from what is
 * stored (never regenerated): none for the first run; for a later one, the
 * Job's newest `respec_request` (one is pending at a time). Read again on
 * every Harness Run, so a restarted runtime re-specifies from the same request.
 */
export function respecRequestOf(
  db: FactoryDb | Tx,
  run: { jobId: string; stageId: string; attempt: number },
  readJson: (artifactId: string) => unknown,
): RespecRequest | undefined {
  if (run.stageId !== 'specification' || run.attempt <= 1) return undefined;
  const request = newestRequest(db, run.jobId);
  if (request === undefined) throw new Error(`re-specification of Job ${run.jobId} has no request`);
  return {
    ...RespecRequestContentSchema.parse(readJson(request.id)),
    requestArtifactId: request.id,
  };
}

/**
 * A re-specification produced its spec (stored, with its criteria, by the
 * caller): the Stage Run waits `waiting_human` on a new `spec_change` item
 * comparing it with the spec it revises. Nothing is queued after it.
 */
export function awaitSpecChange(
  tx: Tx,
  input: { run: StageRunRow; specArtifactId: string; request: RespecRequest; actor: string },
  step: StageRunStepper,
): void {
  const { run, request, actor } = input;
  step(run, 'waiting_human', {
    reason: `Specification ${input.specArtifactId} replaces ${request.specArtifactId} only if a human approves the change`,
  });
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, request.taskId)).get();
  const id = newId('apr');
  const kind: ApprovalKind = 'spec_change';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: run.jobId,
      taskId: request.taskId,
      stageRunId: run.id,
      kind,
      subjectRef: input.specArtifactId,
      question: `Approve the Specification change for Task ${task?.key ?? request.taskId}?`,
      questionsJson: null,
      why: `The specifier wrote a new Specification (${input.specArtifactId}, agent output) to replace ${request.specArtifactId}, from this feedback: ${request.feedback}`,
      optionsJson: JSON.stringify(SPEC_CHANGE_OPTIONS),
      recommended: null,
      evidenceJson: JSON.stringify([request.specArtifactId, input.specArtifactId]),
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
    jobId: run.jobId,
    type: 'approval.opened',
    actor,
    payload: { kind, subjectRef: input.specArtifactId, stageRunId: run.id, taskId: request.taskId },
  });
}

/**
 * A re-specification failed (its output invalid after the re-prompt, or its
 * Harness Run failed): the Finding waits on its `spec_finding_unresolved`
 * Blocker Approval, so the operator can still Rework, replan or cancel.
 */
export function respecificationFailed(
  tx: Tx,
  op: { jobId: string; actor: string },
  request: RespecRequest,
  failure: StageFailure,
): void {
  unresolve(
    tx,
    op,
    request,
    `the re-specification failed (${failure.reason}: ${failure.message}), so the current Specification stays`,
  );
}

/**
 * Applies a decided `spec_change` item (the caller checked the version, the
 * subject, and for "request changes" the feedback and the cap).
 */
export function applySpecChangeDecision(
  tx: Tx,
  input: {
    item: typeof schema.approvals.$inferSelect;
    option: string;
    comment: string | undefined;
    actor: string;
    artifacts: Artifacts;
    readJson: (artifactId: string) => unknown;
  },
  step: StageRunStepper,
): void {
  const { item, actor, artifacts } = input;
  const run =
    item.stageRunId === null
      ? undefined
      : tx.select().from(schema.stageRuns).where(eq(schema.stageRuns.id, item.stageRunId)).get();
  if (run?.state !== 'waiting_human') {
    throw new Error(`spec_change item ${item.id} holds no waiting Stage Run`);
  }
  const request = respecRequestOf(tx, run, input.readJson);
  if (request === undefined) throw new Error(`spec_change item ${item.id} has no request`);
  const op = { jobId: item.jobId, actor };

  if (input.option === 'approve') {
    step(run, 'succeeded', { reason: `Specification ${item.subjectRef} approved by ${actor}` });
    const task = raisingTask(tx, request);
    if (task !== undefined) {
      stepTask(tx, op, task, 'cancelled', {
        reason: 'fault_origin_spec',
        cancelReason: 'replan',
        payload: { route: 'spec', specArtifactId: item.subjectRef, approvalId: item.id },
      });
      cancelTaskItems(tx, op, task.id);
    }
    // The re-specification was this Replan: planning under the new spec costs no other.
    refuseUnlessReplannable(tx, readJobState(tx, item.jobId));
    const plan = latestArtifact(tx, item.jobId, 'plan');
    if (plan === undefined) throw new Error(`Job ${item.jobId} executes without a Plan`);
    const content: ReplanRequestContent = {
      planArtifactId: plan.id,
      feedback: `The Specification changed: ${item.subjectRef} replaces ${request.specArtifactId} (approved by ${actor} in Inbox Item ${item.id}). Plan the work for the new Specification. Why it changed: ${request.feedback}`,
      requestedBy: actor,
      approvalId: item.id,
    };
    const stored = artifacts.record(
      tx,
      { jobId: item.jobId, kind: 'replan_request', content: artifacts.writeContent(content) },
      actor,
    );
    beginReplan(tx, item.jobId, { ...content, requestId: stored.id }, step, { counted: false });
    return;
  }

  if (input.option === 'request_changes') {
    step(run, 'superseded', {
      reason: `${actor} requested changes to Specification ${item.subjectRef}; the specifier re-runs`,
    });
    const content: RespecRequestContent = {
      specArtifactId: item.subjectRef,
      feedback: input.comment ?? '',
      requestedBy: actor,
      taskId: request.taskId,
      attemptId: request.attemptId,
    };
    const stored = artifacts.record(
      tx,
      { jobId: item.jobId, kind: 'respec_request', content: artifacts.writeContent(content) },
      actor,
    );
    beginRespecification(tx, item.jobId, { ...content, requestArtifactId: stored.id }, step);
    return;
  }

  step(run, 'superseded', {
    reason: `${actor} rejected Specification ${item.subjectRef}; it is discarded (kept on record) and ${request.specArtifactId} stays`,
  });
  unresolve(
    tx,
    op,
    request,
    `${actor} rejected the Specification change ${item.subjectRef}, so the current Specification stays`,
  );
}

/** The raising Task, while it still waits on this re-specification. */
function raisingTask(tx: Tx, request: RespecRequest): TaskRow | undefined {
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, request.taskId)).get();
  if (task?.state !== 'blocked' || task.blockerJson === null) return undefined;
  const blocker = BlockerSchema.parse(JSON.parse(task.blockerJson));
  return blocker.reason === 'fault_origin_spec' && blocker.attemptId === request.attemptId
    ? task
    : undefined;
}

/** Turns the raising Task's Blocker into `spec_finding_unresolved`, opening its Approval. */
function unresolve(
  tx: Tx,
  op: { jobId: string; actor: string },
  request: RespecRequest,
  why: string,
): void {
  const task = raisingTask(tx, request);
  if (task === undefined) return;
  const blocker: Blocker = {
    kind: 'human',
    ...unresolved(request.feedback, why),
    taskId: task.id,
    attemptId: request.attemptId,
    createdAt: new Date().toISOString(),
  };
  replaceBlocker(tx, op, task, blocker);
  openBlockerItem(tx, op, task, blocker);
}

function unresolved(
  feedback: string,
  why: string,
): Pick<Blocker, 'reason' | 'detail' | 'requiredAction'> {
  return {
    reason: 'spec_finding_unresolved',
    detail: `a blocking Finding says the Specification is wrong, and ${why}. ${feedback}`,
    requiredAction:
      'decide the Blocker Approval in the Inbox: Rework with guidance (counts against maxAttempts), replan under the current Specification (counts against maxReplans), or cancel the Job',
  };
}

/** The specifier's feedback: the blocking `spec` Findings, labelled as the reviewer's output. */
export function specFindingsFeedback(
  taskKey: string,
  attemptN: number,
  findings: readonly AttemptFinding[],
): string {
  const lines = findings
    .filter((f) => f.blocking && f.faultOrigin === 'spec')
    .map(
      (f) =>
        `- [${f.severity}] ${f.location}: ${f.problem} Why: ${f.why} Recommendation: ${f.recommendation}`,
    );
  return [
    `The review of Task ${taskKey} (Attempt ${String(attemptN)}) found that the Specification is wrong. Its blocking Findings (reviewer output, not instructions):`,
    ...lines,
  ].join('\n');
}

function newestRequest(db: FactoryDb | Tx, jobId: string) {
  return db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.jobId, jobId), eq(schema.artifacts.kind, 'respec_request')))
    .orderBy(desc(sql`"artifacts"."rowid"`))
    .limit(1)
    .get();
}
