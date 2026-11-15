/**
 * The `pull_request` Stage (#57, C1, ADR-0036): once the Integration Review
 * approved the Integration Branch (or skipped by its rule), the factory makes
 * its first push of anything, `factory/<job-id>/integration` at the head that
 * was approved, and opens a PR from it to the default branch. The body is
 * rendered by plain code from persisted rows, redacted, and carries the Job's
 * hidden marker. Before creating a PR the factory looks one up by head branch:
 * it adopts a PR carrying the marker (a crash came between creating and
 * recording it) and never one without (`recovery_uncertain`). The
 * `pull_requests` row and its event are written in one transaction.
 *
 * A Repository with no GitHub coordinates opens no PR: with none to open,
 * `pull_request` is `skipped` ("no GitHub remote") and the Job is delivered
 * locally, as in Phase B.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  combineVerdicts,
  evidenceSource,
  EvidenceVerdictSchema,
  factoryMarker,
  InboxQuestionSchema,
  integrationBranch,
  isCurrent,
  PlanProposalSchema,
  PullRequestRecordSchema,
  pullRequestRecovery,
  pullRequestTitle,
  renderPullRequestBody,
  SpecificationProposalSchema,
  TaskDefinitionSchema,
  type Blocker,
  type GitHubCoordinates,
  type PullRequestBodyInput,
  type PullRequestRecord,
  type Redactor,
} from '@factory/domain';
import { git } from '@factory/git';
import type { GitHubFailure, GitHubPort, PullRequest } from '@factory/github';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { currentCriteria, currentSpec } from './criteria.js';
import type { CrashPoint } from './closure.js';
import { changeJob, readJobState, type JobState, type StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { integrationSources } from './integration.js';
import { latestArtifact } from './plan-approval.js';
import { openMergeApproval, skipMergeStages } from './merge-approval.js';
import { latestStageRun } from './replan.js';
import { describeTriggers, ensureComment, triggersAnswered } from './pr-feedback.js';
import { defaultBranchTip, startBaseMergeIn } from './base-change.js';
import { createHash } from 'node:crypto';

/** The Task scheduler, which runs this Stage. */
const ACTOR = 'system:scheduler';

type TaskRow = typeof schema.tasks.$inferSelect;
type AttemptRow = typeof schema.attempts.$inferSelect;
type RepositoryRow = typeof schema.repositories.$inferSelect;

/** The github.com git URL of a Repository's coordinates: what the factory pushes to. */
export function githubRemoteUrl(repo: GitHubCoordinates): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/** `owner/name`, as messages and events name a GitHub repository. */
function repoLabel(repo: GitHubCoordinates): string {
  return `${repo.owner}/${repo.name}`;
}

function coordinatesOf(repo: RepositoryRow): GitHubCoordinates | null {
  return repo.githubOwner === null || repo.githubName === null
    ? null
    : { owner: repo.githubOwner, name: repo.githubName };
}

export type EnsuredPullRequest =
  | { kind: 'created' | 'adopted'; pr: PullRequest }
  /** A PR is on the head branch without this Job's marker: never adopted. */
  | { kind: 'uncertain'; pr: PullRequest }
  | { kind: 'failed'; failure: GitHubFailure };

/**
 * Opens the PR `request` describes, unless one is already on its head branch
 * (Q28): a PR carrying the Job's marker is adopted (the factory opened it and
 * stopped before recording it), one without is `uncertain`. Never writes to
 * GitHub when the lookup fails or finds a PR: `beforeCreate` (the push) runs
 * only once the lookup found none, so a foreign PR's branch is never pushed to.
 */
export async function ensurePullRequest(
  port: GitHubPort,
  repo: GitHubCoordinates,
  request: { jobId: string; head: string; base: string; title: string; body: string },
  beforeCreate: () => Promise<void> = () => Promise.resolve(),
): Promise<EnsuredPullRequest> {
  const found = await port.findPullRequestByHead(repo, request.head);
  if (!found.ok) return { kind: 'failed', failure: found.failure };
  const decision = pullRequestRecovery(found.value, request.jobId);
  if (found.value !== null) {
    return { kind: decision === 'adopt' ? 'adopted' : 'uncertain', pr: found.value };
  }
  await beforeCreate();
  const created = await port.createPullRequest(repo, {
    title: request.title,
    body: request.body,
    head: request.head,
    base: request.base,
  });
  return created.ok
    ? { kind: 'created', pr: created.value }
    : { kind: 'failed', failure: created.failure };
}

// ---- entering and leaving the Stage, in the transactions that settle the ones before it ----

/** The approved Integration Tasks of the Job's newest Plan, with their Repositories. */
function integrationTasksOf(tx: Tx | FactoryDb, jobId: string) {
  const plan = latestArtifact(tx, jobId, 'plan');
  return tx
    .select({ task: schema.tasks, repo: schema.repositories })
    .from(schema.tasks)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.tasks.repositoryId))
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        eq(schema.tasks.kind, 'integration'),
        eq(schema.tasks.planArtifactId, plan?.id ?? ''),
        eq(schema.tasks.state, 'approved'),
      ),
    )
    .orderBy(asc(sql`"tasks"."rowid"`))
    .all();
}

/**
 * The Integration Branch was approved (its Stage succeeded): queues the Job's
 * pending `pull_request`, or skips it with "no GitHub remote" when no
 * Repository it delivers to has GitHub coordinates. `true` when it was queued;
 * `false` when the caller queues closure (skipped, or no such Stage: a Job
 * created at `feature` v4 or earlier).
 */
export function startPullRequest(tx: Tx, jobId: string, step: StageRunStepper): boolean {
  const run = latestStageRun(readJobState(tx, jobId), 'pull_request');
  if (run?.state !== 'pending') return false;
  const remote = integrationTasksOf(tx, jobId).filter((r) => coordinatesOf(r.repo) !== null);
  if (remote.length === 0) {
    const reason =
      'no GitHub remote: the Repository has no GitHub coordinates, so the Job is delivered locally';
    step(run, 'skipped', { reason });
    skipMergeStages(readJobState(tx, jobId), step, reason);
    return false;
  }
  step(run, 'queued', { reason: 'the Integration Branch was approved' });
  return true;
}

/** Skips a pending `pull_request` of a Job whose integration did not succeed: there is nothing to open. */
export function skipPullRequest(state: JobState, step: StageRunStepper, reason: string): void {
  const run = latestStageRun(state, 'pull_request');
  if (run?.state === 'pending') step(run, 'skipped', { reason });
  skipMergeStages(state, step, reason);
}

// ---- the work ------------------------------------------------------------------------------

export interface PullRequestDeps {
  db: FactoryDb;
  artifacts: ArtifactStore;
  /** The GitHub port; the token reference is resolved per request. */
  github: GitHubPort;
  /** The runtime's redactor: the PR body is redacted before it is sent. */
  redact: Redactor;
  onCommit: () => void;
  log: (message: string) => void;
  /** `true` once the runtime is shutting down: the Stage is left `running` for the next start. */
  closed: () => boolean;
  /**
   * Test-only: `pull_request.after_create` kills the runtime once GitHub created the PR, before it
   * is recorded; `pull_request.after_comment`, once the factory's comment on an updated PR was
   * posted, before the update is recorded (ADR-0039).
   */
  crashAt?: CrashPoint | undefined;
  /** Waits between tries of a transient GitHub failure (ms); tests shorten it. */
  retryDelaysMs?: readonly number[];
}

/** How long to wait before each further try of a transient failure: 5 tries, about a minute. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 40_000];

/** The `pull_request` Stage Runs a previous runtime left `running`, to resume. */
export function runningPullRequests(db: FactoryDb): { id: string; jobId: string }[] {
  return db
    .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.stageId, 'pull_request'), eq(schema.stageRuns.state, 'running')))
    .all();
}

/** The oldest Job's queued `pull_request`. */
export function nextPullRequest(db: FactoryDb): { id: string; jobId: string } | undefined {
  return db
    .select({ id: schema.stageRuns.id, jobId: schema.stageRuns.jobId })
    .from(schema.stageRuns)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.stageRuns.jobId))
    .where(and(eq(schema.stageRuns.stageId, 'pull_request'), eq(schema.stageRuns.state, 'queued')))
    .orderBy(asc(schema.jobs.createdAt))
    .limit(1)
    .get();
}

/** Thrown out of the Stage's work: GitHub or git refused something retrying won't fix. */
class DeliveryFailed extends Error {}

/**
 * Pushes each approved Integration Branch whose Repository has GitHub
 * coordinates and opens (or adopts) its PR, recording each in
 * `pull_requests`; then `pull_request` succeeds and closure is queued. A PR
 * already recorded is not touched again, so a resumed Stage carries on where
 * it stopped. A PR without the marker on the head branch stops the Stage
 * `waiting_human` (`recovery_uncertain`); a refusal fails it (closure still
 * reports the local delivery).
 */
export async function runPullRequest(
  deps: PullRequestDeps,
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
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new Error(`no Job ${jobId}`);

  try {
    for (const { task, repo } of integrationTasksOf(db, jobId)) {
      const coordinates = coordinatesOf(repo);
      if (coordinates === null) continue; // delivered locally (the report says so)
      const branch = integrationBranch(jobId);
      const recorded = recordedPullRequest(db, jobId, repo.id, branch);
      const attempt = approvedAttempt(db, task);
      if (recorded !== undefined) {
        // Feedback was reworked (ADR-0039): the same PR is updated in place, once per new head.
        if (recorded.state !== 'open' || recorded.pushedSha === attempt.headSha) continue;
        if (!stillRunning(db, stageRunId) || deps.closed()) return;
        const updated = await updateInPlace(deps, {
          job,
          task,
          repo,
          coordinates,
          branch,
          recorded,
          attempt,
          stageRunId,
        });
        if (!updated) return; // shutting down: resumed at the next start
        continue;
      }
      if (!stillRunning(db, stageRunId) || deps.closed()) return;
      // Before the first push (C2, ADR-0041): a default branch that moved since the
      // Integration Branch was verified is merged in first; nothing stale is pushed.
      const tip = await remoteDefaultHead(deps.redact, repo, coordinates);
      if (tip !== attempt.baseSha) {
        const merging = changeJob(
          db,
          { jobId, expectedVersion: 'current', actor: ACTOR },
          (tx, state, step) =>
            startBaseMergeIn(tx, state, step, {
              taskId: task.id,
              observedBaseSha: tip,
              seen: 'pre_push',
              actor: ACTOR,
            }),
        );
        deps.onCommit();
        if (merging) return;
        throw new DeliveryFailed(
          `${repo.defaultBranch} of ${repoLabel(coordinates)} is at ${tip}, not the ${attempt.baseSha} the Integration Branch was verified on, and the base could not be merged in: nothing stale is pushed`,
        );
      }

      const body = renderPullRequestBody(
        pullRequestBodyInput(db, deps.artifacts, job, task, attempt),
        deps.redact,
      );
      // The first push of anything, only once no PR is on the branch (never a foreign PR's).
      const ensured = await withRetries(deps, () =>
        ensurePullRequest(
          deps.github,
          coordinates,
          {
            jobId,
            head: branch,
            base: repo.defaultBranch,
            title: pullRequestTitle(job.title),
            body,
          },
          () => push(deps.redact, repo.clonePath, coordinates, attempt.headSha, branch),
        ),
      );
      if (ensured === undefined) return; // shutting down: resumed at the next start
      if (ensured.kind === 'failed') {
        throw new DeliveryFailed(
          `GitHub refused the pull request for ${repoLabel(coordinates)}: ${deps.redact(describeFailure(ensured.failure))}`,
        );
      }
      if (ensured.kind === 'uncertain') {
        waitOnForeignPullRequest(deps, stageRunId, jobId, task, attempt, coordinates, ensured.pr);
        return;
      }
      if (ensured.kind === 'created' && deps.crashAt === 'pull_request.after_create') {
        process.kill(process.pid, 'SIGKILL');
      }
      recordPullRequest(deps, {
        jobId,
        task,
        repo,
        coordinates,
        branch,
        pushedSha: attempt.headSha,
        pr: ensured.pr,
        adopted: ensured.kind === 'adopted',
        body,
      });
    }
  } catch (err) {
    if (!(err instanceof DeliveryFailed)) throw err;
    failPullRequest(deps, jobId, stageRunId, err.message);
    return;
  }

  changeJob(db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx, state, step) => {
    const run = state.stageRuns.find((r) => r.id === stageRunId);
    if (run?.state !== 'running') return; // cancelled meanwhile
    step(run, 'succeeded');
    // merge_approval waits for the merge (feature v6); a v5 Job goes straight to closure.
    if (!openMergeApproval(tx, state, step)) queueClosure(state, step);
  });
  deps.onCommit();
}

/**
 * Fails a running `pull_request` the factory could not carry through
 * (`delivery_failed`, or `factory_error` from the scheduler's guard), and
 * queues closure so the local delivery is still reported.
 */
export function failPullRequest(
  deps: Pick<PullRequestDeps, 'db' | 'onCommit'>,
  jobId: string,
  stageRunId: string,
  message: string,
  reason: 'delivery_failed' | 'factory_error' = 'delivery_failed',
): void {
  changeJob(deps.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (_, state, step) => {
    const run = state.stageRuns.find((r) => r.id === stageRunId);
    if (run?.state !== 'running') return;
    step(run, 'failed', { failure: { reason, message, issues: [] } });
    skipMergeStages(state, step, 'the pull request could not be opened');
    queueClosure(state, step);
  });
  deps.onCommit();
}

function queueClosure(state: JobState, step: StageRunStepper): void {
  const closure = state.stageRuns.find((r) => r.stageId === 'closure' && r.state === 'pending');
  if (closure !== undefined) step(closure, 'queued');
}

function stillRunning(db: FactoryDb, stageRunId: string): boolean {
  return (
    db
      .select({ state: schema.stageRuns.state })
      .from(schema.stageRuns)
      .where(eq(schema.stageRuns.id, stageRunId))
      .get()?.state === 'running'
  );
}

/**
 * The first push of anything: the approved head to the Integration Branch on
 * GitHub, never forced. Run from the Factory Clone with git's own credentials
 * (the token reference is the REST API's; ADR-0036). A push GitHub or git
 * refuses (for example, a branch someone else moved) fails the Stage.
 */
async function push(
  redact: Redactor,
  clonePath: string,
  repo: GitHubCoordinates,
  sha: string,
  branch: string,
): Promise<void> {
  try {
    await git(['push', '--porcelain', githubRemoteUrl(repo), `${sha}:refs/heads/${branch}`], {
      cwd: clonePath,
    });
  } catch (err) {
    // git's output carries `remote:` lines GitHub wrote: untrusted, redacted, one line.
    const output = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
    throw new DeliveryFailed(`could not push ${branch} to ${repoLabel(repo)}: ${redact(output)}`);
  }
}

/**
 * The default branch's head on GitHub (`git ls-remote`, git's own credentials,
 * nothing fetched into the clone). A failure, or no such branch, fails the Stage.
 */
async function remoteDefaultHead(
  redact: Redactor,
  repo: RepositoryRow,
  coordinates: GitHubCoordinates,
): Promise<string> {
  let sha: string | undefined;
  try {
    sha = await defaultBranchTip(repo, coordinates);
  } catch (err) {
    const output = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
    throw new DeliveryFailed(
      `could not read ${repo.defaultBranch} of ${repoLabel(coordinates)} before the first push: ${redact(output)}`,
    );
  }
  if (sha === undefined) {
    throw new DeliveryFailed(
      `${repoLabel(coordinates)} has no ${repo.defaultBranch} branch to open a pull request against`,
    );
  }
  return sha;
}

/** Runs `tryOnce` until it is not a transient failure or the tries run out; `undefined` once shutting down. */
function withRetries<T extends { kind: string }>(
  deps: PullRequestDeps,
  tryOnce: () => Promise<T | { kind: 'failed'; failure: GitHubFailure }>,
): Promise<T | { kind: 'failed'; failure: GitHubFailure } | undefined> {
  return retryTransient(deps, tryOnce, (r) => ('failure' in r ? r.failure : undefined));
}

/** {@link withRetries} for a GitHub port call's result. */
function withResultRetries<R extends { ok: true } | { ok: false; failure: GitHubFailure }>(
  deps: PullRequestDeps,
  tryOnce: () => Promise<R>,
): Promise<R | undefined> {
  return retryTransient(deps, tryOnce, (r) => (r.ok ? undefined : r.failure));
}

async function retryTransient<R>(
  deps: PullRequestDeps,
  tryOnce: () => Promise<R>,
  failureOf: (result: R) => GitHubFailure | undefined,
): Promise<R | undefined> {
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let n = 0; ; n++) {
    const result = await tryOnce();
    const failure = failureOf(result);
    const delay = delays[n];
    if (failure === undefined || failure.kind === 'refused' || delay === undefined) {
      return result;
    }
    deps.log(
      `pull_request: GitHub ${describeFailure(failure)}; trying again in ${String(delay)} ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (deps.closed()) return undefined;
  }
}

/**
 * Updates the recorded PR in place after a feedback Rework (ADR-0039): the
 * new approved head is pushed to the Integration Branch (a fast-forward,
 * never forced), the body is rendered again and PATCHed, and a comment with
 * the marker `pull_request.updated:<stage run>` says what changed. Each step
 * can be redone: a push of the same head is a no-op, the PATCH sends the same
 * body, and the comment is looked up by its marker first. Then the row
 * records the new head, with no gate yet (the poller evaluates it again).
 * `false` once shutting down.
 */
async function updateInPlace(
  deps: PullRequestDeps,
  r: {
    job: typeof schema.jobs.$inferSelect;
    task: TaskRow;
    repo: RepositoryRow;
    coordinates: GitHubCoordinates;
    branch: string;
    recorded: typeof schema.pullRequests.$inferSelect;
    attempt: AttemptRow & { headSha: string };
    stageRunId: string;
  },
): Promise<boolean> {
  const { db, github } = deps;
  const { job, task, repo, coordinates, branch, recorded, attempt } = r;
  // Re-read first: nobody polled the PR while the Rework ran, so it may have been merged,
  // closed, or pushed to meanwhile. Nothing is pushed to a PR that is no longer the one we left.
  const fresh = await withResultRetries(deps, () =>
    github.getPullRequest(coordinates, recorded.number),
  );
  if (fresh === undefined) return false;
  if (!fresh.ok) {
    throw new DeliveryFailed(
      `could not re-read ${repoLabel(coordinates)}#${String(recorded.number)} before updating it: ${deps.redact(describeFailure(fresh.failure))}`,
    );
  }
  if (fresh.notModified) throw new Error('an unconditional read answered 304');
  const onGitHub = fresh.value;
  if (onGitHub.merged || onGitHub.state !== 'open') {
    throw new DeliveryFailed(
      `${repoLabel(coordinates)}#${String(recorded.number)} was ${onGitHub.merged ? 'merged' : 'closed'} on GitHub while the feedback was reworked: the Rework's head ${attempt.headSha} was not pushed`,
    );
  }
  if (onGitHub.head.sha !== recorded.pushedSha && onGitHub.head.sha !== attempt.headSha) {
    throw new DeliveryFailed(
      `${repoLabel(coordinates)}#${String(recorded.number)} has head ${onGitHub.head.sha}, not the ${recorded.pushedSha} the factory pushed: someone else pushed to ${branch}, so the Rework was not pushed over it`,
    );
  }
  await push(deps.redact, repo.clonePath, coordinates, attempt.headSha, branch);
  const body = renderPullRequestBody(
    pullRequestBodyInput(db, deps.artifacts, job, task, attempt),
    deps.redact,
  );
  const patched = await withResultRetries(deps, () =>
    github.updatePullRequest(coordinates, recorded.number, { body }),
  );
  if (patched === undefined) return false;
  if (!patched.ok) {
    throw new DeliveryFailed(
      `GitHub refused the body of ${repoLabel(coordinates)}#${String(recorded.number)}: ${deps.redact(describeFailure(patched.failure))}`,
    );
  }
  const pushedBefore = db
    .select({ n: schema.attempts.n })
    .from(schema.attempts)
    .where(
      and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.headSha, recorded.pushedSha)),
    )
    .orderBy(desc(schema.attempts.n))
    .get();
  const answered = triggersAnswered(db, task.id, pushedBefore?.n ?? 0);
  const marker = factoryMarker(job.id, `pull_request.updated:${r.stageRunId}`);
  const reanchored =
    currentReview(db, attempt)?.reanchoredFromReviewId != null
      ? 'the Integration Review was re-anchored to it (merging the base in left the reviewed diff unchanged, so no reviewer ran)'
      : 'the Integration Review passed on it';
  const why =
    answered.length === 0 && attempt.cause === 'base_merge'
      ? `the default branch moved: the factory merged ${repo.defaultBranch} (\`${attempt.baseSha}\`) into the Integration Branch with a merge commit (never a rebase)`
      : describeTriggers(answered);
  const text = [
    `The Software Factory updated this pull request in place after ${why}.`,
    `The Integration Branch moved from \`${recorded.pushedSha}\` to \`${attempt.headSha}\` (a fast-forward), the factory's commands passed on the new head, ${reanchored}, and the description was rendered again. The Merge Gate is evaluated again on it.`,
    '',
    marker,
    '',
  ].join('\n');
  const commented = await withRetries(deps, () =>
    ensureComment(github, coordinates, recorded.number, marker, deps.redact(text)),
  );
  if (commented === undefined) return false;
  if (commented.kind === 'failed') {
    throw new DeliveryFailed(
      `GitHub refused the factory's comment on ${repoLabel(coordinates)}#${String(recorded.number)}: ${deps.redact(describeFailure(commented.failure))}`,
    );
  }
  if (commented.kind === 'created' && deps.crashAt === 'pull_request.after_comment') {
    process.kill(process.pid, 'SIGKILL');
  }
  const now = new Date().toISOString();
  changeJob(db, { jobId: job.id, expectedVersion: 'current', actor: ACTOR }, (tx) => {
    const updated = tx
      .update(schema.pullRequests)
      .set({
        pushedSha: attempt.headSha,
        headSha: attempt.headSha,
        // The base as GitHub said in the re-read: a merged-in base (ADR-0041) is recorded too.
        baseSha: onGitHub.base.sha,
        headSeenAt: now,
        mergeableState: null,
        gateJson: null,
        gateEvaluatedAt: null,
        bodySha256: bodyHash(body),
        version: sql`${schema.pullRequests.version} + 1`,
      })
      .where(
        and(
          eq(schema.pullRequests.id, recorded.id),
          eq(schema.pullRequests.version, recorded.version),
        ),
      )
      .run();
    if (updated.changes !== 1)
      throw new Error(`pull request ${recorded.id} changed under its update`);
    appendEvent(tx, {
      entityKind: 'pull_request',
      entityId: recorded.id,
      jobId: job.id,
      type: 'pull_request.updated',
      actor: ACTOR,
      payload: {
        number: recorded.number,
        fromSha: recorded.pushedSha,
        headSha: attempt.headSha,
        commentId: commented.comment.id,
        comment: commented.kind,
        answers: answered.map((f) => f.id),
      },
    });
  });
  deps.onCommit();
  return true;
}

function describeFailure(failure: GitHubFailure): string {
  switch (failure.kind) {
    case 'rate_limited':
      return `rate limited until ${failure.resetAt}`;
    case 'transient':
    case 'refused':
      return `${failure.kind}${failure.status === null ? '' : ` (${String(failure.status)})`}: ${failure.reason}`;
  }
}

/** The SHA-256 of a PR body, to tell whether a re-rendering differs from what was sent. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The pull request recorded for (Job, Repository, head branch), if any. */
function recordedPullRequest(db: FactoryDb, jobId: string, repositoryId: string, branch: string) {
  return db
    .select()
    .from(schema.pullRequests)
    .where(
      and(
        eq(schema.pullRequests.jobId, jobId),
        eq(schema.pullRequests.repositoryId, repositoryId),
        eq(schema.pullRequests.headBranch, branch),
      ),
    )
    .get();
}

/** The Integration Task's passed Attempt: the head the Integration Review approved (or its skip rule). */
function approvedAttempt(db: FactoryDb, task: TaskRow): AttemptRow & { headSha: string } {
  const attempt = db
    .select()
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.state, 'passed')))
    .orderBy(desc(schema.attempts.n))
    .get();
  if (attempt?.headSha == null) {
    throw new Error(`approved Integration Task ${task.id} has no passed Attempt`);
  }
  return { ...attempt, headSha: attempt.headSha };
}

function recordPullRequest(
  deps: PullRequestDeps,
  r: {
    jobId: string;
    task: TaskRow;
    repo: RepositoryRow;
    coordinates: GitHubCoordinates;
    branch: string;
    pushedSha: string;
    pr: PullRequest;
    adopted: boolean;
    /** The body the factory sent (its hash tells the poller when a re-rendering differs). */
    body: string;
  },
): void {
  const id = newId('pr');
  const now = new Date().toISOString();
  changeJob(deps.db, { jobId: r.jobId, expectedVersion: 'current', actor: ACTOR }, (tx) => {
    tx.insert(schema.pullRequests)
      .values({
        id,
        jobId: r.jobId,
        repositoryId: r.repo.id,
        taskId: r.task.id,
        owner: r.coordinates.owner,
        name: r.coordinates.name,
        number: r.pr.number,
        url: r.pr.htmlUrl,
        state: r.pr.merged ? 'merged' : r.pr.state,
        headBranch: r.branch,
        baseBranch: r.pr.base.ref,
        headSha: r.pr.head.sha,
        baseSha: r.pr.base.sha,
        pushedSha: r.pushedSha,
        adopted: r.adopted,
        createdAt: now,
        lastPolledAt: null,
        headSeenAt: now,
        bodySha256: bodyHash(r.body),
        version: 0,
      })
      .run();
    appendEvent(tx, {
      entityKind: 'pull_request',
      entityId: id,
      jobId: r.jobId,
      type: r.adopted ? 'pull_request.adopted' : 'pull_request.opened',
      actor: ACTOR,
      payload: {
        repositoryId: r.repo.id,
        taskId: r.task.id,
        repository: repoLabel(r.coordinates),
        number: r.pr.number,
        url: r.pr.htmlUrl,
        head: r.branch,
        base: r.pr.base.ref,
        headSha: r.pr.head.sha,
        pushedSha: r.pushedSha,
      },
    });
  });
  deps.onCommit();
}

/**
 * A PR is on the head branch and doesn't carry this Job's marker: it is never
 * adopted. `pull_request` waits on a human Blocker `recovery_uncertain`
 * naming it. No Inbox Item offers a way on yet: cancelling the Job does
 * (ADR-0036, known limitation).
 */
function waitOnForeignPullRequest(
  deps: PullRequestDeps,
  stageRunId: string,
  jobId: string,
  task: TaskRow,
  attempt: AttemptRow,
  repo: GitHubCoordinates,
  pr: PullRequest,
): void {
  changeJob(deps.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx, state, step) => {
    const run = state.stageRuns.find((r) => r.id === stageRunId);
    if (run?.state !== 'running') return;
    const blocker: Blocker = {
      kind: 'human',
      reason: 'recovery_uncertain',
      detail: `${repoLabel(repo)} already has pull request #${String(pr.number)} (${pr.htmlUrl}, ${pr.state}) from ${pr.head.ref}, and it does not carry this Job's factory marker. The factory never adopts a pull request it can't show it opened.`,
      requiredAction: `close #${String(pr.number)} or rename its branch on GitHub and cancel this Job, or cancel the Job and keep the PR`,
      taskId: task.id,
      attemptId: attempt.id,
      createdAt: new Date().toISOString(),
    };
    step(run, 'waiting_human', { blocker });
    appendEvent(tx, {
      entityKind: 'job',
      entityId: jobId,
      jobId,
      type: 'pull_request.foreign_found',
      actor: ACTOR,
      payload: {
        repository: repoLabel(repo),
        number: pr.number,
        url: pr.htmlUrl,
        head: pr.head.ref,
      },
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

// ---- the body's inputs, from persisted rows ------------------------------------------------

/** The current review of an Attempt: on its own `(head_sha, base_sha)`. */
function currentReview(db: FactoryDb, attempt: AttemptRow) {
  if (attempt.headSha === null) return undefined;
  return db
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.attemptId, attempt.id),
        eq(schema.reviews.headSha, attempt.headSha),
        eq(schema.reviews.baseSha, attempt.baseSha),
      ),
    )
    .get();
}

/**
 * What the PR body shows, read from the rows the factory wrote: the current
 * Specification, the Evidence and commands of the Integration Task's approved
 * Attempt on the integration head, the Plan Tasks' risks, the approving
 * reviews' non-blocking Findings, the unanswered non-blocking questions, and
 * the Plan's rollback notes. Nothing is regenerated.
 */
export function pullRequestBodyInput(
  db: FactoryDb,
  artifacts: ArtifactStore,
  job: typeof schema.jobs.$inferSelect,
  task: TaskRow,
  attempt: AttemptRow & { headSha: string },
  /** The checks condition the poller recorded; `null` before the first poll. */
  ci: PullRequestBodyInput['ci'] = null,
): PullRequestBodyInput {
  const spec = currentSpec(db, job.id);
  if (spec === undefined) throw new Error(`Job ${job.id} has no current Specification`);
  const specification = SpecificationProposalSchema.parse(artifacts.readJson(spec.id));
  const plan = db.transaction((tx) => latestArtifact(tx, job.id, 'plan'));
  if (plan === undefined) throw new Error(`Job ${job.id} has no Plan`);
  const rollback = PlanProposalSchema.parse(artifacts.readJson(plan.id)).rollback ?? null;
  const at = { headSha: attempt.headSha, baseSha: attempt.baseSha };

  const runs = db
    .select()
    .from(schema.verificationRuns)
    .where(eq(schema.verificationRuns.attemptId, attempt.id))
    .orderBy(asc(sql`rowid`))
    .all();
  const evidence = db
    .select()
    .from(schema.evidence)
    .where(eq(schema.evidence.attemptId, attempt.id))
    .all()
    .filter((e) => isCurrent(e, at));

  const sources = integrationSources(db, task);
  const approved = [
    ...sources.map((s) => {
      const planTask = db.select().from(schema.tasks).where(eq(schema.tasks.id, s.taskId)).get();
      if (planTask === undefined) throw new Error(`no Task ${s.taskId}`);
      return { key: s.key, task: planTask, attempt: approvedAttempt(db, planTask) };
    }),
    { key: 'integration', task, attempt },
  ];
  const findings = approved.flatMap(({ key, attempt: a }) => {
    const review = currentReview(db, a);
    if (review === undefined) return [];
    return db
      .select()
      .from(schema.reviewFindings)
      .where(eq(schema.reviewFindings.reviewId, review.id))
      .orderBy(asc(schema.reviewFindings.position))
      .all()
      .filter((f) => !f.blocking)
      .map((f) => ({ task: key, severity: f.severity, location: f.location, problem: f.problem }));
  });
  const questions = approved.flatMap(({ key, attempt: a }) =>
    z
      .array(InboxQuestionSchema)
      .parse(JSON.parse(a.questionsJson))
      .filter((q) => !q.blocking)
      .map((q) => ({ task: key, text: q.text })),
  );

  return {
    jobId: job.id,
    title: job.title,
    spec: { problem: specification.problem, objective: specification.objective },
    branch: integrationBranch(job.id),
    headSha: attempt.headSha,
    baseSha: attempt.baseSha,
    merged: sources.map((s) => ({ key: s.key, branch: s.branch })),
    criteria: currentCriteria(db, job.id).map((c) => {
      const current = evidence.filter((e) => e.criterionId === c.id);
      return {
        code: c.code,
        text: c.text,
        mandatory: c.mandatory,
        verdict: combineVerdicts(current.map((e) => EvidenceVerdictSchema.parse(e.verdict))),
        detail:
          current.length === 0
            ? 'no Evidence'
            : current.map((e) => `${evidenceSource(e)}: ${e.verdict} (${e.detail})`).join('; '),
      };
    }),
    commands: runs.map((r) => ({
      key: r.commandKey,
      command: r.command,
      exitCode: r.exitCode,
      verdict: EvidenceVerdictSchema.parse(
        evidence.find((e) => e.verificationRunId === r.id)?.verdict ?? 'not_tested',
      ),
    })),
    risks: {
      overall: TaskDefinitionSchema.parse(JSON.parse(task.definitionJson)).risk,
      tasks: approved
        .filter((a) => a.task.kind === 'plan')
        .map((a) => ({
          key: a.key,
          risk: TaskDefinitionSchema.parse(JSON.parse(a.task.definitionJson)).risk,
        })),
      securityConsiderations: specification.securityConsiderations,
    },
    findings,
    questions,
    rollback,
    ci,
  };
}

/** The Job's pull requests as recorded, for the API and the views. */
export function pullRequestsOf(db: FactoryDb, jobId: string): PullRequestRecord[] {
  return db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.jobId, jobId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((r) => toPullRequestRecord(db, r));
}

/** A `pull_requests` row as the API shows it, with the checks recorded on its current head. */
export function toPullRequestRecord(
  db: FactoryDb | Tx,
  row: typeof schema.pullRequests.$inferSelect,
): PullRequestRecord {
  // The schemas drop the columns the API doesn't show (ids, the body hash).
  const checks = db
    .select()
    .from(schema.prChecks)
    .where(and(eq(schema.prChecks.pullRequestId, row.id), eq(schema.prChecks.headSha, row.headSha)))
    .orderBy(asc(schema.prChecks.source), asc(schema.prChecks.name))
    .all();
  return PullRequestRecordSchema.parse({
    ...row,
    changesRequestedBy: JSON.parse(row.changesRequestedJson) as unknown,
    gate: row.gateJson === null ? null : (JSON.parse(row.gateJson) as unknown),
    checks,
  });
}
