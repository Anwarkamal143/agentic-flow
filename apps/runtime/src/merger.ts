/**
 * The merger (#59, ADR-0038): runs the `merge` Stage under `human_approval`,
 * once a human approved the `merge` item. Woken by commits, and on a timer for
 * a merge a transient GitHub failure left running (or a crash: a `running`
 * merge is picked up again).
 *
 * For each PR of the Job it re-reads the PR first, never trusting the rows:
 * - already merged (by a human, or by a merge whose result a crash lost):
 *   recorded as merged with GitHub's merge SHA, never merged twice;
 * - closed, or its head or base no longer the approved SHAs: the approval is
 *   stale and `merge` fails (`delivery_failed`);
 * - otherwise merged with the Repository's method, pinned to the approved head
 *   (GitHub refuses if the head moved). A method GitHub refuses raises the
 *   `merge_method_refused` Blocker; a transient failure is retried later.
 */
import type { FactoryDb } from '@factory/db';
import type { GitHubPort, GitHubFailure } from '@factory/github';
import { changeJob, type JobState, type StageRunStepper } from './engine.js';
import type { Tx } from '@factory/db';

type ChangeBody = (tx: Tx, state: JobState, step: StageRunStepper) => unknown;
import {
  failMerge,
  label,
  MERGER,
  mergeStageRuns,
  pendingMerges,
  recordFactoryMerge,
  refuseMergeMethod,
  startMerge,
} from './merge-approval.js';
import { PassLoop } from './pass-loop.js';

export interface MergerDeps {
  db: FactoryDb;
  github: GitHubPort;
  /** How long a merge a transient failure left running waits before the next try. */
  retryMs: number;
  onCommit: () => void;
  log: (message: string) => void;
}

/** GitHub's answer when the repository's settings don't allow the method (REST: 405). */
const METHOD_NOT_ALLOWED = /not allowed/i;

export class Merger {
  private readonly loop: PassLoop;

  constructor(private readonly deps: MergerDeps) {
    this.loop = new PassLoop(() => this.pass(), deps.retryMs);
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

  /** Works on every queued or running `merge`; "worked" only when one finished or stopped. */
  private async pass(): Promise<boolean> {
    let worked = false;
    for (const run of mergeStageRuns(this.deps.db)) {
      if (await this.merge(run.jobId, run.id)) worked = true;
    }
    return worked;
  }

  private change<T>(jobId: string, body: (...args: Parameters<ChangeBody>) => T): T {
    const out = changeJob(this.deps.db, { jobId, expectedVersion: 'current', actor: MERGER }, body);
    this.deps.onCommit();
    return out;
  }

  /** `true` when the Stage left `running` (merged, waiting on a Blocker, or failed). */
  private async merge(jobId: string, runId: string): Promise<boolean> {
    const started = this.change(jobId, (tx, state, step) => startMerge(tx, state, step, runId));
    if (!started) return false;
    const { github, db } = this.deps;
    for (const { pr, method, approved } of pendingMerges(db, jobId)) {
      const repo = { owner: pr.owner, name: pr.name };
      const what = label(pr);
      if (approved === null) {
        this.change(jobId, (tx, state, step) => {
          failMerge(
            tx,
            state,
            step,
            `nothing was merged: ${what} moved after its merge was approved`,
          );
        });
        return true;
      }
      const read = await github.getPullRequest(repo, pr.number);
      if (!read.ok) return this.retryLater(what, 'read', read.failure);
      if (read.notModified) throw new Error('a read without an ETag answered 304');
      const seen = read.value;
      if (seen.merged) {
        this.change(jobId, (tx, state, step) => {
          recordFactoryMerge(tx, state, step, pr.id, seen.mergeCommitSha, 'already_merged');
        });
        continue;
      }
      const stale =
        seen.state !== 'open'
          ? `${what} was closed after the merge was approved`
          : seen.head.sha !== approved.headSha || seen.base.sha !== approved.baseSha
            ? `${what} moved after the merge was approved (head ${seen.head.sha}, base ${seen.base.sha}; approved head ${approved.headSha}, base ${approved.baseSha}): the approval is tied to those SHAs`
            : null;
      if (stale !== null) {
        this.change(jobId, (tx, state, step) => {
          failMerge(tx, state, step, `nothing was merged: ${stale}`);
        });
        return true;
      }
      const res = await github.mergePullRequest(repo, pr.number, {
        method,
        sha: approved.headSha,
      });
      if (res.ok) {
        this.change(jobId, (tx, state, step) => {
          recordFactoryMerge(tx, state, step, pr.id, res.value.sha, 'merged');
        });
        continue;
      }
      const f = res.failure;
      if (f.kind !== 'refused') return this.retryLater(what, 'merge', f);
      this.change(jobId, (tx, state, step) => {
        if (f.status === 405 && METHOD_NOT_ALLOWED.test(f.reason)) {
          refuseMergeMethod(tx, state, step, pr, method, f.reason);
        } else {
          failMerge(tx, state, step, `GitHub refused to merge ${what}: ${f.reason}`);
        }
      });
      return true;
    }
    return true;
  }

  /** A transient failure or a rate limit: the merge stays running and is tried again later. */
  private retryLater(what: string, op: string, f: GitHubFailure): false {
    this.deps.log(
      `merger: ${what}: the ${op} failed (${f.kind === 'rate_limited' ? `rate limited until ${f.resetAt}` : `${f.kind}: ${f.reason}`}); trying again later`,
    );
    return false;
  }
}
