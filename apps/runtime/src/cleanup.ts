/**
 * Cancel cleanup (PRODUCT_SPEC §12, ADR-0027): the one `cleanup` Inbox Item a
 * cancel opens once everything is stopped, its decision, and the discard
 * itself. A decision only records what the human chose; a discard's removals
 * are done afterwards by {@link CleanupWorker} from that persisted decision,
 * one Worktree at a time, each row moving to `removed` only once its
 * directory is gone. The Task Branches are never touched.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CLEANUP_DISCARD,
  CLEANUP_KEEP,
  CLEANUP_OPTIONS,
  cleanupItemText,
  InboxDecisionSchema,
  type ApprovalKind,
  type ExpiresPolicy,
} from '@factory/domain';
import { removeWorktree } from '@factory/git';
import { and, eq, notExists } from 'drizzle-orm';
import { changeJob, stepWorktree } from './engine.js';
import { newId } from './ids.js';
import { PassLoop } from './pass-loop.js';
import { requireWorktree } from './worktree.js';

type ApprovalRow = typeof schema.approvals.$inferSelect;

const KIND: ApprovalKind = 'cleanup';
/** The runtime itself does the removals the human decided. */
const ACTOR = 'system:runtime';
/** The worker also runs on a timer, so a discard left by a crash is resumed. */
const POLL_MS = 5_000;

/**
 * Opens the Job's one `cleanup` item, last in the cancel (after every Attempt
 * is stopped and recorded, the leases released, the Worktrees `preserved`
 * and the open items `cancelled`). Its subject is the Job. None is opened
 * when the Job has no preserved Worktree, or already has one. Returns its id.
 */
export function openCleanupItem(tx: Tx, jobId: string, actor: string): string | undefined {
  const existing = tx
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.kind, KIND)))
    .get();
  if (existing !== undefined) return undefined;
  const preserved = preservedWorktrees(tx, jobId);
  if (preserved.length === 0) return undefined;
  const id = newId('apr');
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  const { question, why } = cleanupItemText(preserved.length);
  tx.insert(schema.approvals)
    .values({
      id,
      jobId,
      stageRunId: null,
      kind: KIND,
      subjectRef: jobId,
      question,
      why,
      optionsJson: JSON.stringify(CLEANUP_OPTIONS),
      recommended: CLEANUP_KEEP,
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
    },
  });
  return id;
}

/**
 * Opens the cleanup item a crash kept a cancel from opening: for every
 * cancelled Job with a preserved Worktree and no cleanup item. Called at
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
    if (preservedWorktrees(db, job.id).length === 0) continue;
    changeJob(db, { jobId: job.id, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      if (openCleanupItem(tx, job.id, ACTOR) !== undefined) opened++;
    });
  }
  return opened;
}

/**
 * A `cleanup` decision, inside the decide transaction (the item is already
 * `decided`). `keep` changes nothing more. `discard` changes nothing yet
 * either: the decision is the durable request, and the {@link CleanupWorker}
 * does the removals after the commit.
 */
export function applyCleanupDecision(tx: Tx, item: ApprovalRow, option: string): void {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, item.jobId)).get();
  if (job?.status !== 'cancelled') {
    throw new Error(`cleanup item ${item.id} belongs to a Job that is not cancelled`);
  }
  if (option !== CLEANUP_KEEP && option !== CLEANUP_DISCARD) {
    throw new Error(`unknown cleanup option ${option}`);
  }
}

/**
 * Carries out every decided discard not yet completed: removes each of the
 * Job's preserved Worktrees (forced: the human chose to discard what is in
 * them), records it `removed`, and then `cleanup.completed` on the item. A
 * Worktree git can't remove stays `preserved` with a `worktree.remove_failed`
 * event, and is not retried until the next runtime start. Task Branches stay.
 */
export class CleanupWorker {
  private readonly loop: PassLoop;
  /** Items this runtime already carried out (or tried to). */
  private readonly done = new Set<string>();

  constructor(
    private readonly db: FactoryDb,
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
    const item = this.pendingDiscards().find((i) => !this.done.has(i.id));
    if (item === undefined) return false;
    this.done.add(item.id);
    try {
      await this.discard(item);
    } catch (err) {
      this.log(
        `cleanup: discard of ${item.id} stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  private pendingDiscards(): ApprovalRow[] {
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
      .filter(
        (row) =>
          row.decisionJson !== null &&
          InboxDecisionSchema.parse(JSON.parse(row.decisionJson)).option === CLEANUP_DISCARD,
      );
  }

  private async discard(item: ApprovalRow): Promise<void> {
    const { jobId } = item;
    const removed: string[] = [];
    const failed: string[] = [];
    for (const worktree of preservedWorktrees(this.db, jobId)) {
      const repo = this.db
        .select({ clonePath: schema.repositories.clonePath })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, worktree.repositoryId))
        .get();
      try {
        if (repo === undefined) throw new Error('no Repository');
        await removeWorktree(repo.clonePath, worktree.path, { force: true });
      } catch (err) {
        failed.push(worktree.id);
        this.db.transaction((tx) => {
          appendEvent(tx, {
            entityKind: 'worktree',
            entityId: worktree.id,
            jobId,
            type: 'worktree.remove_failed',
            actor: ACTOR,
            payload: {
              path: worktree.path,
              approvalId: item.id,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
        this.onCommit();
        continue;
      }
      changeJob(this.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
        stepWorktree(
          tx,
          { jobId, actor: ACTOR },
          requireWorktree(tx, worktree.id),
          'preserved',
          'removed',
          { approvalId: item.id, reason: 'discarded' },
        );
      });
      removed.push(worktree.id);
      this.onCommit();
    }
    if (failed.length > 0) return; // Retried at the next start; no completion recorded.
    this.db.transaction(
      (tx) => {
        appendEvent(tx, {
          entityKind: 'approval',
          entityId: item.id,
          jobId,
          type: 'cleanup.completed',
          actor: ACTOR,
          payload: { removed },
        });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
  }
}

function preservedWorktrees(db: FactoryDb | Tx, jobId: string) {
  return db
    .select()
    .from(schema.worktrees)
    .where(and(eq(schema.worktrees.jobId, jobId), eq(schema.worktrees.state, 'preserved')))
    .all();
}
