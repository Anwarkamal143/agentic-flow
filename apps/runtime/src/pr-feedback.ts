/**
 * The PR feedback loop (#60, ADR-0039; C5, C6). Feedback on an open factory
 * PR becomes Rework on the Integration Branch, and the same PR is updated in
 * place. GitHub text stays untrusted context: it never changes policy,
 * decides an item, or widens a scope.
 *
 * - The poller classifies the PR's reviews and comments (`classifyFeedback`)
 *   and records each new one in `pr_feedback` (redacted). A trigger (a
 *   `CHANGES_REQUESTED` review, a comment beginning `/factory`) or the
 *   operator's `request_changes` on the `merge` item starts the Rework
 *   ({@link startFeedbackRework}); other text waits for the next Rework.
 * - The Rework supersedes `merge_approval` and its `merge` items, and adds
 *   new `integration_review`, `pull_request` and `merge_approval` Stage Runs
 *   at `attempt + 1` (Q17). The approved Integration Task goes back to
 *   `ready`, or, with no Attempt left, waits on `rework_cap_reached`.
 * - The Rework Attempt's packet carries the feedback (`context.prFeedback`),
 *   GitHub text labelled untrusted.
 * - Every comment the factory posts carries the marker
 *   `<!-- factory:<job>:<event> -->` and is looked up before it is posted
 *   ({@link ensureComment}), so a write retried after a crash is not repeated.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  attemptsCountedForRework,
  AttemptCauseSchema,
  ciFeedbackText,
  classifyFeedback,
  FeedbackKindSchema,
  FeedbackSourceSchema,
  prFeedbackEntry,
  TaskPacketSchema,
  type Blocker,
  type FeedbackItem,
  type FeedbackKind,
  type GitHubCoordinates,
  type PrFeedbackEntry,
  type Redactor,
} from '@factory/domain';
import type { Comment, GitHubFailure, GitHubPort, Review, ReviewComment } from '@factory/github';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { readJobState, stepTask, type JobState, type StageRunStepper } from './engine.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { settleIntegration } from './integration.js';
import {
  pullRequestOfItem,
  requireFailedChecks,
  supersedeHeldBlockerItems,
  supersedeMergeItems,
} from './merge-approval.js';
import { addStageRun, latestStageRun } from './replan.js';

type PullRequestRow = typeof schema.pullRequests.$inferSelect;
type FeedbackRow = typeof schema.prFeedback.$inferSelect;

/** What the poller read, as feedback items, oldest first per kind. */
export function feedbackItems(
  reviews: readonly Review[],
  comments: readonly Comment[],
  reviewComments: readonly ReviewComment[],
): FeedbackItem[] {
  return [
    ...reviews.map((r): FeedbackItem => ({
      source: 'review',
      id: String(r.id),
      author: r.author,
      body: r.body,
      reviewState: r.state,
      path: null,
      url: null,
      createdAt: r.submittedAt ?? '',
    })),
    ...comments.map((c): FeedbackItem => ({
      source: 'issue_comment',
      id: String(c.id),
      author: c.author,
      body: c.body,
      reviewState: null,
      path: null,
      url: c.htmlUrl,
      createdAt: c.createdAt,
    })),
    ...reviewComments.map((c): FeedbackItem => ({
      source: 'review_comment',
      id: String(c.id),
      author: c.author,
      body: c.body,
      reviewState: null,
      path: c.path,
      url: c.htmlUrl,
      createdAt: c.createdAt,
    })),
  ];
}

/** The classified items the factory has not recorded yet for `pr` (read-only). */
export function unseenFeedback(
  db: FactoryDb | Tx,
  prId: string,
  items: readonly FeedbackItem[],
): { item: FeedbackItem; kind: FeedbackKind }[] {
  const seen = new Set(
    db
      .select({ source: schema.prFeedback.source, externalId: schema.prFeedback.externalId })
      .from(schema.prFeedback)
      .where(eq(schema.prFeedback.pullRequestId, prId))
      .all()
      .map((r) => `${r.source}:${r.externalId}`),
  );
  return classifyFeedback(items).filter((c) => !seen.has(`${c.item.source}:${c.item.id}`));
}

/**
 * Records new feedback on `pr` in the caller's transaction, redacted, with a
 * `pull_request.feedback_received` event. Returns the triggers recorded.
 */
export function recordFeedback(
  tx: Tx,
  pr: PullRequestRow,
  unseen: readonly { item: FeedbackItem; kind: FeedbackKind }[],
  opts: { redact: Redactor; now: string; actor: string },
): FeedbackRow[] {
  if (unseen.length === 0) return [];
  const rows = unseen.map(({ item, kind }): FeedbackRow => ({
    id: newId('fbk'),
    jobId: pr.jobId,
    pullRequestId: pr.id,
    source: item.source,
    externalId: item.id,
    author: item.author,
    reviewState: item.reviewState,
    path: item.path,
    url: item.url,
    kind,
    body: opts.redact(item.body),
    createdAt: item.createdAt === '' ? opts.now : item.createdAt,
    observedAt: opts.now,
    attemptId: null,
  }));
  for (const row of rows) tx.insert(schema.prFeedback).values(row).run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: pr.id,
    jobId: pr.jobId,
    type: 'pull_request.feedback_received',
    actor: opts.actor,
    // The text stays in `pr_feedback`: the event names only what came, from whom.
    payload: {
      number: pr.number,
      feedback: rows.map((r) => ({
        id: r.id,
        source: r.source,
        author: r.author,
        reviewState: r.reviewState,
        kind: r.kind,
      })),
    },
  });
  return rows.filter((r) => r.kind === 'trigger');
}

/** The operator's `request_changes` on a `merge` item, recorded as a trigger (`source: inbox`). */
export function recordInboxChangeRequest(
  tx: Tx,
  pr: PullRequestRow,
  item: { id: string },
  comment: string,
  actor: string,
): FeedbackRow {
  const now = new Date().toISOString();
  const row: FeedbackRow = {
    id: newId('fbk'),
    jobId: pr.jobId,
    pullRequestId: pr.id,
    source: 'inbox',
    externalId: item.id,
    author: actor,
    reviewState: null,
    path: null,
    url: null,
    kind: 'trigger',
    body: comment.trim(),
    createdAt: now,
    observedAt: now,
    attemptId: null,
  };
  tx.insert(schema.prFeedback).values(row).run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: pr.id,
    jobId: pr.jobId,
    type: 'pull_request.feedback_received',
    actor,
    payload: {
      number: pr.number,
      feedback: [
        { id: row.id, source: 'inbox', author: actor, reviewState: null, kind: 'trigger' },
      ],
    },
  });
  return row;
}

/** One line naming what triggered a Rework, for reasons, Blockers and the factory's comment. */
export function describeTriggers(
  rows: readonly Pick<FeedbackRow, 'source' | 'author' | 'reviewState'>[],
): string {
  const named = rows.map((r) => {
    const who = r.author ?? 'an unknown user';
    switch (FeedbackSourceSchema.parse(r.source)) {
      case 'review':
        return `a ${r.reviewState ?? 'CHANGES_REQUESTED'} review by ${who}`;
      case 'issue_comment':
      case 'review_comment':
        return `a /factory comment by ${who}`;
      case 'inbox':
        return `request_changes by ${who} in the Inbox`;
      case 'ci':
        return 'a failed required check sent to Rework from the Inbox';
    }
  });
  return [...new Set(named)].join(', ') || 'feedback on the pull request';
}

/**
 * Feedback sends the open PR back for Rework (Q17), in the caller's
 * versioned Job transaction: the `merge` items and `merge_approval` are
 * superseded; new `integration_review`, `pull_request` and `merge_approval`
 * Stage Runs are added at `attempt + 1`, the new `integration_review`
 * running; the approved Integration Task goes back to `ready`. The Rework
 * counts against its `maxAttempts`: with none left it waits on the
 * `rework_cap_reached` Blocker (and its Approval) instead. `false` when the
 * Job no longer waits on its merge (nothing changes).
 */
export function startFeedbackRework(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: { pr: PullRequestRow; actor: string; why: string },
): boolean {
  const { pr, actor, why } = input;
  const jobId = pr.jobId;
  const holder = latestStageRun(state, 'merge_approval');
  const review = latestStageRun(state, 'integration_review');
  const opening = latestStageRun(state, 'pull_request');
  if (holder?.state !== 'waiting_human' || review === undefined || opening === undefined) {
    return false;
  }
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, pr.taskId)).get();
  if (task?.kind !== 'integration' || task.state !== 'approved') {
    throw new Error(`pull request ${pr.id} has no approved Integration Task to rework`);
  }
  const reason = `feedback on the pull request: ${why}`;
  supersedeMergeItems(tx, jobId, actor, reason);
  supersedeHeldBlockerItems(tx, holder, actor, reason);
  step(holder, 'superseded', { reason });
  const nextReview = addStageRun(tx, jobId, review, actor, 'pr_feedback');
  addStageRun(tx, jobId, opening, actor, 'pr_feedback');
  addStageRun(tx, jobId, holder, actor, 'pr_feedback');
  step(nextReview, 'queued', { reason });
  const queued = latestStageRun(readJobState(tx, jobId), 'integration_review');
  if (queued === undefined) throw new Error(`Job ${jobId} lost its integration_review Stage Run`);
  step(queued, 'running');

  const op = { jobId, actor };
  const attempts = tx
    .select({ id: schema.attempts.id, cause: schema.attempts.cause, state: schema.attempts.state })
    .from(schema.attempts)
    .where(eq(schema.attempts.taskId, task.id))
    .orderBy(desc(schema.attempts.n))
    .all();
  const used = attemptsCountedForRework(
    attempts.map((a) => ({ cause: AttemptCauseSchema.parse(a.cause) })),
  );
  const sent = stepTask(tx, op, task, 'changes_requested', {
    reason: 'pr_feedback',
    payload: { pullRequestId: pr.id, why },
  });
  if (used >= task.maxAttempts) {
    const approved = attempts.find((a) => a.state === 'passed');
    if (approved === undefined) throw new Error(`approved Task ${task.id} has no passed Attempt`);
    const blocker: Blocker = {
      kind: 'human',
      reason: 'rework_cap_reached',
      detail: `${why} asks for Rework of the Integration Branch, but Attempt ${String(used)} of at most ${String(task.maxAttempts)} was the last allowed, so no Rework starts`,
      requiredAction:
        'decide the Blocker Approval in the Inbox: grant more Attempts (with guidance), replan, or cancel the Job',
      taskId: task.id,
      attemptId: approved.id,
      createdAt: new Date().toISOString(),
    };
    stepTask(tx, op, sent, 'blocked', { reason: blocker.reason, blocker });
    settleIntegration(tx, readJobState(tx, jobId), step);
    return true;
  }
  stepTask(tx, op, sent, 'ready', {
    reason: 'pr_feedback',
    payload: { nextAttempt: used + 1 },
  });
  return true;
}

/**
 * The PR feedback a new Attempt of the Integration Task carries, and the rows
 * it takes. A Rework after the Task's passed Attempt (a new round of
 * feedback) takes the rows no Attempt carried yet; a later Attempt of the same
 * round (after a failed Gate or review, a Retry, an answer) carries on with
 * what the one before it carried, plus any row not carried yet.
 */
export function feedbackForAttempt(
  db: FactoryDb | Tx,
  task: { id: string; kind: string },
  previous: { state: string; packetJson: string } | undefined,
): { entries: PrFeedbackEntry[]; rowIds: string[] } {
  if (task.kind !== 'integration' || previous === undefined) return { entries: [], rowIds: [] };
  const carried =
    previous.state === 'passed'
      ? []
      : TaskPacketSchema.parse(JSON.parse(previous.packetJson)).context.prFeedback;
  const prIds = db
    .select({ id: schema.pullRequests.id })
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.taskId, task.id))
    .all()
    .map((r) => r.id);
  if (prIds.length === 0) return { entries: carried, rowIds: [] };
  const rows = db
    .select()
    .from(schema.prFeedback)
    .where(
      and(inArray(schema.prFeedback.pullRequestId, prIds), isNull(schema.prFeedback.attemptId)),
    )
    .orderBy(asc(schema.prFeedback.observedAt), asc(sql`"pr_feedback"."rowid"`))
    .all();
  return {
    entries: [
      ...carried,
      ...rows.map((r) =>
        prFeedbackEntry({
          source: FeedbackSourceSchema.parse(r.source),
          author: r.author,
          reviewState: r.reviewState,
          path: r.path,
          url: r.url,
          kind: FeedbackKindSchema.parse(r.kind),
          body: r.body,
        }),
      ),
    ],
    rowIds: rows.map((r) => r.id),
  };
}

/** Marks the feedback rows an Attempt's packet carried, in the transaction that records the Attempt. */
export function markFeedbackCarried(tx: Tx, rowIds: readonly string[], attemptId: string): void {
  if (rowIds.length === 0) return;
  tx.update(schema.prFeedback)
    .set({ attemptId })
    .where(and(inArray(schema.prFeedback.id, [...rowIds]), isNull(schema.prFeedback.attemptId)))
    .run();
}

/** The triggers the Rework Attempts after `pushedAttemptN` carried: what this update answers. */
export function triggersAnswered(
  db: FactoryDb,
  taskId: string,
  pushedAttemptN: number,
): FeedbackRow[] {
  return db
    .select({ row: schema.prFeedback })
    .from(schema.prFeedback)
    .innerJoin(schema.attempts, eq(schema.attempts.id, schema.prFeedback.attemptId))
    .where(
      and(
        eq(schema.attempts.taskId, taskId),
        sql`${schema.attempts.n} > ${pushedAttemptN}`,
        eq(schema.prFeedback.kind, 'trigger'),
      ),
    )
    .orderBy(asc(sql`"pr_feedback"."rowid"`))
    .all()
    .map((r) => r.row);
}

export type EnsuredComment =
  { kind: 'created' | 'found'; comment: Comment } | { kind: 'failed'; failure: GitHubFailure };

/**
 * Posts `body` on PR `number` unless a comment carrying `marker` is already
 * there (Q28): a write a crash left unrecorded is found, never repeated. The
 * lookup comes first, and nothing is posted when it fails.
 */
export async function ensureComment(
  port: GitHubPort,
  repo: GitHubCoordinates,
  number: number,
  marker: string,
  body: string,
): Promise<EnsuredComment> {
  if (!body.includes(marker)) throw new Error('a factory comment carries its marker');
  const listed = await port.listIssueComments(repo, number);
  if (!listed.ok) return { kind: 'failed', failure: listed.failure };
  if (listed.notModified) throw new Error('an unconditional read answered 304');
  const found = listed.value.find((c) => c.body.includes(marker));
  if (found !== undefined) return { kind: 'found', comment: found };
  const created = await port.createComment(repo, number, body);
  return created.ok
    ? { kind: 'created', comment: created.value }
    : { kind: 'failed', failure: created.failure };
}

/**
 * `request_changes` on a `merge` item (comment required), inside the
 * decision's transaction after the item was marked decided: the comment is
 * recorded as the operator's change request and the Rework starts, as for a
 * trigger on GitHub.
 */
export function requestPullRequestChanges(
  tx: Tx,
  item: { id: string; subjectRef: string },
  comment: string,
  actor: string,
  state: JobState,
  step: StageRunStepper,
): void {
  const pr = pullRequestOfItem(tx, item);
  if (pr.state !== 'open') {
    throw new ApiFailure(
      409,
      'pull_request_not_open',
      `pull request ${pr.owner}/${pr.name}#${String(pr.number)} is ${pr.state}: there is nothing to rework`,
    );
  }
  const row = recordInboxChangeRequest(tx, pr, item, comment, actor);
  if (!startFeedbackRework(tx, state, step, { pr, actor, why: describeTriggers([row]) })) {
    throw new ApiFailure(409, 'not_awaiting_merge', 'the Job no longer waits on its merge');
  }
}

/**
 * `rework` on a `ci_failed` Blocker Approval (#61, Q14), inside the decision's
 * transaction after the item was marked decided: each failed check (name,
 * conclusion, summary, link) is recorded as a `ci` trigger, untrusted CI text,
 * and the feedback Rework starts on the Integration Branch as for a review.
 * The operator's comment reaches the Rework as guidance (the decided item).
 */
export function reworkFailedChecks(
  tx: Tx,
  item: { id: string; stageRunId: string | null },
  actor: string,
  state: JobState,
  step: StageRunStepper,
): void {
  const failed = requireFailedChecks(tx, state, item);
  const [first] = failed;
  const now = new Date().toISOString();
  const rows = failed.map(({ pr, check }): FeedbackRow => ({
    id: newId('fbk'),
    jobId: pr.jobId,
    pullRequestId: pr.id,
    source: 'ci',
    externalId: `${item.id}:${check.source}:${check.name}`,
    author: null,
    reviewState: null,
    path: null,
    url: check.url,
    kind: 'trigger',
    body: ciFeedbackText({
      name: check.name,
      conclusion: check.conclusion ?? check.status,
      summary: check.summary,
      url: check.url,
    }),
    createdAt: now,
    observedAt: now,
    attemptId: null,
  }));
  for (const row of rows) tx.insert(schema.prFeedback).values(row).run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: first.pr.id,
    jobId: first.pr.jobId,
    type: 'pull_request.feedback_received',
    actor,
    payload: {
      number: first.pr.number,
      feedback: rows.map((r) => ({
        id: r.id,
        source: 'ci',
        author: null,
        reviewState: null,
        kind: 'trigger',
      })),
    },
  });
  const names = [...new Set(failed.map((f) => f.check.name))].join(', ');
  if (
    !startFeedbackRework(tx, state, step, {
      pr: first.pr,
      actor,
      why: `the failed check ${names}, sent to Rework by ${actor}`,
    })
  ) {
    throw new ApiFailure(409, 'not_awaiting_merge', 'the Job no longer waits on its merge');
  }
}
