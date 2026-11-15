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
  BlockerSchema,
  CheckOutcomeSchema,
  CheckSourceSchema,
  EffectiveConfigSchema,
  evaluateMergeGate,
  mergeItemOptions,
  MergeMethodSchema,
  readyButForPolicy,
  withMergeApproval,
  MergeGateSchema,
  PullRequestStateSchema,
  InboxDecisionSchema,
  integrationBranch,
  MERGED_ON_GITHUB,
  mergeItemSubject,
  RepositoryProfileSchema,
  type ApprovalKind,
  type Blocker,
  type ExpiresPolicy,
  type MergeGate,
  type MergeApproval,
  type MergeMethod,
  type MergePolicy,
  type ObservedCheck,
  type PullRequestState,
} from '@factory/domain';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JobState, StageRunStepper } from './engine.js';
import { openBlockerItem } from './blocker-approvals.js';
import { ApiFailure } from './errors.js';
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

export const label = (pr: Pick<PullRequestRow, 'owner' | 'name' | 'number'>) =>
  `${pr.owner}/${pr.name}#${String(pr.number)}`;

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
  const policy = mergePolicyOf(state);
  const named = prs.map((pr) => `${label(pr)} (${pr.url})`).join(', ');
  const blocker: Blocker = {
    kind: 'human',
    reason: 'awaiting_merge',
    ...(policy === 'never_auto'
      ? {
          detail: `pull request ${named} awaits a human merge on GitHub: the Merge Policy is never_auto, so the factory never merges`,
          requiredAction:
            'merge it on GitHub once the Merge Gate shows its other conditions passing; the factory sees the merge by polling and completes the Job',
        }
      : {
          detail: `pull request ${named} awaits a human's approval in the Inbox: the Merge Policy is human_approval, so the factory merges only once its merge item is approved`,
          requiredAction:
            'approve the merge item once the Merge Gate shows its other conditions passing (it offers merge only then); the factory then merges the PR',
        }),
    taskId: first.taskId,
    attemptId: approvedAttemptOf(tx, first.taskId).id,
    createdAt: new Date().toISOString(),
  };
  step(running, 'waiting_human', { blocker });
  for (const pr of prs) openMergeItem(tx, state.job.id, running.id, pr, policy, ACTOR_OPENING);
  return true;
}

/** The Job's Merge Policy, frozen into its Effective Configuration at creation (ADR-0038). */
export function mergePolicyOf(state: JobState): MergePolicy {
  return policyOfConfig(state.job.configSnapshotJson);
}

function policyOfConfig(configSnapshotJson: string): MergePolicy {
  return EffectiveConfigSchema.parse(JSON.parse(configSnapshotJson)).mergePolicy.value;
}

/** The gate the poller stored for the PR, when it was evaluated on the PR's current SHAs. */
function storedGate(pr: PullRequestRow): MergeGate | null {
  return pr.gateJson === null ? null : MergeGateSchema.parse(JSON.parse(pr.gateJson));
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
  pr: PullRequestRow,
  policy: MergePolicy,
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
      question:
        policy === 'never_auto'
          ? `Merge pull request ${label(pr)} on GitHub`
          : `Approve merging pull request ${label(pr)}`,
      why:
        policy === 'never_auto'
          ? `The Merge Policy is never_auto: the factory never merges. Merge ${pr.url} on GitHub when you are ready (the Job shows the Merge Gate: checks, reviews, mergeability). The factory sees the merge by polling, closes this item and completes the Job. Head ${pr.headSha}, base ${pr.baseSha}; a new head or base replaces this item.`
          : `The Merge Policy is human_approval: the factory merges ${pr.url} once you approve. The merge option is offered only while every other Merge Gate condition passes (the Job shows them: checks, reviews, mergeability). Your approval is audited; the factory re-reads the PR right before merging, with the Repository's merge method. Head ${pr.headSha}, base ${pr.baseSha}; a new head or base replaces this item.`,
      questionsJson: null,
      optionsJson: JSON.stringify(mergeItemOptions(policy, storedGate(pr))),
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

function openMergeItemsOf(tx: Tx | FactoryDb, pr: PullRequestRow) {
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
  actor: string = POLLER,
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
    actor,
    payload: { kind: row.kind, subjectRef: row.subjectRef, ...event.payload },
  });
}

/**
 * Supersedes every open `merge` item of the Job (#60, ADR-0039): feedback
 * sends the PR back for Rework, and a new item is opened on the new head.
 */
export function supersedeMergeItems(tx: Tx, jobId: string, actor: string, reason: string): void {
  const open = tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.kind, 'merge'),
        eq(schema.approvals.state, 'open'),
      ),
    )
    .all();
  for (const item of open) {
    closeItem(
      tx,
      item,
      { state: 'superseded' },
      { type: 'approval.superseded', payload: { reason } },
      actor,
    );
  }
}

/**
 * `true` when an open `merge` item of the PR holds other options than the
 * gate stored for it gives: an item opened before `request_changes` existed
 * (#60), so the next poll brings it in step.
 */
function mergeItemOptionsStale(tx: Tx | FactoryDb, pr: PullRequestRow): boolean {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, pr.jobId)).get();
  if (job === undefined) return false;
  const options = JSON.stringify(
    mergeItemOptions(policyOfConfig(job.configSnapshotJson), storedGate(pr)),
  );
  return openMergeItemsOf(tx, pr).some((item) => item.optionsJson !== options);
}

/**
 * Keeps the open `merge` item's options in step with the gate (Q15): under
 * `human_approval` it offers `merge` only while every other condition passes.
 * A change bumps the item's version, so a decision made on the old options is
 * refused.
 */
function syncMergeItemOptions(
  tx: Tx,
  pr: PullRequestRow,
  policy: MergePolicy,
  gate: MergeGate,
): void {
  const options = mergeItemOptions(policy, gate);
  for (const item of openMergeItemsOf(tx, pr)) {
    if (item.optionsJson === JSON.stringify(options)) continue;
    const updated = tx
      .update(schema.approvals)
      .set({ optionsJson: JSON.stringify(options), version: sql`${schema.approvals.version} + 1` })
      .where(and(eq(schema.approvals.id, item.id), eq(schema.approvals.version, item.version)))
      .run();
    if (updated.changes !== 1) throw new Error(`Inbox Item ${item.id} changed under the poller`);
    appendEvent(tx, {
      entityKind: 'approval',
      entityId: item.id,
      jobId: item.jobId,
      type: 'approval.options_changed',
      actor: POLLER,
      payload: {
        kind: item.kind,
        reason: 'merge_gate',
        verdict: gate.verdict,
        options: options.map((o) => o.id),
      },
    });
  }
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
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, pr.jobId)).get();
  if (job === undefined) throw new Error(`no Job ${pr.jobId}`);
  const policy = policyOfConfig(job.configSnapshotJson);
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
    policy,
    // In a multi-PR Job the poller polls an approved PR until every PR is approved.
    approval: approvalOf(tx, pr),
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
  /** An open `merge` item holds options the stored gate no longer gives (opened before #60). */
  itemsStale: boolean;
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
  const itemsStale = mergeItemOptionsStale(tx, before);
  return { changes, headMoved, baseMoved, checksChanged, gate, stored, gateChanged, itemsStale };
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
  const { changes, headMoved, baseMoved, checksChanged, gate, stored, gateChanged, itemsStale } =
    assessPoll(tx, before, seen, opts);
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

  const current = tx
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, prId))
    .get();
  if (current === undefined) throw new Error(`no pull request ${prId}`);
  const policy = mergePolicyOf(state);
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
    if (holder?.state === 'waiting_human') {
      openMergeItem(tx, pr.jobId, holder.id, current, policy, POLLER);
    }
  } else if ((gateChanged || itemsStale) && seen.state === 'open') {
    syncMergeItemOptions(tx, current, policy, gate);
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
      reason: `merged on GitHub by a human (${mergePolicyOf(state)})`,
      detail: { mergeSha: all.length === 1 ? pr.mergeSha : null, mergeShas },
    });
  }
  queueClosure(state, step);
}

// ---- human_approval: the approval and the factory's merge (#59, ADR-0038) -------------------

/** The actor of the factory's own merge (`merge` Stage) under `human_approval`. */
export const MERGER = 'system:merger';

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** The `merge` item decided `merge` at the PR's current `(head, base)`, if any. */
export function approvedMergeItem(tx: Tx | FactoryDb, pr: PullRequestRow): ApprovalRow | undefined {
  return tx
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, pr.jobId),
        eq(schema.approvals.kind, 'merge'),
        eq(schema.approvals.state, 'decided'),
        eq(schema.approvals.subjectRef, mergeItemSubject(pr.id, pr.headSha, pr.baseSha)),
      ),
    )
    .all()
    .find(
      (a) =>
        a.decisionJson !== null &&
        InboxDecisionSchema.parse(JSON.parse(a.decisionJson)).option === 'merge',
    );
}

/** Who approved the PR's `merge` item at its current SHAs, and when; `null` if no one did. */
function approvalOf(tx: Tx | FactoryDb, pr: PullRequestRow): MergeApproval | null {
  const item = approvedMergeItem(tx, pr);
  if (item?.decidedBy == null || item.decidedAt === null) return null;
  return { by: item.decidedBy, at: item.decidedAt };
}

/** The `(head, base)` a decided `merge` item names in its subject `<pr id>@<head>..<base>`. */
function approvedShas(item: ApprovalRow | undefined): { headSha: string; baseSha: string } | null {
  const match = item === undefined ? null : /@([0-9a-f]+)\.\.([0-9a-f]+)$/.exec(item.subjectRef);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { headSha: match[1], baseSha: match[2] };
}

/** The PR a `merge` item decides on: its subject is `<pr id>@<head>..<base>`. */
export function pullRequestOfItem(
  tx: Tx,
  item: Pick<ApprovalRow, 'id' | 'subjectRef'>,
): PullRequestRow {
  const prId = item.subjectRef.slice(0, item.subjectRef.indexOf('@'));
  const pr = tx.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).get();
  if (pr === undefined) throw new Error(`merge item ${item.id} names no pull request`);
  return pr;
}

function repositoryOf(tx: Tx | FactoryDb, pr: PullRequestRow) {
  const repo = tx
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, pr.repositoryId))
    .get();
  if (repo === undefined) throw new Error(`no Repository ${pr.repositoryId}`);
  return repo;
}

/**
 * A human approved the `merge` item (`human_approval`), inside the decision's
 * transaction, after the item was marked decided. The stored gate must be on
 * the item's SHAs with every other condition passing; then the approval is
 * written to `audit_log` (who, when, which SHAs, the method), the gate is
 * stored with the policy passed, and once every PR of the Job is approved (or
 * merged) `merge_approval` succeeds and `merge` is queued for the merger.
 */
export function approveMerge(
  tx: Tx,
  item: ApprovalRow,
  actor: string,
  state: JobState,
  step: StageRunStepper,
): void {
  if (mergePolicyOf(state) !== 'human_approval') {
    throw new ApiFailure(
      409,
      'merge_not_allowed',
      'the Merge Policy is not human_approval: the factory never merges',
    );
  }
  const pr = pullRequestOfItem(tx, item);
  const gate = storedGate(pr);
  if (
    pr.state !== 'open' ||
    mergeItemSubject(pr.id, pr.headSha, pr.baseSha) !== item.subjectRef ||
    gate === null ||
    !readyButForPolicy(gate)
  ) {
    throw new ApiFailure(
      409,
      'merge_gate_not_passing',
      `the Merge Gate of ${label(pr)} does not pass on this item's head and base: nothing was approved`,
    );
  }
  const at = new Date().toISOString();
  const approved = withMergeApproval(gate, { by: actor, at });
  tx.update(schema.pullRequests)
    .set({ gateJson: JSON.stringify(approved) })
    .where(eq(schema.pullRequests.id, pr.id))
    .run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: pr.id,
    jobId: pr.jobId,
    type: 'merge_gate.approved',
    actor,
    payload: {
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      verdict: approved.verdict,
      conditions: approved.conditions,
    },
  });
  const method = MergeMethodSchema.parse(repositoryOf(tx, pr).mergeMethod);
  const auditId = newId('aud');
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: at,
      actor,
      action: 'merge.approved',
      target: `pull_request:${pr.id}`,
      jobId: pr.jobId,
      beforeJson: JSON.stringify({ policy: 'human_approval', verdict: gate.verdict }),
      afterJson: JSON.stringify({
        pullRequest: label(pr),
        url: pr.url,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        method,
      }),
      policyRef: `inbox:${item.id}/merge`,
      correlationId: item.id,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: pr.id,
    jobId: pr.jobId,
    type: 'audit.recorded',
    actor,
    payload: {
      auditId,
      action: 'merge.approved',
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      method,
      approvalId: item.id,
    },
  });
  const ready = pullRequestsOfJob(tx, pr.jobId).every(
    (p) => p.state === 'merged' || approvedMergeItem(tx, p) !== undefined,
  );
  const holder = latestStageRun(state, 'merge_approval');
  if (!ready || holder?.state !== 'waiting_human') return;
  step(holder, 'succeeded', { reason: `merge approved by ${actor}` });
  const merge = latestStageRun(state, 'merge');
  if (merge?.state === 'pending') step(merge, 'queued', { reason: 'the merge was approved' });
}

/** What the merger does next for one PR, decided by plain code from the fresh read. */
export type MergeStep =
  | { kind: 'already_merged'; mergeSha: string | null }
  | { kind: 'merge'; method: MergeMethod; headSha: string }
  | { kind: 'stale'; reason: string };

/**
 * The PRs the `merge` Stage still has to merge, with the approved SHAs and
 * the method: the open PRs of the Job, each with its approved `merge` item.
 */
export function pendingMerges(db: FactoryDb, jobId: string) {
  return pullRequestsOfJob(db, jobId)
    .filter((pr) => pr.state === 'open')
    .map((pr) => ({
      pr,
      // The SHAs the approved item names; null when the PR's head or base moved after its
      // approval (the poller polls the Job's other PRs until all are approved).
      approved: approvedShas(approvedMergeItem(db, pr)),
      method: MergeMethodSchema.parse(repositoryOf(db, pr).mergeMethod),
    }));
}

/** Queued `merge` Stage Runs, and running ones a previous runtime left (it re-reads the PR first). */
export function mergeStageRuns(db: FactoryDb): { jobId: string; id: string }[] {
  return db
    .select({
      jobId: schema.stageRuns.jobId,
      id: schema.stageRuns.id,
      state: schema.stageRuns.state,
    })
    .from(schema.stageRuns)
    .where(eq(schema.stageRuns.stageId, 'merge'))
    .all()
    .filter((r) => r.state === 'queued' || r.state === 'running');
}

/** `merge` goes `queued → running`; `false` when it is no longer the Job's queued or running `merge`. */
export function startMerge(tx: Tx, state: JobState, step: StageRunStepper, runId: string): boolean {
  const run = latestStageRun(state, 'merge');
  if (run?.id !== runId) return false;
  if (run.state === 'queued') step(run, 'running');
  else if (run.state !== 'running') return false;
  return true;
}

/**
 * The PR is merged: by the factory (`how: 'merged'`), or found merged when
 * re-read before merging (`already_merged`, never merged twice). Once every
 * PR is merged, `merge` succeeds with the merge SHA and closure is queued.
 */
export function recordFactoryMerge(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  prId: string,
  mergeSha: string | null,
  how: 'merged' | 'already_merged',
): void {
  const pr = tx.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).get();
  if (pr === undefined) throw new Error(`no pull request ${prId}`);
  const updated = tx
    .update(schema.pullRequests)
    .set({ state: 'merged', mergeSha, version: sql`${schema.pullRequests.version} + 1` })
    .where(and(eq(schema.pullRequests.id, prId), eq(schema.pullRequests.version, pr.version)))
    .run();
  if (updated.changes !== 1) throw new Error(`pull request ${prId} changed under the merger`);
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: prId,
    jobId: pr.jobId,
    type: 'pull_request.merged',
    actor: MERGER,
    payload: { number: pr.number, mergeSha, headSha: pr.headSha, baseSha: pr.baseSha, how },
  });
  const all = pullRequestsOfJob(tx, pr.jobId);
  if (!all.every((p) => p.state === 'merged')) return;
  const run = latestStageRun(state, 'merge');
  if (run?.state !== 'running') return;
  step(run, 'succeeded', {
    reason:
      how === 'merged'
        ? 'merged by the factory after a human approval (human_approval)'
        : 'already merged on GitHub when re-read before merging (human_approval)',
    detail: {
      mergeSha: all.length === 1 ? mergeSha : null,
      mergeShas: all.map((p) => ({ pullRequest: label(p), mergeSha: p.mergeSha })),
    },
  });
  queueClosure(state, step);
}

/**
 * GitHub refused the Repository's merge method: `merge` waits for a human with
 * the `merge_method_refused` Blocker and its Blocker Approval (retry the
 * merge, cancel the Job). Not a failure.
 */
export function refuseMergeMethod(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  pr: PullRequestRow,
  method: MergeMethod,
  message: string,
): void {
  const run = latestStageRun(state, 'merge');
  if (run?.state !== 'running') return;
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, pr.taskId)).get();
  if (task === undefined) throw new Error(`no Task ${pr.taskId}`);
  const blocker: Blocker = {
    kind: 'human',
    reason: 'merge_method_refused',
    detail: `GitHub refused to merge ${label(pr)} with the method ${method}: ${message}`,
    requiredAction: `allow ${method} merges in the repository's settings on GitHub, then retry the merge; or cancel the Job`,
    taskId: pr.taskId,
    attemptId: approvedAttemptOf(tx, pr.taskId).id,
    createdAt: new Date().toISOString(),
  };
  step(run, 'waiting_human', { blocker });
  openBlockerItem(tx, { jobId: pr.jobId, actor: MERGER }, task, blocker, { stageRunId: run.id });
}

/**
 * The merge could not be made and retrying would not help (the PR was closed,
 * or its head or base moved after the approval, or GitHub refused it for
 * another reason): `merge` fails (`delivery_failed`) and closure reports it.
 */
export function failMerge(tx: Tx, state: JobState, step: StageRunStepper, message: string): void {
  const run = latestStageRun(state, 'merge');
  if (run?.state !== 'running') return;
  step(run, 'failed', { failure: { reason: 'delivery_failed', message, issues: [] } });
  queueClosure(state, step);
}

/** `retry_merge` on a `merge_method_refused` Blocker Approval: `merge` is queued again. */
export function retryMerge(state: JobState, step: StageRunStepper, actor: string): void {
  const run = latestStageRun(state, 'merge');
  const blocker =
    run?.blockerJson == null ? undefined : BlockerSchema.parse(JSON.parse(run.blockerJson));
  if (run?.state !== 'waiting_human' || blocker?.reason !== 'merge_method_refused') {
    throw new ApiFailure(
      409,
      'nothing_to_retry',
      'the merge Stage is not waiting on a refused merge method',
    );
  }
  step(run, 'queued', { reason: `retry the merge, decided by ${actor}` });
}

function queueClosure(state: JobState, step: StageRunStepper): void {
  const closure = latestStageRun(state, 'closure');
  if (closure?.state === 'pending') step(closure, 'queued');
}
