/**
 * The `closure` Stage (ARCHITECTURE §7): the Delivery Report, then Worktree
 * removal. The Task scheduler runs it in its one slot, before any new claim.
 */
import { appendEvent, schema, type FactoryDb } from '@factory/db';
import { removeWorktree } from '@factory/git';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { buildDeliveryReport } from './delivery.js';
import { changeJob, stepWorktree, type JobState } from './engine.js';
import { requireWorktree } from './worktree.js';

/** The Task scheduler, which runs closure. */
const ACTOR = 'system:scheduler';

/** Where the test-only fault injection (`FACTORY_TEST_CRASH_AT`) can kill the runtime. */
export const CRASH_POINTS = ['closure.after_report'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export interface ClosureDeps {
  db: FactoryDb;
  artifacts: ArtifactStore;
  onCommit: () => void;
  /**
   * Test-only fault injection: the runtime kills itself (SIGKILL) at this
   * point. Unset in normal use. `closure.after_report`: once the Delivery
   * Report is recorded.
   */
  crashAt?: CrashPoint | undefined;
}

/** The closures a previous runtime left `running`, to resume. */
export function runningClosures(db: FactoryDb): { id: string; jobId: string }[] {
  return db
    .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.stageId, 'closure'), eq(schema.stageRuns.state, 'running')))
    .all();
}

/** The oldest Job's queued closure. */
export function nextClosure(db: FactoryDb): { id: string; jobId: string } | undefined {
  return db
    .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
    .from(schema.stageRuns)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
    .where(and(eq(schema.stageRuns.stageId, 'closure'), eq(schema.stageRuns.state, 'queued')))
    .orderBy(asc(schema.jobs.createdAt))
    .limit(1)
    .get();
}

/**
 * Writes the Delivery Report, then removes the Worktrees of the Job's
 * approved Tasks (their branches stay in the Factory Clone), then completes
 * `closure`. A Worktree that git refuses to remove stays `preserved`. After a
 * failed execution (ADR-0028), the failed Tasks' Worktrees hold unreviewed
 * work and stay `preserved`.
 */
export async function runClosure(
  deps: ClosureDeps,
  stageRunId: string,
  jobId: string,
  from: 'queued' | 'running',
): Promise<void> {
  const { db } = deps;
  if (from === 'queued') {
    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
      step(requireStageRun(state, stageRunId, 'queued'), 'running');
    });
    deps.onCommit();
  }

  // A closure that stopped after recording its report resumes from that report:
  // it is never written twice.
  const existing = deps.artifacts.listForJob(jobId).find((a) => a.kind === 'report');
  if (existing === undefined) {
    const content = deps.artifacts.writeContent(await buildDeliveryReport(db, jobId));
    db.transaction(
      (tx) => {
        deps.artifacts.record(tx, { jobId, kind: 'report', content }, ACTOR);
      },
      { behavior: 'immediate' },
    );
    deps.onCommit();
    if (deps.crashAt === 'closure.after_report') process.kill(process.pid, 'SIGKILL');
  }

  // Removal only after delivery: the branches hold the work, the report says where.
  const preserved = db
    .select({ worktree: schema.worktrees })
    .from(schema.worktrees)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.worktrees.taskId))
    .where(
      and(
        eq(schema.worktrees.jobId, jobId),
        eq(schema.worktrees.state, 'preserved'),
        inArray(schema.tasks.state, ['approved', 'integrated']),
      ),
    )
    .all()
    .map((r) => r.worktree);
  for (const worktree of preserved) {
    const repo = db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, worktree.repositoryId))
      .get();
    try {
      if (repo === undefined) throw new Error('no Repository');
      await removeWorktree(repo.clonePath, worktree.path);
    } catch (err) {
      db.transaction((tx) => {
        appendEvent(tx, {
          entityKind: 'worktree',
          entityId: worktree.id,
          jobId,
          type: 'worktree.remove_failed',
          actor: ACTOR,
          payload: {
            path: worktree.path,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      });
      deps.onCommit();
      continue;
    }
    changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
      stepWorktree(
        tx,
        { jobId, actor: ACTOR },
        requireWorktree(tx, worktree.id),
        'preserved',
        'removed',
      );
    });
    deps.onCommit();
  }

  changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
    step(requireStageRun(state, stageRunId, 'running'), 'succeeded');
  });
  deps.onCommit();
}

/** Fails a running closure the factory itself could not carry through (`factory_error`). */
export function failClosure(
  deps: Pick<ClosureDeps, 'db' | 'onCommit'>,
  jobId: string,
  stageRunId: string,
  message: string,
): void {
  changeJob(deps.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
    const run = state.stageRuns.find((r) => r.id === stageRunId);
    if (run?.state !== 'running') return;
    step(run, 'failed', {
      failure: { reason: 'factory_error', message: `closure failed: ${message}`, issues: [] },
    });
  });
  deps.onCommit();
}

function requireStageRun(state: JobState, id: string, expected: string) {
  const run = state.stageRuns.find((r) => r.id === id);
  if (run?.state !== expected)
    throw new Error(`Stage Run ${id} is ${String(run?.state)}, not ${expected}`);
  return run;
}
