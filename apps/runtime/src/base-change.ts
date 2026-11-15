/**
 * A moved base (C2; ARCHITECTURE §14, ADR-0041; Phase C grilling Q6, Q12,
 * Q19). The default branch is checked before the first push (the
 * `pull_request` Stage), on every poll while the PR is open (the poller), and
 * right before merging (the merger). When it moved:
 *
 * - every Gate result for the old `(head_sha, base_sha)` is stale: the
 *   `merge` items and `merge_approval` are superseded, and new
 *   `integration_review`, `pull_request`, `merge_approval` (and `merge`, when
 *   it had started) Stage Runs follow at `attempt + 1` ({@link startBaseMergeIn});
 * - the approved Integration Task's next Attempt (cause `base_merge`, no
 *   Harness) merges the default branch into the Integration Branch, one
 *   two-parent commit, never a rebase or a force-push ({@link mergeBaseIn});
 *   the factory verifies the new head, and the approving Integration Review is
 *   re-anchored to the new SHAs or runs again by the pure `reanchorDecision`;
 * - a conflict is the human Blocker `base_merge_conflict` (replan, cancel the
 *   Job; {@link blockOnBaseMergeConflict}).
 *
 * Then the PR is updated in place (a fast-forward), CI runs on the new head on
 * GitHub, and the Merge Gate is evaluated again.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  EffectiveConfigSchema,
  reanchorDecision,
  type Blocker,
  type GitHubCoordinates,
  type ReanchorDecision,
} from '@factory/domain';
import { commitTree, diffPatchId, isAncestor, mergeCommits, remoteBranchHead } from '@factory/git';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import { changeJob, stepTask, type JobState, type StageRunStepper } from './engine.js';
import { settleIntegration } from './integration.js';
import { supersedeHeldBlockerItems, supersedeMergeItems } from './merge-approval.js';
import { githubRemoteUrl } from './pull-request.js';
import { addStageRun, latestStageRun } from './replan.js';
import { releaseAttemptTokens } from './worktree.js';

type RepositoryRow = typeof schema.repositories.$inferSelect;
type AttemptRow = typeof schema.attempts.$inferSelect;
type ReviewRow = typeof schema.reviews.$inferSelect;

/**
 * The default branch's head on GitHub, as ARCHITECTURE §14 compares it: `git
 * ls-remote` with git's own credentials (as the push uses), nothing fetched
 * into the Factory Clone. Every base check reads it this way, never a PR's
 * `base.sha`, which GitHub need not update when the branch moves. `undefined`
 * when GitHub has no such branch; throws when git fails.
 */
export function defaultBranchTip(
  repo: Pick<RepositoryRow, 'clonePath' | 'defaultBranch'>,
  coordinates: GitHubCoordinates,
): Promise<string | undefined> {
  return remoteBranchHead(repo.clonePath, githubRemoteUrl(coordinates), repo.defaultBranch);
}

/** Where the move was seen (Q19). */
export type BaseCheck = 'pre_push' | 'poll' | 'pre_merge';

const SEEN: Record<BaseCheck, string> = {
  pre_push: 'before the first push',
  poll: 'while polling the open pull request',
  pre_merge: 'right before merging',
};

/** The Stages a base merge-in runs again, in order; each one that had started gets an `attempt + 1` run. */
const RERUN_STAGES = ['integration_review', 'pull_request', 'merge_approval', 'merge'] as const;

/** Stage Run states a base merge-in supersedes: in progress, or waiting. */
const SUPERSEDABLE = new Set(['queued', 'running', 'waiting_human', 'blocked']);

/** The newest passed Attempt of `taskId` (before Attempt `beforeN`, when given). */
export function passedAttemptOf(
  db: FactoryDb | Tx,
  taskId: string,
  beforeN?: number,
): (AttemptRow & { headSha: string }) | undefined {
  const row = db
    .select()
    .from(schema.attempts)
    .where(
      and(
        eq(schema.attempts.taskId, taskId),
        eq(schema.attempts.state, 'passed'),
        ...(beforeN === undefined ? [] : [lt(schema.attempts.n, beforeN)]),
      ),
    )
    .orderBy(desc(schema.attempts.n))
    .get();
  return row?.headSha == null ? undefined : { ...row, headSha: row.headSha };
}

/**
 * Whether the base the approved Integration Task head was verified on is no
 * longer `observedBaseSha` (read-only). `false` when the Task is not approved:
 * there is nothing approved to go stale.
 */
export function baseMoved(db: FactoryDb | Tx, taskId: string, observedBaseSha: string): boolean {
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (task?.kind !== 'integration' || task.state !== 'approved') return false;
  const approved = passedAttemptOf(db, taskId);
  return approved !== undefined && approved.baseSha !== observedBaseSha;
}

/**
 * The default branch moved from the approved Integration Task's base to
 * `observedBaseSha` (C2): in the caller's versioned Job transaction, every
 * Gate result for the old `(head, base)` goes stale. The open `merge` items
 * and the Blocker items `merge_approval` holds are superseded; each of
 * `integration_review`, `pull_request`, `merge_approval`, `merge` that had
 * started is superseded if still in progress and gets an `attempt + 1` Stage
 * Run (reason `base_moved`); the new `integration_review` runs. The Task goes
 * `approved → changes_requested → ready` with a base merge requested, so its
 * next Attempt merges the base in. `false` (nothing changes) when the Task is
 * not approved or its base did not move.
 */
export function startBaseMergeIn(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: { taskId: string; observedBaseSha: string; seen: BaseCheck; actor: string },
): boolean {
  const { taskId, observedBaseSha, actor } = input;
  if (!baseMoved(tx, taskId, observedBaseSha)) return false;
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  const approved = passedAttemptOf(tx, taskId);
  const review = latestStageRun(state, 'integration_review');
  if (task === undefined || approved === undefined || review === undefined) return false;
  const jobId = task.jobId;
  const reason = `the default branch moved from ${approved.baseSha} to ${observedBaseSha} (seen ${SEEN[input.seen]}): every Gate result for head ${approved.headSha} on base ${approved.baseSha} is stale, and the base is merged into the Integration Branch`;

  const added = rerunDeliveryStages(tx, state, step, { jobId, actor, reason, cause: 'base_moved' });

  const op = { jobId, actor };
  const at = { headSha: approved.headSha, baseSha: approved.baseSha };
  const sent = stepTask(tx, op, task, 'changes_requested', {
    reason: 'base_moved',
    payload: { fromBaseSha: approved.baseSha, toBaseSha: observedBaseSha },
  });
  stepTask(tx, op, sent, 'ready', {
    reason: 'base_moved',
    payload: { baseMerge: true, toBaseSha: observedBaseSha },
  });
  tx.update(schema.tasks)
    .set({ baseMergeRequested: true })
    .where(eq(schema.tasks.id, taskId))
    .run();
  appendEvent(tx, {
    entityKind: 'task',
    entityId: taskId,
    jobId,
    type: 'task.base_moved',
    actor,
    payload: {
      seen: input.seen,
      headSha: at.headSha,
      fromBaseSha: at.baseSha,
      toBaseSha: observedBaseSha,
      // What went stale: the Gate results recorded for the old (head, base).
      stale: staleGateResults(tx, approved),
      stageRuns: added,
    },
  });
  return true;
}

/**
 * A new head on the Integration Branch makes every Gate result of the old one
 * stale (a moved base, ADR-0041; a foreign push, ADR-0042). In the caller's
 * Job transaction: the open `merge` items and the Blocker items
 * `merge_approval` holds are superseded, and each of `integration_review`,
 * `pull_request`, `merge_approval`, `merge` that had started is superseded if
 * still in progress and gets an `attempt + 1` Stage Run (`cause` its reason);
 * the new `integration_review` runs. Returns the Stage Runs added.
 */
export function rerunDeliveryStages(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: { jobId: string; actor: string; reason: string; cause: 'base_moved' | 'foreign_push' },
): { stageId: string; attempt: number }[] {
  const { jobId, actor, reason } = input;
  supersedeMergeItems(tx, jobId, actor, reason);
  const holder = latestStageRun(state, 'merge_approval');
  if (holder !== undefined) supersedeHeldBlockerItems(tx, holder, actor, reason);
  const added: { stageId: string; attempt: number }[] = [];
  for (const stageId of RERUN_STAGES) {
    const run = latestStageRun(state, stageId);
    if (run === undefined || run.state === 'pending') continue;
    if (SUPERSEDABLE.has(run.state)) step(run, 'superseded', { reason });
    const next = addStageRun(tx, jobId, run, actor, input.cause);
    added.push({ stageId, attempt: next.attempt });
    if (stageId === 'integration_review') {
      step(next, 'queued', { reason });
      const queued = tx
        .select()
        .from(schema.stageRuns)
        .where(eq(schema.stageRuns.id, next.id))
        .get();
      if (queued === undefined) throw new Error(`no Stage Run ${next.id}`);
      step(queued, 'running');
    }
  }
  return added;
}

/** The Gate results recorded for the approved Attempt's `(head, base)`, counted: all stale now. */
export function staleGateResults(tx: Tx, approved: AttemptRow & { headSha: string }) {
  const on = (table: typeof schema.evidence | typeof schema.verificationRuns) =>
    and(
      eq(table.attemptId, approved.id),
      eq(table.headSha, approved.headSha),
      eq(table.baseSha, approved.baseSha),
    );
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  return {
    verificationRuns: n(
      tx
        .select({ n: count() })
        .from(schema.verificationRuns)
        .where(on(schema.verificationRuns))
        .all(),
    ),
    evidence: n(tx.select({ n: count() }).from(schema.evidence).where(on(schema.evidence)).all()),
    reviews: n(
      tx
        .select({ n: count() })
        .from(schema.reviews)
        .where(
          and(
            eq(schema.reviews.attemptId, approved.id),
            eq(schema.reviews.headSha, approved.headSha),
            eq(schema.reviews.baseSha, approved.baseSha),
          ),
        )
        .all(),
    ),
  };
}

export type BaseMergeIn =
  | { kind: 'merged'; headSha: string; baseSha: string; merged: boolean }
  | { kind: 'conflict'; baseSha: string; paths: string[] };

/**
 * Merges `baseSha` into the Integration Branch head `headSha` in `clone`: one
 * merge commit with parents (head, base), never a rebase. Nothing to merge
 * when the base is already in the head (`merged: false`). Only objects are
 * written. Call under the clone's setup lock.
 */
export async function mergeBaseIn(
  clone: string,
  input: { headSha: string; baseSha: string; defaultBranch: string; integrationBranch: string },
): Promise<BaseMergeIn> {
  const { headSha, baseSha } = input;
  if (await isAncestor(clone, baseSha, headSha)) {
    return { kind: 'merged', headSha, baseSha, merged: false };
  }
  const result = await mergeCommits(clone, headSha, baseSha);
  if (result.kind === 'conflict') return { kind: 'conflict', baseSha, paths: result.paths };
  const merged = await commitTree(
    clone,
    result.tree,
    [headSha, baseSha],
    `Merge ${input.defaultBranch} (${baseSha}) into ${input.integrationBranch}\n\nFactory-Base-Merge: ${baseSha}`,
  );
  return { kind: 'merged', headSha: merged, baseSha, merged: true };
}

/**
 * Blocks the `claimed` Integration Task whose base merge-in conflicts, in one
 * transaction: the human Blocker `base_merge_conflict` (its Blocker Approval,
 * replan or cancel the Job, opened by `stepTask`, with the conflict as the
 * replan feedback), the request cleared, its lease and tokens released, and
 * `integration_review` settled. No Attempt was made: the Blocker names the
 * Task itself as its subject (as an integration conflict does, ADR-0034).
 */
export function blockOnBaseMergeConflict(
  db: FactoryDb,
  op: { jobId: string; actor: string },
  taskId: string,
  conflict: {
    headSha: string;
    baseSha: string;
    paths: string[];
    defaultBranch: string;
    integrationBranch: string;
  },
): void {
  changeJob(
    db,
    { jobId: op.jobId, expectedVersion: 'current', actor: op.actor },
    (tx, state, step) => {
      const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
      if (task?.state !== 'claimed') {
        throw new Error(`Task ${taskId} is ${String(task?.state)}, not claimed`);
      }
      const where = conflict.paths.length === 0 ? 'the merge' : conflict.paths.join(', ');
      const blocker: Blocker = {
        kind: 'human',
        reason: 'base_merge_conflict',
        detail: `merging the moved default branch ${conflict.defaultBranch} (${conflict.baseSha}) into ${conflict.integrationBranch} at ${conflict.headSha} conflicts in ${where}`,
        requiredAction:
          'decide the Blocker Approval in the Inbox: replan (the conflict becomes the feedback) or cancel the Job',
        taskId,
        attemptId: taskId,
        createdAt: new Date().toISOString(),
      };
      stepTask(tx, op, task, 'blocked', {
        reason: blocker.reason,
        payload: {
          baseMerge: true,
          headSha: conflict.headSha,
          baseSha: conflict.baseSha,
          paths: conflict.paths,
        },
        blocker,
      });
      tx.update(schema.tasks)
        .set({ baseMergeRequested: false })
        .where(eq(schema.tasks.id, taskId))
        .run();
      releaseAttemptTokens(tx, taskId, undefined);
      settleIntegration(tx, state, step);
    },
  );
}

/** The approving Integration Review of `attempt` on its own `(head, base)`, if any. */
function approvingReviewOf(db: FactoryDb | Tx, attempt: AttemptRow & { headSha: string }) {
  return db
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.attemptId, attempt.id),
        eq(schema.reviews.headSha, attempt.headSha),
        eq(schema.reviews.baseSha, attempt.baseSha),
        eq(schema.reviews.outcome, 'approved'),
      ),
    )
    .get();
}

/** What the base merge Attempt's review step does: re-anchor `original`, or run the Integration Review. */
export type BaseMergeReview = ReanchorDecision & {
  original: ReviewRow | undefined;
  patchIdBefore: string | null;
  patchIdAfter: string | null;
};

/**
 * Decides, for the `base_merge` Attempt `attempt` (its head and base the
 * merged-in ones), whether the approving Integration Review of the Attempt
 * approved before it is re-anchored or the Integration Review runs again
 * (Q12): `git patch-id --stable` of the diff from the merge-base to the head,
 * before and after, by the pure `reanchorDecision` under the Job's
 * `review.rerunOnBaseChange`. Deterministic: a resumed review decides the same.
 */
export async function baseMergeReview(
  db: FactoryDb,
  clone: string,
  attempt: AttemptRow & { headSha: string },
): Promise<BaseMergeReview> {
  const before = passedAttemptOf(db, attempt.taskId, attempt.n);
  if (before === undefined) {
    throw new Error(`base merge Attempt ${attempt.id} has no approved Attempt before it`);
  }
  const job = db
    .select({ config: schema.jobs.configSnapshotJson })
    .from(schema.jobs)
    .innerJoin(schema.tasks, eq(schema.tasks.jobId, schema.jobs.id))
    .where(eq(schema.tasks.id, attempt.taskId))
    .get();
  if (job === undefined) throw new Error(`Attempt ${attempt.id} has no Job`);
  const policy = EffectiveConfigSchema.parse(JSON.parse(job.config)).reviewRerunOnBaseChange.value;
  const original = approvingReviewOf(db, before);
  const patchIdBefore = await diffPatchId(clone, before.baseSha, before.headSha);
  const patchIdAfter = await diffPatchId(clone, attempt.baseSha, attempt.headSha);
  const decision = reanchorDecision({
    patchIdBefore,
    patchIdAfter,
    policy,
    original: original ?? null,
  });
  return { ...decision, original, patchIdBefore, patchIdAfter };
}
