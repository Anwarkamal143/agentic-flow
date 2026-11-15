/**
 * The `merge_approval` and `merge` Stages (#58, ADR-0037), and the writes of
 * the GitHub poller. Everything here runs inside the caller's transaction.
 *
 * - When `pull_request` succeeds, `merge_approval` goes `waiting_human` with
 *   a human Blocker `awaiting_merge` and opens one `merge` item per PR
 *   `(head_sha, base_sha)`. Under `never_auto` it says "merge on GitHub" and
 *   offers only `cancel_job` (`request_changes` is #60's).
 * - The poller records what it saw of a PR only when it changed: the
 *   `pull_requests` row, its `pr_checks`, and an event, in one transaction.
 *   A new head or base supersedes the open `merge` item and opens one for the
 *   new SHAs. The Merge Gate is evaluated from the persisted rows and stored
 *   when it changed; a settled checks condition becomes `ci` Evidence.
 * - A merge seen on GitHub decides the `merge` item as `system:github-poller`;
 *   once every PR of the Job is merged, `merge_approval` succeeds, `merge`
 *   records the merge SHA, and closure is queued.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CheckOutcomeSchema,
  CheckSourceSchema,
  evaluateMergeGate,
  MergeGateSchema,
  PullRequestStateSchema,
  InboxDecisionSchema,
  integrationBranch,
  MERGED_ON_GITHUB,
  mergeItemSubject,
  NEVER_AUTO_MERGE_OPTIONS,
  RepositoryProfileSchema,
  type ApprovalKind,
  type Blocker,
  type ExpiresPolicy,
  type MergeGate,
  type ObservedCheck,
  type PullRequestState,
} from '@factory/domain';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JobState, StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { latestStageRun } from './replan.js';

/** The actor of everything the poller writes, and of a `merge` item closed by a merge on GitHub. */
export const POLLER = 'system:github-poller';

type PullRequestRow = typeof schema.pullRequests.$inferSelect;
type StageRunRow = JobState['stageRuns'][number];

/** Steps `run` and returns it as it now is, so it can be stepped again in the same transaction. */
function stepAndReread(
  tx: Tx,
  step: StageRunStepper,
  run: StageRunRow,
  to: Parameters<StageRunStepper>[1],
  opts?: Parameters<StageRunStepper>[2],
): StageRunRow {
  step(run, to, opts);
  const fresh = tx.select().from(schema.stageRuns).where(eq(schema.stageRuns.id, run.id)).get();
  if (fresh === undefined) throw new Error(`Stage Run ${run.id} vanished`);
  return fresh;
}

/** The passed Attempt of a Task: the head its review approved. */
function approvedAttemptOf(tx: Tx | FactoryDb, taskId: string) {
  const attempt = tx
    .select()
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, taskId), eq(schema.attempts.state, 'passed')))
    .orderBy(desc(schema.attempts.n))
    .get();
  if (attempt?.headSha == null) throw new Error(`Task ${taskId} has no passed Attempt`);
  return { ...attempt, headSha: attempt.headSha };
}

function pullRequestsOfJob(tx: Tx | FactoryDb, jobId: string): PullRequestRow[] {
  return tx
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.jobId, jobId))
    .orderBy(asc(sql`"pull_requests"."rowid"`))
    .all();
}

const label = (pr: PullRequestRow) => `${pr.owner}/${pr.name}#${String(pr.number)}`;

/**
 * `pull_request` succeeded: `merge_approval` waits for the human merge, with
 * one `merge` item per PR. `false` when the Job has no `merge_approval` (a
 * `feature` v5 Job, or no PR to merge): the caller queues closure.
 */
export function openMergeApproval(tx: Tx, state: JobState, step: StageRunStepper): boolean {
  const run = latestStageRun(state, 'merge_approval');
  if (run?.state !== 'pending') return false;
  const prs = pullRequestsOfJob(tx, state.job.id).filter((pr) => pr.state === 'open');
  const [first] = prs;
  if (first === undefined) {
    skipMergeStages(state, step, 'no open pull request to merge');
    return false;
  }
  const queued = stepAndReread(tx, step, run, 'queued', { reason: 'the pull request is open' });
  const running = stepAndReread(tx, step, queued, 'running');
  const blocker: Blocker = {
    kind: 'human',
    reason: 'awaiting_merge',
    detail: `pull request ${prs.map((pr) => `${label(pr)} (${pr.url})`).join(', ')} awaits a human merge on GitHub: the Merge Policy is never_auto, so the factory never merges`,
    requiredAction:
      'merge it on GitHub once the Merge Gate shows its other conditions passing; the factory sees the merge by polling and completes the Job',
    taskId: first.taskId,
    attemptId: approvedAttemptOf(tx, first.taskId).id,
    createdAt: new Date().toISOString(),
  };
  step(running, 'waiting_human', { blocker });
  for (const pr of prs) openMergeItem(tx, state.job.id, running.id, pr, ACTOR_OPENING);
  return true;
}

/** `pull_request` runs in the Task scheduler: it is the actor that opens the first item. */
const ACTOR_OPENING = 'system:scheduler';

/** Skips a pending `merge_approval` and `merge`: there is no PR to merge (no GitHub remote, or it failed). */
export function skipMergeStages(state: JobState, step: StageRunStepper, reason: string): void {
  for (const stageId of ['merge_approval', 'merge'] as const) {
    const run = latestStageRun(state, stageId);
    if (run?.state === 'pending') step(run, 'skipped', { reason });
  }
}

function openMergeItem(
  tx: Tx,
  jobId: string,
  stageRunId: string,
  pr: Pick<
    PullRequestRow,
    'id' | 'owner' | 'name' | 'number' | 'url' | 'taskId' | 'headSha' | 'baseSha'
  >,
  actor: string,
): void {
  const id = newId('apr');
  const kind: ApprovalKind = 'merge';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  const subjectRef = mergeItemSubject(pr.id, pr.headSha, pr.baseSha);
  tx.insert(schema.approvals)
    .values({
      id,
      jobId,
      taskId: pr.taskId,
      stageRunId,
      kind,
      subjectRef,
      question: `Merge pull request ${pr.owner}/${pr.name}#${String(pr.number)} on GitHub`,
      why: `The Merge Policy is never_auto: the factory never merges. Merge ${pr.url} on GitHub when you are ready (the Job shows the Merge Gate: checks, reviews, mergeability). The factory sees the merge by polling, closes this item and completes the Job. Head ${pr.headSha}, base ${pr.baseSha}; a new head or base replaces this item.`,
      questionsJson: null,
      optionsJson: JSON.stringify(NEVER_AUTO_MERGE_OPTIONS),
      recommended: null,
      evidenceJson: '[]',
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
    payload: { kind, subjectRef, taskId: pr.taskId, stageRunId, pullRequestId: pr.id },
  });
}

function openMergeItemsOf(tx: Tx, pr: PullRequestRow) {
  return tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, pr.jobId),
        eq(schema.approvals.kind, 'merge'),
        eq(schema.approvals.state, 'open'),
        sql`instr(${schema.approvals.subjectRef}, ${`${pr.id}@`}) = 1`,
      ),
    )
    .all();
}

function closeItem(
  tx: Tx,
  row: typeof schema.approvals.$inferSelect,
  values: Partial<typeof schema.approvals.$inferInsert>,
  event: { type: string; payload: Record<string, unknown> },
): void {
  const updated = tx
    .update(schema.approvals)
    .set({ ...values, version: sql`${schema.approvals.version} + 1` })
    .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.version, row.version)))
    .run();
  if (updated.changes !== 1) throw new Error(`Inbox Item ${row.id} changed under the poller`);
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: row.id,
    jobId: row.jobId,
    type: event.type,
    actor: POLLER,
    payload: { kind: row.kind, subjectRef: row.subjectRef, ...event.payload },
  });
}

// ---- the poller's writes -------------------------------------------------------------------

/** What the poller read of one PR in one poll. */
export interface Observation {
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  baseSha: string;
  mergeableState: string | null;
  mergeSha: string | null;
  checks: ObservedCheck[];
  changesRequestedBy: string[];
}

/** The PRs the poller watches: open, of a Job whose `merge_approval` waits for the merge. */
export function trackedPullRequests(db: FactoryDb): PullRequestRow[] {
  return db
    .select({ pr: schema.pullRequests })
    .from(schema.pullRequests)
    .innerJoin(
      schema.stageRuns,
      and(
        eq(schema.stageRuns.jobId, schema.pullRequests.jobId),
        eq(schema.stageRuns.stageId, 'merge_approval'),
        eq(schema.stageRuns.state, 'waiting_human'),
      ),
    )
    .where(eq(schema.pullRequests.state, 'open'))
    .orderBy(asc(sql`"pull_requests"."rowid"`))
    .all()
    .map((r) => r.pr);
}

function recordedChecks(tx: Tx | FactoryDb, pr: PullRequestRow): ObservedCheck[] {
  return tx
    .select()
    .from(schema.prChecks)
    .where(and(eq(schema.prChecks.pullRequestId, pr.id), eq(schema.prChecks.headSha, pr.headSha)))
    .orderBy(asc(schema.prChecks.source), asc(schema.prChecks.name))
    .all()
    .map((c) => ({
      source: CheckSourceSchema.parse(c.source),
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      outcome: CheckOutcomeSchema.parse(c.outcome),
      url: c.url,
    }));
}

/** A row's `state` as the gate and the poller read it. */
function stateOf(pr: PullRequestRow): PullRequestState {
  return PullRequestStateSchema.parse(pr.state);
}

/** The GitHub users with an unresolved change request, as the row holds them. */
function changesRequestedOf(pr: PullRequestRow): string[] {
  return z.array(z.string()).parse(JSON.parse(pr.changesRequestedJson));
}

/** The observed facts that matter, as the row and `pr_checks` hold them. */
function recordedObservation(tx: Tx | FactoryDb, pr: PullRequestRow): Observation {
  return {
    state: stateOf(pr),
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    mergeableState: pr.mergeableState,
    mergeSha: pr.mergeSha,
    checks: recordedChecks(tx, pr),
    changesRequestedBy: changesRequestedOf(pr),
  };
}

/** The Merge Gate over the persisted rows (and `now`, for the grace window). */
export function gateOf(
  tx: Tx | FactoryDb,
  pr: PullRequestRow,
  checks: readonly ObservedCheck[],
  opts: { now: string; graceMs: number },
): MergeGate {
  const repo = tx
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, pr.repositoryId))
    .get();
  if (repo === undefined) throw new Error(`no Repository ${pr.repositoryId}`);
  const profile = RepositoryProfileSchema.parse(JSON.parse(repo.profileJson));
  const attempt = approvedAttemptOf(tx, pr.taskId);
  const blocking = tx
    .select({ n: sql<number>`count(*)` })
    .from(schema.reviewFindings)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewFindings.reviewId))
    .where(
      and(
        eq(schema.reviews.attemptId, attempt.id),
        eq(schema.reviews.headSha, attempt.headSha),
        eq(schema.reviews.baseSha, attempt.baseSha),
        eq(schema.reviewFindings.blocking, true),
      ),
    )
    .get();
  return evaluateMergeGate({
    pr: {
      owner: pr.owner,
      name: pr.name,
      state: stateOf(pr),
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      mergeableState: pr.mergeableState,
      headSeenAt: pr.headSeenAt ?? pr.createdAt,
    },
    expected: {
      owner: repo.githubOwner ?? '',
      name: repo.githubName ?? '',
      baseBranch: repo.defaultBranch,
      headBranch: integrationBranch(pr.jobId),
    },
    reviewedHeadSha: attempt.headSha,
    checks,
    requiredChecks: profile.requiredChecks ?? [],
    graceMs: opts.graceMs,
    now: opts.now,
    blockingFindings: blocking?.n ?? 0,
    changesRequestedBy: changesRequestedOf(pr),
    policy: 'never_auto',
  });
}

/** What a poll would change, worked out from the rows without writing anything. */
export interface PollAssessment {
  /** The observed facts that differ from the rows (`state`, `head`, `checks`, …). */
  changes: string[];
  headMoved: boolean;
  baseMoved: boolean;
  checksChanged: boolean;
  /** The Merge Gate over the rows as they would be, and whether it differs from the stored one. */
  gate: MergeGate;
  stored: MergeGate | null;
  gateChanged: boolean;
}

/** Compares a poll with the rows (read-only): nothing to write when `changes` is empty and the gate is unchanged. */
export function assessPoll(
  tx: Tx | FactoryDb,
  before: PullRequestRow,
  seen: Observation,
  opts: { now: string; graceMs: number },
): PollAssessment {
  const recorded = recordedObservation(tx, before);
  const headMoved = seen.headSha !== before.headSha;
  const baseMoved = seen.baseSha !== before.baseSha;
  const changes: string[] = [];
  if (seen.state !== recorded.state) changes.push('state');
  if (headMoved) changes.push('head');
  if (baseMoved) changes.push('base');
  if (seen.mergeableState !== recorded.mergeableState) changes.push('mergeable_state');
  if (seen.mergeSha !== recorded.mergeSha) changes.push('merge_sha');
  if (JSON.stringify(seen.changesRequestedBy) !== JSON.stringify(recorded.changesRequestedBy)) {
    changes.push('reviews');
  }
  // Checks are compared on the same head only: a new head starts with its own.
  const checksChanged = headMoved
    ? seen.checks.length > 0
    : JSON.stringify(seen.checks) !== JSON.stringify(recorded.checks);
  if (checksChanged) changes.push('checks');
  const would: PullRequestRow = {
    ...before,
    state: seen.state,
    headSha: seen.headSha,
    baseSha: seen.baseSha,
    mergeableState: seen.mergeableState,
    mergeSha: seen.mergeSha,
    changesRequestedJson: JSON.stringify(seen.changesRequestedBy),
    headSeenAt: headMoved ? opts.now : before.headSeenAt,
  };
  const gate = gateOf(tx, would, seen.checks, opts);
  const stored =
    before.gateJson === null ? null : MergeGateSchema.parse(JSON.parse(before.gateJson));
  const gateChanged = headMoved || baseMoved || JSON.stringify(stored) !== JSON.stringify(gate);
  return { changes, headMoved, baseMoved, checksChanged, gate, stored, gateChanged };
}

/**
 * Records one poll of `prId` that changed something ({@link assessPoll}), in
 * the caller's versioned Job transaction: the row, its checks, the gate and
 * their events together; the `merge` item follows a new head or base; a merge
 * completes `merge_approval` and `merge`. Returns the gate.
 */
export function recordPoll(
  tx: Tx,
  prId: string,
  seen: Observation,
  opts: { now: string; graceMs: number },
  step: StageRunStepper,
  state: JobState,
): MergeGate {
  const before = tx
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, prId))
    .get();
  if (before === undefined) throw new Error(`no pull request ${prId}`);
  const { changes, headMoved, baseMoved, checksChanged, gate, stored, gateChanged } = assessPoll(
    tx,
    before,
    seen,
    opts,
  );
  if (changes.length > 0) {
    const updated = tx
      .update(schema.pullRequests)
      .set({
        state: seen.state,
        headSha: seen.headSha,
        baseSha: seen.baseSha,
        mergeableState: seen.mergeableState,
        mergeSha: seen.mergeSha,
        changesRequestedJson: JSON.stringify(seen.changesRequestedBy),
        ...(headMoved ? { headSeenAt: opts.now } : {}),
        version: sql`${schema.pullRequests.version} + 1`,
      })
      .where(and(eq(schema.pullRequests.id, prId), eq(schema.pullRequests.version, before.version)))
      .run();
    if (updated.changes !== 1) throw new Error(`pull request ${prId} changed under the poller`);
    if (checksChanged) writeChecks(tx, prId, seen, opts.now);
    appendEvent(tx, {
      entityKind: 'pull_request',
      entityId: prId,
      jobId: before.jobId,
      type: 'pull_request.observed',
      actor: POLLER,
      payload: {
        changes,
        state: seen.state,
        headSha: seen.headSha,
        baseSha: seen.baseSha,
        mergeableState: seen.mergeableState,
        mergeSha: seen.mergeSha,
        checks: seen.checks.map((c) => ({ name: c.name, outcome: c.outcome })),
        changesRequestedBy: seen.changesRequestedBy,
      },
    });
  }
  const pr = tx.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).get();
  if (pr === undefined) throw new Error(`no pull request ${prId}`);
  if (gateChanged) {
    tx.update(schema.pullRequests)
      .set({ gateJson: JSON.stringify(gate), gateEvaluatedAt: opts.now })
      .where(eq(schema.pullRequests.id, prId))
      .run();
    appendEvent(tx, {
      entityKind: 'pull_request',
      entityId: prId,
      jobId: pr.jobId,
      type: 'merge_gate.evaluated',
      actor: POLLER,
      payload: {
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        verdict: gate.verdict,
        conditions: gate.conditions,
      },
    });
    recordChecksEvidence(tx, pr, gate, headMoved || baseMoved ? null : stored);
  }
  tx.update(schema.pullRequests)
    .set({ lastPolledAt: opts.now })
    .where(eq(schema.pullRequests.id, prId))
    .run();

  if ((headMoved || baseMoved) && seen.state === 'open') {
    for (const item of openMergeItemsOf(tx, before)) {
      closeItem(
        tx,
        item,
        { state: 'superseded' },
        {
          type: 'approval.superseded',
          payload: { reason: 'the pull request head or base changed', headSha: pr.headSha },
        },
      );
    }
    const holder = latestStageRun(state, 'merge_approval');
    if (holder?.state === 'waiting_human') openMergeItem(tx, pr.jobId, holder.id, pr, POLLER);
  }
  if (seen.state === 'merged' && before.state !== 'merged')
    completeMerge(tx, pr, state, step, opts.now);
  return gate;
}

function writeChecks(tx: Tx, prId: string, seen: Observation, now: string): void {
  for (const c of seen.checks) {
    tx.insert(schema.prChecks)
      .values({
        id: newId('chk'),
        pullRequestId: prId,
        headSha: seen.headSha,
        source: c.source,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        outcome: c.outcome,
        url: c.url,
        observedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.prChecks.pullRequestId,
          schema.prChecks.headSha,
          schema.prChecks.source,
          schema.prChecks.name,
        ],
        set: {
          status: c.status,
          conclusion: c.conclusion,
          outcome: c.outcome,
          url: c.url,
          observedAt: now,
        },
      })
      .run();
  }
  // A check no longer reported on this head (rare: GitHub keeps them) is dropped from it.
  const names = new Set(seen.checks.map((c) => `${c.source}:${c.name}`));
  for (const row of tx
    .select()
    .from(schema.prChecks)
    .where(and(eq(schema.prChecks.pullRequestId, prId), eq(schema.prChecks.headSha, seen.headSha)))
    .all()) {
    if (!names.has(`${row.source}:${row.name}`)) {
      tx.delete(schema.prChecks).where(eq(schema.prChecks.id, row.id)).run();
    }
  }
}

/**
 * The checks condition settled (pass or fail) on a `(head, base)`: it becomes
 * `ci` Evidence on the Integration Task's approved Attempt, tied to the PR's
 * SHAs, so it goes stale with them.
 */
function recordChecksEvidence(
  tx: Tx,
  pr: PullRequestRow,
  gate: MergeGate,
  /** The gate stored before, on the same SHAs; `null` when there was none or the SHAs moved. */
  stored: MergeGate | null,
): void {
  const now = gate.conditions.find((c) => c.id === 'checks');
  const was = stored?.conditions.find((c) => c.id === 'checks');
  if (now === undefined || now.status === 'pending') return;
  if (was?.status === now.status && was.reason === now.reason) return;
  const attempt = approvedAttemptOf(tx, pr.taskId);
  tx.insert(schema.evidence)
    .values({
      id: newId('evd'),
      attemptId: attempt.id,
      kind: 'ci',
      verificationRunId: null,
      criterionId: null,
      verdict: now.status,
      detail: `GitHub checks on ${pr.owner}/${pr.name}#${String(pr.number)}: ${now.reason}`,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      artifactId: null,
      reviewId: null,
    })
    .run();
}

/**
 * A merge seen on GitHub: the PR's open `merge` item is decided by the
 * poller; once every PR of the Job is merged, `merge_approval` succeeds,
 * `merge` records the merge SHA, and closure is queued.
 */
function completeMerge(
  tx: Tx,
  pr: PullRequestRow,
  state: JobState,
  step: StageRunStepper,
  now: string,
): void {
  const decision = InboxDecisionSchema.parse({ option: MERGED_ON_GITHUB, comment: null });
  for (const item of openMergeItemsOf(tx, pr)) {
    closeItem(
      tx,
      item,
      {
        state: 'decided',
        decidedBy: POLLER,
        decidedAt: now,
        decisionJson: JSON.stringify(decision),
      },
      { type: 'approval.decided', payload: { ...decision, mergeSha: pr.mergeSha } },
    );
  }
  const all = pullRequestsOfJob(tx, pr.jobId);
  if (!all.every((p) => p.state === 'merged')) return;
  const approval = latestStageRun(state, 'merge_approval');
  if (approval?.state !== 'waiting_human') return;
  const mergeShas = all.map((p) => ({ pullRequest: label(p), mergeSha: p.mergeSha }));
  stepAndReread(tx, step, approval, 'succeeded', { reason: 'merged on GitHub' });
  const merge = latestStageRun(state, 'merge');
  if (merge?.state === 'pending') {
    const queued = stepAndReread(tx, step, merge, 'queued');
    const running = stepAndReread(tx, step, queued, 'running');
    step(running, 'succeeded', {
      reason: 'merged on GitHub by a human (never_auto)',
      detail: { mergeSha: all.length === 1 ? pr.mergeSha : null, mergeShas },
    });
  }
  const closure = latestStageRun(state, 'closure');
  if (closure?.state === 'pending') step(closure, 'queued');
}
