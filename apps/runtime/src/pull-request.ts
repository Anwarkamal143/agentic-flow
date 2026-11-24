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
  InboxDecisionSchema,
  InboxQuestionSchema,
  integrationBranch,
  IntegrationRewriteRouteSchema,
  isCurrent,
  isPushPermissionRefusal,
  NOT_WRITABLE_ACTION,
  PlanProposalSchema,
  PullRequestRecordSchema,
  pullRequestDelivery,
  pullRequestRecovery,
  PullRequestStateSchema,
  pullRequestTitle,
  renderPullRequestBody,
  SpecificationProposalSchema,
  TaskDefinitionSchema,
  BlockerSchema,
  type Blocker,
  type GitHubCoordinates,
  type IntegrationRewriteRoute,
  type PullRequestBodyInput,
  type PullRequestRecord,
  type Redactor,
} from '@factory/domain';
import { changedPaths, git, GitError } from '@factory/git';
import type { GitHubFailure, GitHubPort, PullRequest } from '@factory/github';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { currentCriteria, currentSpec } from './criteria.js';
import type { CrashPoint } from './closure.js';
import { changeJob, readJobState, type JobState, type StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { ApiFailure } from './errors.js';
import { integrationSources } from './integration.js';
import { latestArtifact } from './plan-approval.js';
import { openMergeApproval, publishedBranchNumber, skipMergeStages } from './merge-approval.js';
import { openBlockerItem } from './blocker-approvals.js';
import { latestStageRun } from './replan.js';
import { describeTriggers, ensureComment, triggersAnswered } from './pr-feedback.js';
import { defaultBranchTip, startBaseMergeIn } from './base-change.js';
import { foreignCommitsOf, foreignHeadsOf } from './foreign-push.js';
import { multiRepositoryOf, storedDeliveryOrder } from './multi-repo.js';
import { createHash } from 'node:crypto';

/** The Task scheduler, which runs this Stage. */
const ACTOR = 'system:scheduler';

type TaskRow = typeof schema.tasks.$inferSelect;
type AttemptRow = typeof schema.attempts.$inferSelect;
type RepositoryRow = typeof schema.repositories.$inferSelect;
type PullRequestRow = typeof schema.pullRequests.$inferSelect;

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
 * GitHub refused a push for lack of permission (#108, ADR-0068): not a
 * delivery failure but the `repository_not_writable` Blocker, so the Stage
 * waits for a human to fix the permission and check again.
 */
class PushNotPermitted extends Error {}

interface DeliveryTarget {
  job: typeof schema.jobs.$inferSelect;
  task: TaskRow;
  repo: RepositoryRow;
  coordinates: GitHubCoordinates;
  attempt: AttemptRow & { headSha: string };
  stageRunId: string;
}

/**
 * The first push to `branch` and its PR, opened (or adopted, by its marker).
 * Before it, a default branch that moved since the Integration Branch was
 * verified is merged in first (C2, ADR-0041): nothing stale is pushed. With
 * `replacing` (`new_pr` on an `integration_rewrite` Blocker, #65), the old PR
 * is closed first with a marked comment saying why, and its row is marked
 * replaced in the transaction that records the new one. `false` when the
 * Stage stops here (shutting down, a base merge-in, a foreign PR).
 */
async function openPullRequest(
  deps: PullRequestDeps,
  r: DeliveryTarget & {
    branch: string;
    replacing?: { recorded: PullRequestRow; approvalId: string };
  },
): Promise<boolean> {
  const { db } = deps;
  const { job, task, repo, coordinates, attempt, branch, stageRunId } = r;
  const jobId = job.id;
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
    if (merging) return false;
    throw new DeliveryFailed(
      `${repo.defaultBranch} of ${repoLabel(coordinates)} is at ${tip}, not the ${attempt.baseSha} the Integration Branch was verified on, and the base could not be merged in: nothing stale is pushed`,
    );
  }
  if (r.replacing !== undefined) {
    const closed = await closeReplacedPullRequest(deps, { ...r, replacing: r.replacing });
    if (!closed) return false;
  }

  const changedFiles = await changedFilesOf(repo.clonePath, attempt);
  const body = renderPullRequestBody(
    pullRequestBodyInput(db, deps.artifacts, job, task, attempt, null, branch, changedFiles),
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
  if (ensured === undefined) return false; // shutting down: resumed at the next start
  if (ensured.kind === 'failed') {
    throw new DeliveryFailed(
      `GitHub refused the pull request for ${repoLabel(coordinates)}: ${deps.redact(describeFailure(ensured.failure))}`,
    );
  }
  if (ensured.kind === 'uncertain') {
    waitOnForeignPullRequest(deps, stageRunId, jobId, task, attempt, coordinates, ensured.pr);
    return false;
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
    changedFiles,
    replacing: r.replacing,
  });
  return true;
}

/**
 * `new_pr` (#65): the old PR is closed on GitHub with a comment carrying the
 * marker `pull_request.replaced:<approval>` that says why and where the new
 * one is. Each step can be redone: the comment is looked up by its marker
 * first, and a PR already closed is not closed again. Its branch is left as
 * it is. A PR merged meanwhile fails the Stage. `false` once shutting down.
 */
async function closeReplacedPullRequest(
  deps: PullRequestDeps,
  r: DeliveryTarget & {
    branch: string;
    replacing: { recorded: PullRequestRow; approvalId: string };
  },
): Promise<boolean> {
  const { github } = deps;
  const { job, coordinates, attempt, branch } = r;
  const { recorded, approvalId } = r.replacing;
  const name = `${repoLabel(coordinates)}#${String(recorded.number)}`;
  const fresh = await withResultRetries(deps, () =>
    github.getPullRequest(coordinates, recorded.number),
  );
  if (fresh === undefined) return false;
  if (!fresh.ok) {
    throw new DeliveryFailed(
      `could not re-read ${name} before closing it: ${deps.redact(describeFailure(fresh.failure))}`,
    );
  }
  if (fresh.notModified) throw new Error('an unconditional read answered 304');
  if (fresh.value.merged) {
    throw new DeliveryFailed(
      `${name} was merged on GitHub while the rebuilt Integration Branch waited: no new pull request was opened`,
    );
  }
  const marker = factoryMarker(job.id, `pull_request.replaced:${approvalId}`);
  const text = [
    `The Software Factory closed this pull request: a Replan rebuilt the Integration Branch, and the rebuilt branch (\`${attempt.headSha}\`) does not descend from \`${recorded.pushedSha}\`, the head published here.`,
    `Rather than force-push \`${recorded.headBranch}\`, a human chose to open a new pull request from \`${branch}\`. This branch is left as it is.`,
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
      `GitHub refused the factory's comment on ${name}: ${deps.redact(describeFailure(commented.failure))}`,
    );
  }
  if (fresh.value.state === 'open') {
    const closed = await withResultRetries(deps, () =>
      github.updatePullRequest(coordinates, recorded.number, { state: 'closed' }),
    );
    if (closed === undefined) return false;
    if (!closed.ok) {
      throw new DeliveryFailed(
        `GitHub refused to close ${name}: ${deps.redact(describeFailure(closed.failure))}`,
      );
    }
  }
  return true;
}

/** Whether `head` holds `ancestor` in the Factory Clone: a push of `head` over it is a fast-forward. */
async function descendsFrom(clonePath: string, head: string, ancestor: string): Promise<boolean> {
  if (head === ancestor) return true;
  try {
    await git(['merge-base', '--is-ancestor', ancestor, head], { cwd: clonePath });
    return true;
  } catch {
    return false; // not an ancestor, or not in the clone: either way not a fast-forward
  }
}

/** The pull request currently recorded for (Job, Repository): not one closed and replaced (#65). */
function currentPullRequest(
  db: FactoryDb | Tx,
  jobId: string,
  repositoryId: string,
): PullRequestRow | undefined {
  return db
    .select()
    .from(schema.pullRequests)
    .where(
      and(
        eq(schema.pullRequests.jobId, jobId),
        eq(schema.pullRequests.repositoryId, repositoryId),
        isNull(schema.pullRequests.replacedById),
      ),
    )
    .get();
}

/** The branch a new PR replacing `recorded` is opened on: the next `integration-<n>` (#65). */
function nextPublishedBranch(db: FactoryDb | Tx, recorded: PullRequestRow): string {
  return integrationBranch(recorded.jobId, publishedBranchNumber(db, recorded) + 1);
}

/** A human's decision on the `integration_rewrite` Blocker of Integration Task `taskId`, if any (#65). */
export interface RewriteDecision {
  route: IntegrationRewriteRoute;
  approvalId: string;
  decidedBy: string;
}

/** The newest decided `integration_rewrite` Blocker Approval of the Integration Task `taskId`. */
export function decidedRewrite(db: FactoryDb | Tx, taskId: string): RewriteDecision | undefined {
  const rows = db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.taskId, taskId),
        eq(schema.approvals.kind, 'blocker'),
        eq(schema.approvals.state, 'decided'),
      ),
    )
    .orderBy(desc(sql`"approvals"."rowid"`))
    .all();
  for (const row of rows) {
    if (row.decisionJson === null) continue;
    const decision = InboxDecisionSchema.parse(JSON.parse(row.decisionJson));
    const route = IntegrationRewriteRouteSchema.safeParse(decision.option);
    if (route.success) {
      return { route: route.data, approvalId: row.id, decidedBy: row.decidedBy ?? 'unknown' };
    }
  }
  return undefined;
}

/**
 * `force_push_with_lease` or `new_pr` on an `integration_rewrite` Blocker
 * Approval (#65), in the deciding transaction: refused (409) unless
 * `pull_request` still waits on that Blocker. The decision is written to
 * `audit_log` with the old and new heads (and the lease, for a force-push),
 * and `pull_request` is queued again to carry it out.
 */
export function approveIntegrationRewrite(
  tx: Tx,
  state: JobState,
  step: StageRunStepper,
  input: {
    item: { id: string; stageRunId: string | null; taskId: string | null };
    route: IntegrationRewriteRoute;
    actor: string;
  },
): void {
  const { item, route, actor } = input;
  const run = state.stageRuns.find((r) => r.id === item.stageRunId);
  const blocker =
    run?.blockerJson == null ? undefined : BlockerSchema.parse(JSON.parse(run.blockerJson));
  if (
    run?.stageId !== 'pull_request' ||
    run.state !== 'waiting_human' ||
    blocker?.reason !== 'integration_rewrite'
  ) {
    throw new ApiFailure(
      409,
      'not_integration_rewrite',
      'pull_request no longer waits on a rebuilt Integration Branch',
    );
  }
  const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, blocker.taskId)).get();
  const attempt = tx
    .select()
    .from(schema.attempts)
    .where(eq(schema.attempts.id, blocker.attemptId))
    .get();
  if (task === undefined || attempt?.headSha == null) {
    throw new Error(`integration_rewrite Blocker names no approved head (${blocker.attemptId})`);
  }
  const recorded = currentPullRequest(tx, task.jobId, task.repositoryId);
  if (recorded === undefined) throw new Error(`Job ${task.jobId} has no pull request to rewrite`);
  const branch = route === 'new_pr' ? nextPublishedBranch(tx, recorded) : recorded.headBranch;
  const auditId = newId('aud');
  const action = `integration_rewrite.${route}`;
  const policyRef = `inbox:${item.id}/${route}`;
  tx.insert(schema.auditLog)
    .values({
      id: auditId,
      ts: new Date().toISOString(),
      actor,
      action,
      target: `pull_request:${recorded.id}`,
      jobId: task.jobId,
      beforeJson: JSON.stringify({
        number: recorded.number,
        branch: recorded.headBranch,
        headSha: recorded.pushedSha,
      }),
      afterJson: JSON.stringify({
        branch,
        headSha: attempt.headSha,
        ...(route === 'force_push_with_lease' ? { lease: recorded.pushedSha } : {}),
      }),
      policyRef,
      correlationId: item.id,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'pull_request',
    entityId: recorded.id,
    jobId: task.jobId,
    type: 'audit.recorded',
    actor,
    payload: {
      auditId,
      action,
      fromSha: recorded.pushedSha,
      headSha: attempt.headSha,
      branch,
      policyRef,
    },
  });
  step(run, 'queued', {
    reason:
      route === 'new_pr'
        ? `${actor} chose a new pull request on ${branch} for the rebuilt Integration Branch`
        : `${actor} approved force-pushing the rebuilt Integration Branch with a lease pinned to ${recorded.pushedSha}`,
  });
}

/**
 * The rebuilt Integration Branch would rewrite the open PR's branch (#65,
 * Q25): `pull_request` waits on the human Blocker `integration_rewrite`, and
 * its Blocker Approval offers force-push with lease (recommended), a new PR,
 * or cancelling the Job. Nothing is pushed.
 */
function waitOnRewrite(
  deps: PullRequestDeps,
  r: DeliveryTarget & { recorded: PullRequestRow },
): void {
  const { job, task, coordinates, attempt, recorded, stageRunId } = r;
  const name = `${repoLabel(coordinates)}#${String(recorded.number)}`;
  changeJob(
    deps.db,
    { jobId: job.id, expectedVersion: 'current', actor: ACTOR },
    (tx, state, step) => {
      const run = state.stageRuns.find((s) => s.id === stageRunId);
      if (run?.state !== 'running') return;
      const blocker: Blocker = {
        kind: 'human',
        reason: 'integration_rewrite',
        detail: `a Replan rebuilt the Integration Branch at ${attempt.headSha}, which does not descend from ${recorded.pushedSha}, the head the factory published on ${recorded.headBranch} for pull request ${name} (${recorded.url}, open): publishing it rewrites that branch`,
        requiredAction: `decide the Blocker Approval in the Inbox: force-push with a lease pinned to ${recorded.pushedSha} (recommended; audited; the PR is updated in place), open a new PR on ${nextPublishedBranch(tx, recorded)} (the old one is closed with a comment), or cancel the Job. The factory never force-pushes on its own`,
        taskId: task.id,
        attemptId: attempt.id,
        createdAt: new Date().toISOString(),
      };
      step(run, 'waiting_human', { blocker });
      openBlockerItem(tx, { jobId: job.id, actor: ACTOR }, task, blocker, { stageRunId: run.id });
      appendEvent(tx, {
        entityKind: 'pull_request',
        entityId: recorded.id,
        jobId: job.id,
        type: 'pull_request.rewrite_needed',
        actor: ACTOR,
        payload: {
          number: recorded.number,
          pushedSha: recorded.pushedSha,
          headSha: attempt.headSha,
          taskId: task.id,
        },
      });
    },
  );
  deps.onCommit();
}

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
    // In Delivery Order (ADR-0066): an earlier Repository's PR opens first, so a later
    // one's body names it; the poller re-renders the earlier body once the later opens.
    const order = (storedDeliveryOrder(db, jobId) ?? []).map((r) => r.repositoryId);
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    const targets = integrationTasksOf(db, jobId).sort((a, b) => rank(a.repo.id) - rank(b.repo.id));
    // A push refused for lack of permission holds its Repository; the others go on (#108).
    const refused: { task: TaskRow; attempt: AttemptRow; detail: string }[] = [];
    for (const { task, repo } of targets) {
      const coordinates = coordinatesOf(repo);
      if (coordinates === null) continue; // delivered locally (the report says so)
      const recorded = currentPullRequest(db, jobId, repo.id);
      const attempt = approvedAttempt(db, task);
      const rewrite = decidedRewrite(db, task.id);
      const route = pullRequestDelivery({
        recorded:
          recorded === undefined
            ? null
            : {
                state: PullRequestStateSchema.parse(recorded.state),
                pushedSha: recorded.pushedSha,
                taskId: recorded.taskId,
              },
        taskId: task.id,
        headSha: attempt.headSha,
        fastForward:
          recorded !== undefined &&
          (await descendsFrom(repo.clonePath, attempt.headSha, recorded.pushedSha)),
        rewrite: rewrite?.route ?? null,
      });
      if (route === 'none') continue;
      if (!stillRunning(db, stageRunId) || deps.closed()) return;
      const target = { job, task, repo, coordinates, attempt, stageRunId };
      let go: 'next' | 'stop';
      try {
        go = await deliverTo(deps, target, route, recorded, rewrite);
      } catch (err) {
        if (!(err instanceof PushNotPermitted)) throw err;
        refused.push({ task, attempt, detail: err.message });
        continue;
      }
      if (go === 'stop') return;
    }
    if (refused.length > 0) {
      blockNotPermitted(deps, stageRunId, jobId, refused);
      return;
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
 * One Repository's delivery by its route: `stop` when the Stage stops here
 * (shutting down, a base merge-in, a foreign PR, a rewrite waiting on a
 * human), `next` to go on to the next Repository.
 */
async function deliverTo(
  deps: PullRequestDeps,
  target: DeliveryTarget,
  route: Exclude<ReturnType<typeof pullRequestDelivery>, 'none'>,
  recorded: PullRequestRow | undefined,
  rewrite: RewriteDecision | undefined,
): Promise<'next' | 'stop'> {
  const { db } = deps;
  const jobId = target.job.id;
  if (route === 'open') {
    const opened = await openPullRequest(deps, { ...target, branch: integrationBranch(jobId) });
    return opened ? 'next' : 'stop';
  }
  if (recorded === undefined) throw new Error(`a ${route} without a recorded pull request`);
  if (route === 'needs_approval') {
    // A rebuilt Integration Branch (#65, Q25): never force-pushed on the factory's judgment.
    waitOnRewrite(deps, { ...target, recorded });
    return 'stop';
  }
  if (route === 'new_pr') {
    if (rewrite === undefined) throw new Error('new_pr without a decision');
    const opened = await openPullRequest(deps, {
      ...target,
      branch: nextPublishedBranch(db, recorded),
      replacing: { recorded, approvalId: rewrite.approvalId },
    });
    return opened ? 'next' : 'stop';
  }
  // Feedback was reworked (ADR-0039), the base merged in (ADR-0041), or a human approved
  // force-pushing the rebuilt branch (#65): the same PR is updated in place.
  const updated = await updateInPlace(deps, {
    ...target,
    branch: recorded.headBranch,
    recorded,
    force: route === 'force_push' && rewrite !== undefined ? rewrite : null,
  });
  return updated ? 'next' : 'stop'; // stop: shutting down, resumed at the next start
}

/**
 * Holds `pull_request` on the `repository_not_writable` Blocker of the first
 * refused push (#108, ADR-0068), with its Blocker Approval: the Stage Run is
 * `blocked` (the Job stays blocked) until a human checks again (the Stage is
 * queued again; the PRs already open are not touched) or cancels. Each
 * refused Repository is named in an event.
 */
function blockNotPermitted(
  deps: PullRequestDeps,
  stageRunId: string,
  jobId: string,
  refused: readonly { task: TaskRow; attempt: AttemptRow; detail: string }[],
): void {
  const [first] = refused;
  if (first === undefined) return;
  changeJob(deps.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx, state, step) => {
    const run = state.stageRuns.find((r) => r.id === stageRunId);
    if (run?.state !== 'running') return;
    const blocker: Blocker = {
      kind: 'infrastructure',
      reason: 'repository_not_writable',
      detail: refused.map((r) => r.detail).join('; '),
      requiredAction: NOT_WRITABLE_ACTION,
      taskId: first.task.id,
      attemptId: first.attempt.id,
      createdAt: new Date().toISOString(),
    };
    step(run, 'blocked', { blocker });
    openBlockerItem(tx, { jobId, actor: ACTOR }, first.task, blocker, { stageRunId: run.id });
    for (const r of refused) {
      appendEvent(tx, {
        entityKind: 'task',
        entityId: r.task.id,
        jobId,
        type: 'pull_request.push_not_permitted',
        actor: ACTOR,
        payload: { attemptId: r.attempt.id, detail: r.detail },
      });
    }
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
    // The permission refusal is in git's `remote:` lines, not only its last line (#108).
    const stderr = err instanceof GitError ? err.stderr.replace(/\s*\n\s*/g, ' ').trim() : output;
    if (isPushPermissionRefusal(stderr)) {
      throw new PushNotPermitted(
        `GitHub refused the push of ${branch} to ${repoLabel(repo)} for lack of permission: ${redact(stderr.slice(0, 1000))}`,
      );
    }
    throw new DeliveryFailed(`could not push ${branch} to ${repoLabel(repo)}: ${redact(output)}`);
  }
}

/**
 * Publishes a rebuilt Integration Branch a human approved (#65): a force-push
 * of `sha` to `branch` with its lease pinned to `lease`, the last head the
 * factory pushed. If the branch moved since (someone else pushed), git
 * refuses it and the Stage fails with what was found: nothing is overwritten.
 */
async function forcePushWithLease(
  redact: Redactor,
  clonePath: string,
  repo: GitHubCoordinates,
  p: { sha: string; branch: string; lease: string; seen: string },
): Promise<void> {
  try {
    await git(
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/${p.branch}:${p.lease}`,
        githubRemoteUrl(repo),
        `${p.sha}:refs/heads/${p.branch}`,
      ],
      { cwd: clonePath },
    );
  } catch (err) {
    const output = (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
    const moved = p.seen !== p.lease ? ` (GitHub shows ${p.seen})` : '';
    throw new DeliveryFailed(
      `the force-push of ${p.branch} to ${repoLabel(repo)} was refused: its lease is pinned to ${p.lease}, the last head the factory pushed, and the branch is no longer there${moved}. Someone else pushed to it, so nothing was overwritten: ${redact(output)}`,
    );
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

/**
 * Runs `tryOnce` until it is not a transient failure or the tries run out;
 * `undefined` once shutting down. A rate limit is capacity, not failure
 * (ADR-0045): it waits for the reset and tries again without spending a try.
 */
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
    if (failure?.kind === 'rate_limited') {
      deps.log(`pull_request: GitHub ${describeFailure(failure)}; waiting for the reset`);
      // At least the first retry delay, so a reset already past (clock skew) is no tight loop.
      const reset = Date.parse(failure.resetAt);
      const at = Math.max(Number.isFinite(reset) ? reset : 0, Date.now() + (delays[0] ?? 2_000));
      if (!(await sleepUntil(deps, at))) return undefined;
      n--;
      continue;
    }
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

/** Waits until `deadline` (ms since the epoch); `false` once shutting down meanwhile. */
async function sleepUntil(deps: PullRequestDeps, deadline: number): Promise<boolean> {
  // In slices, so a shutdown is not held up by a long reset.
  for (;;) {
    if (deps.closed()) return false;
    const left = deadline - Date.now();
    if (left <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 1_000)));
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
    /**
     * A human approved force-pushing a rebuilt Integration Branch (#65): the
     * push is forced with a lease pinned to `recorded.pushedSha`, the last
     * head the factory pushed. `null`: a fast-forward, never forced.
     */
    force: RewriteDecision | null;
  },
): Promise<boolean> {
  const { db, github } = deps;
  const { job, task, repo, coordinates, branch, recorded, attempt, force } = r;
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
      `${repoLabel(coordinates)}#${String(recorded.number)} was ${onGitHub.merged ? 'merged' : 'closed'} on GitHub while ${force === null ? 'the feedback was reworked' : 'the rebuilt Integration Branch waited'}: the head ${attempt.headSha} was not pushed`,
    );
  }
  if (force !== null) {
    // The lease, not this read, decides (#65): git refuses the push unless the branch is still at
    // the head the factory last pushed. A redo after the push went through pushes nothing.
    if (onGitHub.head.sha !== attempt.headSha) {
      await forcePushWithLease(deps.redact, repo.clonePath, coordinates, {
        sha: attempt.headSha,
        branch,
        lease: recorded.pushedSha,
        seen: onGitHub.head.sha,
      });
    }
  } else {
    // The head the factory last pushed, or a foreign head it fetched and verified since (ADR-0042):
    // a push from either is a fast-forward over nobody's work.
    const known = new Set([recorded.pushedSha, attempt.headSha, ...foreignHeadsOf(db, task.id)]);
    if (!known.has(onGitHub.head.sha)) {
      throw new DeliveryFailed(
        `${repoLabel(coordinates)}#${String(recorded.number)} has head ${onGitHub.head.sha}, not the ${recorded.pushedSha} the factory pushed: someone else pushed to ${branch}, so the Rework was not pushed over it`,
      );
    }
    await push(deps.redact, repo.clonePath, coordinates, attempt.headSha, branch);
  }
  const changedFiles = await changedFilesOf(repo.clonePath, attempt);
  const body = renderPullRequestBody(
    pullRequestBodyInput(db, deps.artifacts, job, task, attempt, null, branch, changedFiles),
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
  const foreign = answered.length === 0 && attempt.cause === 'foreign_push';
  const why =
    force !== null
      ? `a Replan rebuilt the Integration Branch from the current base, and ${force.decidedBy} approved force-pushing it (Inbox Item ${force.approvalId})`
      : answered.length === 0 && attempt.cause === 'base_merge'
        ? `the default branch moved: the factory merged ${repo.defaultBranch} (\`${attempt.baseSha}\`) into the Integration Branch with a merge commit (never a rebase)`
        : foreign
          ? 'someone else pushed to the Integration Branch: the factory fetched that head and never overwrote it'
          : describeTriggers(answered);
  const moved =
    force !== null
      ? `The Integration Branch moved from \`${recorded.pushedSha}\` to \`${attempt.headSha}\` with a force-push whose lease was pinned to \`${recorded.pushedSha}\` (not a fast-forward: the commits published before are no longer on the branch), the factory's commands passed on the new head`
      : foreign
        ? `The Integration Branch is at \`${attempt.headSha}\`, the foreign head (listed under Foreign commits in the description); the factory's path-scope Gate and commands passed on it`
        : `The Integration Branch moved from \`${recorded.pushedSha}\` to \`${attempt.headSha}\` (a fast-forward), the factory's commands passed on the new head`;
  const text = [
    `The Software Factory updated this pull request in place after ${why}.`,
    `${moved}, ${reanchored}, and the description was rendered again. The Merge Gate is evaluated again on it.`,
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
        // A rebuilt Integration Task's PR is now its own (#65).
        taskId: task.id,
        pushedSha: attempt.headSha,
        headSha: attempt.headSha,
        // The base as GitHub said in the re-read: a merged-in base (ADR-0041) is recorded too.
        baseSha: onGitHub.base.sha,
        headSeenAt: now,
        mergeableState: null,
        gateJson: null,
        gateEvaluatedAt: null,
        bodySha256: bodyHash(body),
        changedFiles,
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
        forced: force !== null,
        ...(force === null ? {} : { approvalId: force.approvalId, taskId: task.id }),
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
    /** The files the pushed head changes against its base (0: an empty delivery, flagged). */
    changedFiles: number;
    /** The PR this one replaces (`new_pr`, #65): closed on GitHub, marked replaced here. */
    replacing?: { recorded: PullRequestRow; approvalId: string } | undefined;
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
        changedFiles: r.changedFiles,
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
        ...(r.replacing === undefined ? {} : { replaces: r.replacing.recorded.id }),
      },
    });
    if (r.replacing === undefined) return;
    const old = r.replacing.recorded;
    const replaced = tx
      .update(schema.pullRequests)
      .set({ state: 'closed', replacedById: id, version: sql`${schema.pullRequests.version} + 1` })
      .where(and(eq(schema.pullRequests.id, old.id), isNull(schema.pullRequests.replacedById)))
      .run();
    if (replaced.changes !== 1) throw new Error(`pull request ${old.id} was already replaced`);
    appendEvent(tx, {
      entityKind: 'pull_request',
      entityId: old.id,
      jobId: r.jobId,
      type: 'pull_request.replaced',
      actor: ACTOR,
      payload: {
        number: old.number,
        replacedBy: id,
        replacedByNumber: r.pr.number,
        head: r.branch,
        approvalId: r.replacing.approvalId,
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
  /** The branch the PR is on: `integration-<n>` after a `new_pr` (#65). */
  branch: string = integrationBranch(job.id),
  /** The files the head changes against its base (`changedFilesOf`); `null` when not counted. */
  changedFiles: number | null = null,
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
    branch,
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
    // Foreign commits the approved head holds (ADR-0042), never the factory's own.
    foreignCommits: foreignCommitsOf(db, task.id, attempt.n).map((c) => ({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
    })),
    // Approved commits a rewrite a human adopted dropped (ADR-0042).
    droppedCommits: foreignCommitsOf(db, task.id, attempt.n, 'dropped').map((c) => ({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
    })),
    changedFiles,
    multiRepository: multiRepositoryOf(db, job.id, task.repositoryId),
  };
}

/** The files `attempt`'s head changes against its base, in the Factory Clone: 0 is an empty delivery. */
async function changedFilesOf(
  clonePath: string,
  attempt: { baseSha: string; headSha: string },
): Promise<number> {
  return (await changedPaths(clonePath, attempt.baseSha, attempt.headSha)).length;
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
  const replacedBy =
    row.replacedById === null
      ? undefined
      : db
          .select({ number: schema.pullRequests.number })
          .from(schema.pullRequests)
          .where(eq(schema.pullRequests.id, row.replacedById))
          .get();
  return PullRequestRecordSchema.parse({
    ...row,
    replacedByNumber: replacedBy?.number ?? null,
    changesRequestedBy: JSON.parse(row.changesRequestedJson) as unknown,
    mergedBefore:
      row.mergedBeforeJson === null ? [] : (JSON.parse(row.mergedBeforeJson) as unknown),
    gate: row.gateJson === null ? null : (JSON.parse(row.gateJson) as unknown),
    checks,
  });
}
