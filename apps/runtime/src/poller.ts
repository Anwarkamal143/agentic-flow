/**
 * The GitHub poller (#58, ADR-0037; Q23). Every `github.pollIntervalMs`
 * (default 30 s) it reads each PR whose Job waits in `merge_approval`: the
 * PR (state, head, base, `mergeable_state`, merge), the check runs and commit
 * statuses on its head, and its reviews. ETags are kept in memory only and
 * sent as `If-None-Match`; a 304 reuses the value read before. What it saw is
 * written only when it changed (`recordPoll`); a quiet poll writes nothing but
 * `last_polled_at`.
 *
 * A default branch that moved under the head the factory pushed is merged
 * into the Integration Branch (C2, ADR-0041; `startBaseMergeIn`). A head the
 * factory did not push is fetched, verified and reviewed again, never
 * overwritten (#63, ADR-0042; `startForeignPushAdoption`).
 *
 * When the PR body's rendering differs from the one the factory last sent
 * (the CI section follows the checks), the body is PATCHed. A failed read
 * writes nothing; the next poll tries again (the GitHub-wide pause and
 * backoff are #66's).
 */
import { appendEvent, schema, type FactoryDb } from '@factory/db';
import {
  observedChecks,
  renderPullRequestBody,
  unresolvedChangeRequests,
  type MergeGate,
  type ObservedCheck,
  type PullRequestBodyInput,
  type Redactor,
} from '@factory/domain';
import type { GitHubPort, GitHubRead } from '@factory/github';
import { and, desc, eq } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { changeJob, readJobState } from './engine.js';
import {
  assessPoll,
  ciBlockerStep,
  POLLER,
  recordPoll,
  trackedPullRequests,
  type Observation,
} from './merge-approval.js';
import { PassLoop } from './pass-loop.js';
import {
  describeTriggers,
  feedbackItems,
  recordFeedback,
  startFeedbackRework,
  unseenFeedback,
} from './pr-feedback.js';
import { latestStageRun } from './replan.js';
import { bodyHash, pullRequestBodyInput } from './pull-request.js';
import { baseMoved, defaultBranchTip, startBaseMergeIn } from './base-change.js';
import { foreignPushed, startForeignPushAdoption } from './foreign-push.js';

type PullRequestRow = typeof schema.pullRequests.$inferSelect;

export interface PollerDeps {
  db: FactoryDb;
  github: GitHubPort;
  artifacts: ArtifactStore;
  redact: Redactor;
  pollIntervalMs: number;
  checksGraceMs: number;
  onCommit: () => void;
  log: (message: string) => void;
}

/** A failed read: the poll stops for this PR, writing nothing. */
class ReadFailed extends Error {}

export class GitHubPoller {
  private readonly loop: PassLoop;
  /** The last ETag and value of each read, by its key. In memory only: a restart reads afresh. */
  private readonly seen = new Map<string, { etag: string; value: unknown }>();

  constructor(private readonly deps: PollerDeps) {
    this.loop = new PassLoop(() => this.pass(), deps.pollIntervalMs);
  }

  start(): void {
    this.loop.start();
  }

  async close(): Promise<void> {
    this.loop.halt();
    await this.loop.idle();
  }

  /** One poll of every tracked PR. Never "worked": the timer drives the next one. */
  private async pass(): Promise<boolean> {
    for (const pr of trackedPullRequests(this.deps.db)) {
      try {
        await this.poll(pr);
      } catch (err) {
        if (!(err instanceof ReadFailed)) throw err;
        this.deps.log(`github poller: ${pr.owner}/${pr.name}#${String(pr.number)}: ${err.message}`);
      }
    }
    return false;
  }

  /** A read through the ETag cache: on 304 the value read before is reused. */
  private async read<T>(key: string, get: (etag?: string) => Promise<GitHubRead<T>>): Promise<T> {
    const cached = this.seen.get(key);
    const res = await get(cached?.etag);
    if (!res.ok) {
      const f = res.failure;
      throw new ReadFailed(
        f.kind === 'rate_limited' ? `rate limited until ${f.resetAt}` : `${f.kind}: ${f.reason}`,
      );
    }
    if (res.notModified) {
      if (cached === undefined) throw new ReadFailed('304 without a value read before');
      return cached.value as T;
    }
    if (res.etag !== null) this.seen.set(key, { etag: res.etag, value: res.value });
    return res.value;
  }

  private async poll(row: PullRequestRow): Promise<void> {
    const { github } = this.deps;
    const repo = { owner: row.owner, name: row.name };
    // First, so the window between GitHub's reads and the poll's write stays as short as before.
    const tip = await this.defaultTip(row);
    const pr = await this.read(`pr:${row.id}`, (etag) =>
      github.getPullRequest(repo, row.number, etag === undefined ? {} : { etag }),
    );
    const head = pr.head.sha;
    const runs = await this.read(`runs:${row.id}:${head}`, (etag) =>
      github.listCheckRuns(repo, head, etag === undefined ? {} : { etag }),
    );
    const statuses = await this.read(`statuses:${row.id}:${head}`, (etag) =>
      github.listCommitStatuses(repo, head, etag === undefined ? {} : { etag }),
    );
    const reviews = await this.read(`reviews:${row.id}`, (etag) =>
      github.listReviews(repo, row.number, etag === undefined ? {} : { etag }),
    );
    const comments = await this.read(`comments:${row.id}`, (etag) =>
      github.listIssueComments(repo, row.number, etag === undefined ? {} : { etag }),
    );
    const reviewComments = await this.read(`review-comments:${row.id}`, (etag) =>
      github.listReviewComments(repo, row.number, etag === undefined ? {} : { etag }),
    );
    const feedback = feedbackItems(reviews, comments, reviewComments);
    const seen: Observation = {
      state: pr.merged ? 'merged' : pr.state,
      headSha: head,
      baseSha: pr.base.sha,
      mergeableState: pr.mergeableState,
      mergeSha: pr.merged ? pr.mergeCommitSha : null,
      checks: observedChecks(runs, statuses),
      changesRequestedBy: unresolvedChangeRequests(reviews),
    };

    const opts = { now: new Date().toISOString(), graceMs: this.deps.checksGraceMs };
    const { db } = this.deps;
    const before = db
      .select()
      .from(schema.pullRequests)
      .where(eq(schema.pullRequests.id, row.id))
      .get();
    // The row changed while GitHub was read (the PR was updated in place, ADR-0039, ADR-0041):
    // what was read may predate it, so nothing is recorded; the next poll reads afresh.
    if (before === undefined || before.version !== row.version) return;
    const assessed = assessPoll(db, before, seen, opts);
    let gate: MergeGate = assessed.gate;
    // The default branch moved under the head the factory pushed (C2): merge it in (ADR-0041).
    // Either read may show the move first (the tip is read before the PR): either one counts.
    // Someone else pushed to the Integration Branch (#63): fetch and verify it (ADR-0042).
    const foreign =
      seen.state === 'open' &&
      foreignPushed(db, { taskId: before.taskId, pushedSha: before.pushedSha, headSha: head });
    const moved =
      seen.state === 'open' && seen.headSha === before.pushedSha
        ? [tip, seen.baseSha].find((b) => b !== undefined && baseMoved(db, before.taskId, b))
        : undefined;
    const quiet =
      !foreign &&
      moved === undefined &&
      assessed.changes.length === 0 &&
      !assessed.gateChanged &&
      !assessed.itemsStale &&
      // A ci_failed Blocker out of step with the checks (#61), e.g. none open after a re-run.
      ciBlockerStep(db, row.jobId).kind === 'none' &&
      unseenFeedback(db, row.id, feedback).length === 0;
    if (quiet) {
      // A quiet poll: nothing new, so no event and no Job change; only when it was read.
      db.update(schema.pullRequests)
        .set({ lastPolledAt: opts.now })
        .where(eq(schema.pullRequests.id, row.id))
        .run();
    } else {
      const recorded = changeJob(
        db,
        { jobId: row.jobId, expectedVersion: 'current', actor: POLLER },
        (tx, state, step) => {
          // The Job may have been cancelled since the PR was picked: then nothing is recorded.
          const holder = latestStageRun(state, 'merge_approval');
          if (holder?.state !== 'waiting_human') return undefined;
          // New feedback first: a trigger supersedes merge_approval before the poll is recorded.
          const pr = tx
            .select()
            .from(schema.pullRequests)
            .where(eq(schema.pullRequests.id, row.id))
            .get();
          if (pr === undefined) return undefined;
          // A foreign push goes first: its head is verified and reviewed before anything else.
          // Feedback is left unrecorded, so a poll once the PR is updated reads it as new.
          if (
            foreign &&
            startForeignPushAdoption(tx, state, step, {
              taskId: pr.taskId,
              pushedSha: pr.pushedSha,
              foreignHeadSha: head,
              actor: POLLER,
            })
          ) {
            const polled = recordPoll(tx, row.id, seen, opts, step, readJobState(tx, row.jobId));
            return { gate: polled, reworked: true };
          }
          const triggers = recordFeedback(tx, pr, unseenFeedback(tx, row.id, feedback), {
            redact: this.deps.redact,
            now: opts.now,
            actor: POLLER,
          });
          const reworked =
            triggers.length > 0 &&
            seen.state === 'open' &&
            startFeedbackRework(tx, state, step, {
              pr,
              actor: POLLER,
              why: describeTriggers(triggers),
            });
          // Feedback goes first; a move it left is caught by a poll after the update.
          const merging =
            !reworked &&
            moved !== undefined &&
            startBaseMergeIn(tx, state, step, {
              taskId: pr.taskId,
              observedBaseSha: moved,
              seen: 'poll',
              actor: POLLER,
            });
          const polled = recordPoll(tx, row.id, seen, opts, step, readJobState(tx, row.jobId));
          return { gate: polled, reworked: reworked || merging };
        },
      );
      this.deps.onCommit();
      // A Rework or a base merge-in re-renders the body when it updates the PR (the next pull_request).
      if (recorded === undefined || recorded.reworked) return;
      gate = recorded.gate;
    }
    if (seen.state === 'open') await this.updateBody(row.id, gate, seen.checks);
  }

  /**
   * The default branch's head on GitHub (`defaultBranchTip`, ARCHITECTURE §14):
   * the base check compares it, not the PR's `base.sha`. A failure is a failed read.
   */
  private async defaultTip(row: PullRequestRow): Promise<string | undefined> {
    const repository = this.deps.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, row.repositoryId))
      .get();
    if (repository === undefined) throw new Error(`no Repository ${row.repositoryId}`);
    try {
      return await defaultBranchTip(repository, { owner: row.owner, name: row.name });
    } catch (err) {
      const output = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
      throw new ReadFailed(
        `could not read ${repository.defaultBranch}: ${this.deps.redact(output)}`,
      );
    }
  }

  /**
   * PATCHes the PR body when the rendering from the persisted rows differs
   * from the body the factory last sent, then records its hash with
   * `pull_request.body_updated`.
   */
  private async updateBody(
    prId: string,
    gate: MergeGate,
    checks: readonly ObservedCheck[],
  ): Promise<void> {
    const { db, artifacts, redact, github } = this.deps;
    const row = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).get();
    if (row === undefined) return;
    const condition = gate.conditions.find((c) => c.id === 'checks');
    if (condition === undefined) return;
    const ci: PullRequestBodyInput['ci'] = {
      status: condition.status,
      reason: condition.reason,
      checks: checks.map((c) => ({ name: c.name, outcome: c.outcome, url: c.url })),
    };
    const body = renderedBody(db, artifacts, redact, row, ci);
    const hash = bodyHash(body);
    if (hash === row.bodySha256) return;
    const res = await github.updatePullRequest({ owner: row.owner, name: row.name }, row.number, {
      body,
    });
    if (!res.ok) {
      this.deps.log(
        `github poller: could not update the body of ${row.owner}/${row.name}#${String(row.number)}: ${res.failure.kind}`,
      );
      return;
    }
    db.transaction((tx) => {
      tx.update(schema.pullRequests)
        .set({ bodySha256: hash })
        .where(eq(schema.pullRequests.id, prId))
        .run();
      appendEvent(tx, {
        entityKind: 'pull_request',
        entityId: prId,
        jobId: row.jobId,
        type: 'pull_request.body_updated',
        actor: POLLER,
        payload: { number: row.number, headSha: row.headSha, checks: ci.status },
      });
    });
    this.deps.onCommit();
  }
}

function renderedBody(
  db: FactoryDb,
  artifacts: ArtifactStore,
  redact: Redactor,
  row: PullRequestRow,
  ci: PullRequestBodyInput['ci'],
): string {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, row.jobId)).get();
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get();
  const attempt = db
    .select()
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, row.taskId), eq(schema.attempts.state, 'passed')))
    .orderBy(desc(schema.attempts.n))
    .get();
  if (job === undefined || task === undefined || attempt?.headSha == null) {
    throw new Error(`pull request ${row.id} has no approved Integration Task`);
  }
  return renderPullRequestBody(
    pullRequestBodyInput(db, artifacts, job, task, { ...attempt, headSha: attempt.headSha }, ci),
    redact,
  );
}
