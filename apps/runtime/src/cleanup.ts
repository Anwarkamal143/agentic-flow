/**
 * Cancel cleanup (PRODUCT_SPEC §12, ADR-0027, ADR-0043): the one `cleanup`
 * Inbox Item a cancel opens once everything is stopped, its answers, and
 * carrying them out. The item asks separately, each defaulting to keep:
 * discard the preserved Worktrees? close the PR? delete the remote branch?
 * An answer only records what the human chose; {@link CleanupWorker} carries
 * it out afterwards from that persisted decision. A discard goes one Worktree
 * at a time: leftovers become a flagged WIP commit on the Task Branch first,
 * and the row moves to `removed` only once its directory is gone. Each PR of
 * the Job, kept open or closed, gets a marked comment saying the factory
 * stopped tracking it; the remote branch is deleted only on an explicit yes.
 * The Task Branches are never deleted locally, and no uncommitted work is lost.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  checkCleanupAnswers,
  cleanupChoices,
  CLEANUP_OPTIONS,
  cleanupItemText,
  cleanupQuestions,
  InboxDecisionSchema,
  InboxQuestionSchema,
  LEGACY_CLEANUP_OPTIONS,
  untrackedComment,
  untrackedMarker,
  type ApprovalKind,
  type CleanupChoices,
  type CleanupScope,
  type ExpiresPolicy,
  type QuestionAnswer,
} from '@factory/domain';
import { removeWorktree } from '@factory/git';
import type { GitHubFailure, GitHubPort } from '@factory/github';
import { and, asc, eq, ne, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { changeJob, stepWorktree } from './engine.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { label } from './merge-approval.js';
import { PassLoop } from './pass-loop.js';
import { commitLeftovers, requireWorktree } from './worktree.js';

type ApprovalRow = typeof schema.approvals.$inferSelect;
type PullRequestRow = typeof schema.pullRequests.$inferSelect;

/** What the worker needs of GitHub: close a PR, comment on it, delete its branch. */
export type CleanupGitHub = Pick<
  GitHubPort,
  'updatePullRequest' | 'createComment' | 'listIssueComments' | 'deleteBranch'
>;

const KIND: ApprovalKind = 'cleanup';
/** The runtime itself does the removals the human decided. */
const ACTOR = 'system:runtime';
/** The worker also runs on a timer, so a discard left by a crash is resumed. */
const POLL_MS = 5_000;

/** The Job's PRs the factory opened and nobody merged: the ones a cleanup is about. */
function unmergedPullRequests(db: FactoryDb | Tx, jobId: string): PullRequestRow[] {
  return db
    .select()
    .from(schema.pullRequests)
    .where(and(eq(schema.pullRequests.jobId, jobId), ne(schema.pullRequests.state, 'merged')))
    .orderBy(asc(sql`"pull_requests"."rowid"`))
    .all();
}

/** What a cancel left to clean up, from the rows. */
function cleanupScopeOf(db: FactoryDb | Tx, jobId: string): CleanupScope {
  const prs = unmergedPullRequests(db, jobId);
  return {
    preservedWorktrees: preservedWorktrees(db, jobId).length,
    openPullRequests: prs.filter((p) => p.state === 'open').map(label),
    remoteBranches: [...new Set(prs.map((p) => p.headBranch))],
  };
}

/**
 * Opens the Job's one `cleanup` item, last in the cancel (after every Attempt
 * is stopped and recorded, the leases released, the Worktrees `preserved`
 * and the open items `cancelled`). Its subject is the Job. It asks only what
 * applies (`cleanupQuestions`); none is opened when there is nothing to ask,
 * or the Job already has one. Returns its id.
 */
export function openCleanupItem(tx: Tx, jobId: string, actor: string): string | undefined {
  const existing = tx
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, KIND)))
    .get();
  if (existing !== undefined) return undefined;
  const scope = cleanupScopeOf(tx, jobId);
  const questions = cleanupQuestions(scope);
  if (questions.length === 0) return undefined;
  const preserved = preservedWorktrees(tx, jobId);
  const prs = unmergedPullRequests(tx, jobId);
  const id = newId('apr');
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  const { question, why } = cleanupItemText(scope);
  tx.insert(schema.approvals)
    .values({
      id,
      jobId,
      stageRunId: null,
      kind: KIND,
      subjectRef: jobId,
      question,
      why,
      questionsJson: JSON.stringify(questions),
      optionsJson: JSON.stringify(CLEANUP_OPTIONS),
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
    payload: {
      kind: KIND,
      subjectRef: jobId,
      worktrees: preserved.map((w) => ({ id: w.id, taskId: w.taskId, path: w.path })),
      pullRequests: prs.map((p) => ({ id: p.id, pullRequest: label(p), state: p.state })),
      remoteBranches: scope.remoteBranches,
      questions: questions.map((q) => q.id),
    },
  });
  return id;
}

/**
 * Opens the cleanup item a crash kept a cancel from opening: for every
 * cancelled Job with something to ask and no cleanup item. Called at
 * startup, after recovery and before the API listens, so no cancel is in
 * progress.
 */
export function openMissingCleanupItems(db: FactoryDb): number {
  const jobs = db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.status, 'cancelled'),
        notExists(
          db
            .select({ id: schema.approvals.id })
            .from(schema.approvals)
            .where(
              and(eq(schema.approvals.jobId, schema.jobs.id), eq(schema.approvals.kind, KIND)),
            ),
        ),
      ),
    )
    .all();
  let opened = 0;
  for (const job of jobs) {
    if (cleanupQuestions(cleanupScopeOf(db, job.id)).length === 0) continue;
    changeJob(db, { jobId: job.id, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      if (openCleanupItem(tx, job.id, ACTOR) !== undefined) opened++;
    });
  }
  return opened;
}

function requireCancelledJob(tx: Tx, item: ApprovalRow): void {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, item.jobId)).get();
  if (job?.status !== 'cancelled') {
    throw new Error(`cleanup item ${item.id} belongs to a Job that is not cancelled`);
  }
}

/** A `cleanup` item's questions, as stored; `[]` for an item opened before them (ADR-0027). */
export function cleanupQuestionsOf(item: Pick<ApprovalRow, 'questionsJson'>) {
  return z.array(InboxQuestionSchema).parse(JSON.parse(item.questionsJson ?? '[]'));
}

/**
 * A decision of a `cleanup` item opened before its questions existed
 * (`keep` | `discard`, ADR-0027), inside the decide transaction (the item is
 * already `decided`). An item with questions is answered instead (the
 * decider refuses it with 409 `answer_required` before this).
 */
export function applyCleanupDecision(tx: Tx, item: ApprovalRow, option: string): void {
  requireCancelledJob(tx, item);
  if (item.questionsJson !== null) throw new Error(`cleanup item ${item.id} is answered`);
  if (!LEGACY_CLEANUP_OPTIONS.includes(option)) {
    throw new Error(`unknown cleanup option ${option}`);
  }
}

/**
 * Checks a `cleanup` item's answers (`checkCleanupAnswers`): refused with 400
 * when an answer is not one of its question's options, or would delete the
 * branch of a PR kept open. Called inside the answer transaction, before the
 * item is marked decided. Nothing is carried out here: the decision is the
 * durable request, and the {@link CleanupWorker} acts on it after the commit.
 */
export function checkCleanupAnswersOf(
  tx: Tx,
  item: ApprovalRow,
  answers: readonly QuestionAnswer[],
): void {
  requireCancelledJob(tx, item);
  const refusal = checkCleanupAnswers(cleanupQuestionsOf(item), answers);
  if (refusal !== undefined) throw new ApiFailure(400, refusal.code, refusal.message);
}

/** Why a cleanup step on GitHub stopped: retried at the next pass, or only at the next start. */
class GitHubStepFailed extends Error {
  constructor(
    readonly step: 'close_pr' | 'comment' | 'delete_branch',
    readonly failure: GitHubFailure,
  ) {
    super(
      `${step}: ${failure.kind === 'rate_limited' ? `rate limited until ${failure.resetAt}` : `${failure.kind}: ${failure.reason}`}`,
    );
  }

  /** A transient failure or a rate limit is tried again; a refusal waits for the next start. */
  get retryable(): boolean {
    return this.failure.kind !== 'refused';
  }
}

/**
 * Carries out every decided `cleanup` item not yet completed, from its
 * persisted decision (`cleanupChoices`):
 *
 * 1. A discard: for each of the Job's preserved Worktrees, any leftovers are
 *    committed as a flagged WIP commit on its Task Branch
 *    (`worktree.wip_committed`), then the Worktree is removed, never forced,
 *    and recorded `removed`. One that can't be committed or removed stays
 *    `preserved` with a `worktree.remove_failed` event saying why, and is not
 *    retried until the next runtime start.
 * 2. Each PR of the Job nobody merged: closed on GitHub when the human said
 *    so (`pull_request.closed`), then, kept open or closed, given the marked
 *    comment that the factory stopped tracking it (`pull_request.untracked`;
 *    a comment already carrying the marker is reused, so a crash never posts
 *    two), then its remote branch deleted only on an explicit yes
 *    (`pull_request.branch_deleted`). A GitHub failure records
 *    `cleanup.step_failed`; a transient one or a rate limit is tried again at
 *    the next pass, a refusal at the next runtime start.
 * 3. `cleanup.completed` on the item.
 *
 * Each step is idempotent by its row or its event, so a crash resumes where it
 * stopped. Task Branches stay in the Factory Clone.
 */
export class CleanupWorker {
  private readonly loop: PassLoop;
  /** Items this runtime gave up on until its next start (a refusal, a failed removal). */
  private readonly done = new Set<string>();
  /**
   * Items a transient GitHub failure holds back, with when they may be tried
   * again (the timer's interval, or a rate limit's reset) and the failure last
   * recorded, so a failing item neither blocks the others, nor retries in a
   * tight loop, nor records the same failure on every pass.
   */
  private readonly retry = new Map<string, { at: number; failure: string }>();

  constructor(
    private readonly db: FactoryDb,
    private readonly github: CleanupGitHub,
    private readonly onCommit: () => void,
    private readonly log: (message: string) => void,
  ) {
    this.loop = new PassLoop(() => this.pass(), POLL_MS);
  }

  start(): void {
    this.loop.start();
  }

  wake(): void {
    this.loop.wake();
  }

  async close(): Promise<void> {
    this.loop.halt();
    await this.loop.idle();
  }

  private async pass(): Promise<boolean> {
    const now = Date.now();
    const item = this.pending().find(
      (i) => !this.done.has(i.id) && (this.retry.get(i.id)?.at ?? 0) <= now,
    );
    if (item === undefined) return false;
    try {
      const finished = await this.carryOut(item);
      this.retry.delete(item.id);
      if (!finished) this.done.add(item.id);
      return finished;
    } catch (err) {
      if (err instanceof GitHubStepFailed) {
        const previous = this.retry.get(item.id)?.failure;
        if (err.retryable) {
          const reset =
            err.failure.kind === 'rate_limited' ? Date.parse(err.failure.resetAt) : Number.NaN;
          this.retry.set(item.id, {
            at: Number.isFinite(reset) ? Math.max(reset, now + POLL_MS) : now + POLL_MS,
            failure: err.message,
          });
        } else {
          this.retry.delete(item.id);
          this.done.add(item.id);
        }
        // The same failure again is not recorded again.
        if (previous !== err.message) this.failed(item, err);
        // Other items go on; this one waits for its retry time (the timer brings it back).
        return true;
      }
      this.done.add(item.id);
      this.log(`cleanup: ${item.id} stopped: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  /** Decided items with something to carry out and no `cleanup.completed`. */
  private pending(): ApprovalRow[] {
    return this.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.kind, KIND),
          eq(schema.approvals.state, 'decided'),
          notExists(
            this.db
              .select({ seq: schema.events.seq })
              .from(schema.events)
              .where(
                and(
                  eq(schema.events.entityKind, 'approval'),
                  eq(schema.events.entityId, schema.approvals.id),
                  eq(schema.events.type, 'cleanup.completed'),
                ),
              ),
          ),
        ),
      )
      .all()
      .filter((row) => {
        const choices = choicesOf(row);
        // A kept item still comments on each PR it asked about; a Phase B keep does nothing.
        return (
          choices.discardWorktrees || (row.questionsJson !== null && askedAboutPullRequests(row))
        );
      });
  }

  /** `true` once completed; `false` when a Worktree could not be removed (tried at the next start). */
  private async carryOut(item: ApprovalRow): Promise<boolean> {
    const choices = choicesOf(item);
    const removed = choices.discardWorktrees ? await this.discard(item) : [];
    if (removed === undefined) return false;
    const pullRequests: { pullRequest: string; closed: boolean; branchDeleted: boolean }[] = [];
    for (const pr of unmergedPullRequests(this.db, item.jobId)) {
      pullRequests.push(await this.untrack(item, pr, choices));
    }
    this.db.transaction(
      (tx) => {
        appendEvent(tx, {
          entityKind: 'approval',
          entityId: item.id,
          jobId: item.jobId,
          type: 'cleanup.completed',
          actor: ACTOR,
          payload: { removed, pullRequests },
        });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return true;
  }

  /** Closes (if asked), comments on, and deletes the branch of (if asked) one PR. */
  private async untrack(
    item: ApprovalRow,
    row: PullRequestRow,
    choices: CleanupChoices,
  ): Promise<{ pullRequest: string; closed: boolean; branchDeleted: boolean }> {
    const repo = { owner: row.owner, name: row.name };
    let pr = row;
    if (choices.closePullRequests && pr.state === 'open') {
      const res = await this.github.updatePullRequest(repo, pr.number, { state: 'closed' });
      if (!res.ok) throw new GitHubStepFailed('close_pr', res.failure);
      pr = this.recordClosed(item, pr);
    }
    if (!this.hasEvent(item, pr, 'pull_request.untracked')) {
      const commentId = await this.comment(item, pr);
      this.prEvent(item, pr, 'pull_request.untracked', {
        number: pr.number,
        closed: pr.state === 'closed',
        commentId,
      });
    }
    let branchDeleted = this.hasEvent(item, pr, 'pull_request.branch_deleted');
    if (choices.deleteRemoteBranches && !branchDeleted) {
      const res = await this.github.deleteBranch(repo, pr.headBranch);
      if (!res.ok) throw new GitHubStepFailed('delete_branch', res.failure);
      this.prEvent(item, pr, 'pull_request.branch_deleted', {
        branch: pr.headBranch,
        alreadyGone: res.value.gone,
      });
      branchDeleted = true;
    }
    return { pullRequest: label(pr), closed: pr.state === 'closed', branchDeleted };
  }

  /** The marked comment: an existing one carrying the marker is reused. Returns its id. */
  private async comment(item: ApprovalRow, pr: PullRequestRow): Promise<number> {
    const repo = { owner: pr.owner, name: pr.name };
    const marker = untrackedMarker(item.jobId);
    const existing = await this.github.listIssueComments(repo, pr.number);
    if (!existing.ok) throw new GitHubStepFailed('comment', existing.failure);
    if (!existing.notModified) {
      const found = existing.value.find((c) => c.body.includes(marker));
      if (found !== undefined) return found.id;
    }
    const res = await this.github.createComment(
      repo,
      pr.number,
      untrackedComment(item.jobId, { closed: pr.state === 'closed' }),
    );
    if (!res.ok) throw new GitHubStepFailed('comment', res.failure);
    return res.value.id;
  }

  private recordClosed(item: ApprovalRow, pr: PullRequestRow): PullRequestRow {
    this.db.transaction(
      (tx) => {
        const updated = tx
          .update(schema.pullRequests)
          .set({ state: 'closed', version: sql`${schema.pullRequests.version} + 1` })
          .where(
            and(eq(schema.pullRequests.id, pr.id), eq(schema.pullRequests.version, pr.version)),
          )
          .run();
        if (updated.changes !== 1) throw new Error(`pull request ${pr.id} changed under cleanup`);
        appendEvent(tx, {
          entityKind: 'pull_request',
          entityId: pr.id,
          jobId: item.jobId,
          type: 'pull_request.closed',
          actor: ACTOR,
          payload: { approvalId: item.id, number: pr.number, reason: 'cancel cleanup' },
        });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return { ...pr, state: 'closed', version: pr.version + 1 };
  }

  private hasEvent(item: ApprovalRow, pr: PullRequestRow, type: string): boolean {
    return this.db
      .select({ payload: schema.events.payloadJson })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityKind, 'pull_request'),
          eq(schema.events.entityId, pr.id),
          eq(schema.events.type, type),
        ),
      )
      .all()
      .some((e) => (JSON.parse(e.payload) as { approvalId?: unknown }).approvalId === item.id);
  }

  private prEvent(
    item: ApprovalRow,
    pr: PullRequestRow,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.transaction((tx) => {
      appendEvent(tx, {
        entityKind: 'pull_request',
        entityId: pr.id,
        jobId: item.jobId,
        type,
        actor: ACTOR,
        payload: { approvalId: item.id, ...payload },
      });
    });
    this.onCommit();
  }

  private failed(item: ApprovalRow, err: GitHubStepFailed): void {
    this.log(`cleanup: ${item.id}: ${err.message}`);
    this.db.transaction((tx) => {
      appendEvent(tx, {
        entityKind: 'approval',
        entityId: item.id,
        jobId: item.jobId,
        type: 'cleanup.step_failed',
        actor: ACTOR,
        payload: {
          step: err.step,
          failure: err.failure.kind,
          status: err.failure.status,
          retried: err.retryable ? 'at the next pass' : 'at the next runtime start',
          message: err.failure.kind === 'rate_limited' ? null : err.failure.reason,
        },
      });
    });
    this.onCommit();
  }

  /**
   * Removes the Job's preserved Worktrees. Returns what was removed, or
   * `undefined` when one could not be (it stays `preserved`).
   */
  private async discard(
    item: ApprovalRow,
  ): Promise<{ worktreeId: string; wipCommit: string | null }[] | undefined> {
    const { jobId } = item;
    const removed: { worktreeId: string; wipCommit: string | null }[] = [];
    const failed: string[] = [];
    for (const worktree of preservedWorktrees(this.db, jobId)) {
      const repo = this.db
        .select({ clonePath: schema.repositories.clonePath })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, worktree.repositoryId))
        .get();
      let step: 'wip_commit' | 'remove' = 'wip_commit';
      let wip: { sha: string; paths: string[] } | undefined;
      try {
        if (repo === undefined) throw new Error('no Repository');
        // Never discard uncommitted work (CLAUDE.md §3): it goes onto the Task Branch first.
        wip = await commitLeftovers(worktree.path);
        if (wip !== undefined) {
          const committed = wip;
          this.event(jobId, worktree.id, 'worktree.wip_committed', {
            taskId: worktree.taskId,
            branch: worktree.branch,
            approvalId: item.id,
            wipCommit: committed.sha,
            paths: committed.paths,
          });
        }
        step = 'remove';
        // Not forced: git refuses a Worktree with anything still uncommitted.
        await removeWorktree(repo.clonePath, worktree.path);
      } catch (err) {
        failed.push(worktree.id);
        this.event(jobId, worktree.id, 'worktree.remove_failed', {
          path: worktree.path,
          approvalId: item.id,
          step,
          wipCommit: wip?.sha ?? null,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      changeJob(this.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
        stepWorktree(
          tx,
          { jobId, actor: ACTOR },
          requireWorktree(tx, worktree.id),
          'preserved',
          'removed',
          { approvalId: item.id, reason: 'discarded', wipCommit: wip?.sha ?? null },
        );
      });
      removed.push({ worktreeId: worktree.id, wipCommit: wip?.sha ?? null });
      this.onCommit();
    }
    // Retried at the next start; no completion recorded.
    return failed.length > 0 ? undefined : removed;
  }

  private event(
    jobId: string,
    worktreeId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.transaction((tx) => {
      appendEvent(tx, {
        entityKind: 'worktree',
        entityId: worktreeId,
        jobId,
        type,
        actor: ACTOR,
        payload,
      });
    });
    this.onCommit();
  }
}

function choicesOf(row: ApprovalRow): CleanupChoices {
  if (row.decisionJson === null) throw new Error(`cleanup item ${row.id} has no decision`);
  return cleanupChoices(InboxDecisionSchema.parse(JSON.parse(row.decisionJson)));
}

/** Whether the item asked about a PR or a remote branch (so each PR gets its comment). */
function askedAboutPullRequests(row: ApprovalRow): boolean {
  return cleanupQuestionsOf(row).some((q) => q.id !== 'worktrees');
}

function preservedWorktrees(db: FactoryDb | Tx, jobId: string) {
  return db
    .select()
    .from(schema.worktrees)
    .where(and(eq(schema.worktrees.jobId, jobId), eq(schema.worktrees.state, 'preserved')))
    .all();
}
