/**
 * The Delivery Report v4 (closure; v3 of ADR-0028 plus the Integration Branch, ADR-0034): how the Job ended, every Task
 * Branch with the leaves to fetch (one `git fetch` each, from the Factory
 * Clone into the source checkout), what changed, the Evidence per Acceptance
 * Criterion, the independent review, and known limitations. A failed Job's
 * report lists its approved branches as partial results.
 */
import { schema, type FactoryDb } from '@factory/db';
import {
  AttemptFindingSchema,
  BlockerSchema,
  integrationBranch,
  combineVerdicts,
  DeliveryReportSchema,
  deliveryBranches,
  evidenceSource,
  isCurrent,
  EvidenceVerdictSchema,
  InboxQuestionSchema,
  RuleIssueSchema,
  StageFailureSchema,
  TaskCancelReasonSchema,
  TaskDefinitionSchema,
  TaskStateSchema,
  DeliveredSetupSchema,
  type DeliveryReport,
  type PullRequestRecord,
} from '@factory/domain';
import { changedPaths, commitsBetween } from '@factory/git';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { latestSetupRun } from './setup.js';
import { frozenRepositoryConfig } from './repositories.js';
import { criteriaCoveredBy, currentCriteria } from './criteria.js';
import { latestArtifact } from './plan-approval.js';
import { integrationSources } from './integration.js';
import { pullRequestsOf } from './pull-request.js';
import { foreignCommitsOf } from './foreign-push.js';

/** A POSIX shell single-quoted word. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Run from the source checkout: fetches the Task Branch into a local branch of the same name. */
export function fetchCommand(clonePath: string, branch: string): string {
  return `git fetch ${shellQuote(clonePath)} ${shellQuote(`${branch}:${branch}`)}`;
}

export async function buildDeliveryReport(db: FactoryDb, jobId: string): Promise<DeliveryReport> {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  const link = db
    .select()
    .from(schema.jobRepositories)
    .where(eq(schema.jobRepositories.jobId, jobId))
    .get();
  const repo =
    link === undefined
      ? undefined
      : db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, link.repositoryId))
          .get();
  if (job === undefined || repo === undefined) throw new Error(`Job ${jobId} has no Repository`);

  const pullRequests = pullRequestsOf(db, jobId);
  const mergePolicy = frozenRepositoryConfig(job.configSnapshotJson, repo).mergePolicy.value;
  const mergeFailed =
    db
      .select({ state: schema.stageRuns.state })
      .from(schema.stageRuns)
      .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, 'merge')))
      .orderBy(desc(schema.stageRuns.attempt))
      .get()?.state === 'failed';
  const limitations = [
    'The Harness ran under the Tier 0 local guardrail (environment allowlist, closed stdin, the Worktree as working directory). It ran as your user; this is not a sandbox. It was denied `gh` and the GitHub tokens, but the `gh` login on disk stayed readable to it.',
    'Harness and verification output is not redacted yet.',
    pullRequests.length === 0
      ? 'Delivery is a local branch in the Factory Clone; nothing was pushed.'
      : mergePolicy === 'human_approval'
        ? 'The factory pushed only the Integration Branch and opened its pull request. Under the human_approval Merge Policy it merges only after a human approved the merge item in the Inbox (audited), re-reading the pull request right before merging. Polling is not real time: what is shown is what the last poll or the merge read.'
        : pullRequests.every((pr) => pr.state === 'merged')
          ? 'The factory pushed only the Integration Branch and opened its pull request. Under the never_auto Merge Policy it never merges: it polled the pull request, its checks and its reviews, and saw the merge a human made on GitHub. Polling is not real time: what is shown is what the last poll read.'
          : 'The factory pushed only the Integration Branch and opened its pull request, and never merged it (never_auto). The pull request was not merged when this report was written: what is shown is what the last poll read, and the pull request stays on GitHub as it is.',
  ];

  // Every Task of the newest Plan, and any earlier Task that got a Task Branch.
  const plan = db.transaction((tx) => latestArtifact(tx, jobId, 'plan'));
  const worktrees = db
    .select()
    .from(schema.worktrees)
    .where(eq(schema.worktrees.jobId, jobId))
    .orderBy(asc(sql`rowid`))
    .all();
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, jobId))
    .orderBy(asc(sql`rowid`))
    .all()
    .filter((t) => t.kind === 'plan')
    .filter((t) => t.planArtifactId === plan?.id || worktrees.some((w) => w.taskId === t.id));
  const integration = integrationOf(db, jobId, plan?.id);
  // Once the Integration Branch is verified, it is what to fetch: the Task Branches are in it.
  const integrated = integration?.state === 'approved';
  const edges = db
    .select({ taskId: schema.taskDependencies.taskId, on: schema.taskDependencies.dependsOnTaskId })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDependencies.taskId))
    .where(eq(schema.tasks.jobId, jobId))
    .all();
  const marks = deliveryBranches(
    tasks.map((t) => ({
      key: t.id,
      state: TaskStateSchema.parse(t.state),
      dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.on),
    })),
  );
  const latestAttempt = (taskId: string) =>
    db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.taskId, taskId))
      .orderBy(desc(schema.attempts.n))
      .get();
  const branches: DeliveryReport['branches'] = tasks.map((t) => {
    const mark = marks.find((m) => m.key === t.id);
    const branch = worktrees.findLast((w) => w.taskId === t.id)?.branch ?? null;
    const approvedHead =
      db
        .select({ headSha: schema.attempts.headSha })
        .from(schema.attempts)
        .where(and(eq(schema.attempts.taskId, t.id), eq(schema.attempts.state, 'passed')))
        .orderBy(desc(schema.attempts.n))
        .get()?.headSha ?? null;
    const offered = !integrated && mark?.offered === true && branch !== null;
    return {
      key: t.key,
      title: t.title,
      state: TaskStateSchema.parse(t.state),
      cancelReason: t.cancelReason === null ? null : TaskCancelReasonSchema.parse(t.cancelReason),
      branch,
      headSha: approvedHead ?? latestAttempt(t.id)?.headSha ?? null,
      leaf: mark?.leaf ?? true,
      fetchCommand: offered ? fetchCommand(repo.clonePath, branch) : null,
    };
  });
  const offered = branches.filter((b) => b.fetchCommand !== null);
  const latestState = (stageId: string) =>
    db
      .select({ state: schema.stageRuns.state })
      .from(schema.stageRuns)
      .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, stageId)))
      .orderBy(desc(schema.stageRuns.attempt))
      .get()?.state;
  const integrationFailed = latestState('integration') === 'failed';
  const pullRequestFailed = latestState('pull_request') === 'failed';
  const outcome =
    latestState('execution') === 'failed' || integrationFailed || pullRequestFailed || mergeFailed
      ? 'failed'
      : 'completed';
  const failedTasks = tasks
    .filter((t) => t.state === 'failed')
    .map((t) => `${t.key} (${latestAttempt(t.id)?.exitReason ?? 'factory_error'})`);
  const fetchCount = `${String(offered.length)} marked branch${offered.length === 1 ? '' : 'es'}`;
  const opened = pullRequests
    .map((pr) => `#${String(pr.number)} (${pr.url}) on ${pr.owner}/${pr.name}`)
    .join(', ');
  const statement = mergeFailed
    ? `The Job failed: the merge was approved, but the factory did not merge pull request ${opened} (${stageFailureOf(db, jobId, 'merge')}). The pull request stays open on GitHub as it is.`
    : pullRequestFailed
      ? `The Job failed: the Integration Branch was approved, but the factory could not push it or open its pull request (${stageFailureOf(db, jobId, 'pull_request')}). It is delivered locally instead: fetch the Integration Branch below.`
      : pullRequests.length > 0 && integration?.state === 'approved'
        ? pullRequests.every((pr) => pr.state === 'merged')
          ? `The Job completed: every Task was approved, merged into ${integration.branch}, verified and reviewed again on its head, pushed, opened as pull request ${opened}, and merged on GitHub as ${pullRequests.map((pr) => pr.mergeSha ?? 'unknown').join(', ')}${mergePolicy === 'human_approval' ? ' after your approval' : ''}.`
          : `The Job completed: every Task was approved, merged into ${integration.branch}, verified and reviewed again on its head, pushed, and opened as pull request ${opened}. It awaits your merge ${mergePolicy === 'human_approval' ? 'approval in the Inbox' : 'on GitHub'}.`
        : integrationFailed
          ? `The Job failed: every Task was approved, but the Integration Task failed (${integration?.problem ?? 'no detail'}). The approved Task Branches are partial results: fetch the ${fetchCount} below.`
          : integration?.state === 'approved'
            ? `The Job completed: every Task was approved, merged into ${integration.branch} and verified again on its head. Fetch the Integration Branch below.`
            : outcome === 'failed'
              ? `The Job failed: Task${failedTasks.length === 1 ? '' : 's'} ${failedTasks.join(', ')} failed with no Rework route, and nothing else could make progress. ${
                  offered.length === 0
                    ? 'No Task was approved, so there is nothing to fetch.'
                    : `The approved Task Branches are partial results: fetch the ${fetchCount} below.`
                } Failed and cancelled Tasks are listed, never offered.`
              : `The Job completed: every Task was approved. Fetch the ${fetchCount} below.`;
  const notes =
    integration === null
      ? [
          `The Task Branches are local branches in the Factory Clone at ${repo.clonePath} (ADR-0001); nothing was pushed. Run each fetch command from your own checkout.`,
          'Independent leaf branches are not combined (this Job has no Integration Branch): combining them yourself may conflict, and the factory has not checked.',
        ]
      : [
          `The Integration Branch and the Task Branches are local branches in the Factory Clone at ${repo.clonePath} (ADR-0001); nothing was pushed. Run the fetch command from your own checkout.`,
          `${integration.branch} starts from ${repo.defaultBranch} as fetched when integration began${integration.baseSha === null ? '' : ` (${integration.baseSha})`} and merges each approved Task Branch --no-ff in dependency order.`,
        ];
  if (pullRequests.length > 0) {
    notes[0] = `The Integration Branch was pushed to GitHub and opened as pull request ${opened}; it and the Task Branches are also local branches in the Factory Clone at ${repo.clonePath} (ADR-0001). Only the Integration Branch was pushed.`;
  }
  const skipped = skippedReason(db, jobId, 'pull_request');
  if (skipped !== undefined) notes.push(`No pull request was opened: ${skipped}.`);
  if (pullRequests.length > 1) {
    notes.push(
      `This Job has ${String(pullRequests.length)} pull requests, one per Repository. They are not atomic: each is merged on its own, in no order, and one can be merged while another is not.`,
    );
  }

  const delivered: DeliveryReport['tasks'] = [];
  const setupCommands = new Set<string>();
  for (const task of tasks) {
    if (task.state !== 'approved') continue;
    const definition = TaskDefinitionSchema.parse(JSON.parse(task.definitionJson));
    const attempt = db
      .select()
      .from(schema.attempts)
      .where(and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.state, 'passed')))
      .orderBy(desc(schema.attempts.n))
      .get();
    if (attempt?.headSha == null)
      throw new Error(`approved Task ${task.key} has no passed Attempt`);
    const worktree = db
      .select()
      .from(schema.worktrees)
      .where(eq(schema.worktrees.id, attempt.worktreeId))
      .get();
    if (worktree === undefined) throw new Error(`Attempt ${attempt.id} has no Worktree`);
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
      .all();
    const criteria = criteriaCoveredBy(db, jobId, definition.acceptance);
    const at = { headSha: attempt.headSha, baseSha: attempt.baseSha };
    const review = db
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
    if (review === undefined) throw new Error(`approved Task ${task.key} has no current review`);
    const findings = db
      .select()
      .from(schema.reviewFindings)
      .where(eq(schema.reviewFindings.reviewId, review.id))
      .orderBy(asc(schema.reviewFindings.position))
      .all();

    if (attempt.n > 1) {
      const earlier = db
        .select()
        .from(schema.attempts)
        .where(eq(schema.attempts.taskId, task.id))
        .orderBy(asc(schema.attempts.n))
        .all()
        .filter((a) => a.n < attempt.n);
      const asked = earlier.filter((a) => a.state === 'needs_decision').length;
      limitations.push(
        `Task ${task.key}: approved on Attempt ${String(attempt.n)}; ${
          asked === 0
            ? `the ${String(attempt.n - 1)} earlier Attempt(s) failed a Gate or their review`
            : `of the ${String(attempt.n - 1)} earlier Attempt(s), ${String(asked)} ended asking a human Question that was answered, the rest failed a Gate, their review or were interrupted`
        }, and their commits stay on the branch beneath the later work (each Attempt's head is kept at refs/factory/attempts/<attempt-id> in the Factory Clone).`,
      );
      for (const a of earlier) {
        const paths = z
          .array(AttemptFindingSchema)
          .parse(JSON.parse(a.gateFindingsJson))
          .filter((f) => f.rule?.startsWith('scope.') === true)
          .flatMap((f) => f.paths);
        if (paths.length > 0) {
          limitations.push(
            `Task ${task.key}: Attempt ${String(a.n)} committed changes to out-of-scope paths (${paths.join(', ')}). The delivered diff base..head no longer touches them, but those commits are in the branch history.`,
          );
        }
      }
    }
    if (attempt.wipCommit !== null) {
      limitations.push(
        `Task ${task.key}: the Harness left uncommitted changes; the factory committed them as WIP commit ${attempt.wipCommit}. Review them before using the branch.`,
      );
    }
    for (const v of z.array(RuleIssueSchema).parse(JSON.parse(attempt.protocolViolationsJson))) {
      limitations.push(`Task ${task.key}: protocol violation [${v.rule}] ${v.message}`);
    }
    // Non-blocking questions under `done` were never asked of a human: they stay open (ADR-0023).
    const openQuestions = z
      .array(InboxQuestionSchema)
      .parse(JSON.parse(attempt.questionsJson))
      .filter((q) => !q.blocking)
      .map((q) => ({ id: q.id, text: q.text }));
    for (const q of openQuestions) {
      limitations.push(
        `Task ${task.key}: open question from the developer (agent-proposed, not answered): ${q.text}`,
      );
    }
    // What installed the dependencies its verification ran on (ADR-0047).
    const setup = latestSetupRun(db, worktree.id);
    if (setup !== undefined) setupCommands.add(setup.command);
    const commits = await commitsBetween(repo.clonePath, attempt.baseSha, attempt.headSha);
    delivered.push({
      key: task.key,
      title: task.title,
      attemptId: attempt.id,
      branch: worktree.branch,
      baseSha: attempt.baseSha,
      headSha: attempt.headSha,
      commits,
      changedFiles: await changedPaths(repo.clonePath, attempt.baseSha, attempt.headSha),
      wipCommit: attempt.wipCommit,
      openQuestions,
      setup: setup === undefined ? null : DeliveredSetupSchema.parse(setup),
      verification: runs.map((r) => ({
        key: r.commandKey,
        exitCode: r.exitCode,
        verdict: EvidenceVerdictSchema.parse(
          evidence.find((e) => e.verificationRunId === r.id)?.verdict ?? 'not_tested',
        ),
      })),
      criteria: criteria.map((c) => {
        const current = evidence.filter((x) => x.criterionId === c.id && isCurrent(x, at));
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
      review: {
        id: review.id,
        outcome: review.outcome === 'approved' ? 'approved' : 'changes_requested',
        summary: review.summary,
        headSha: review.headSha,
        baseSha: review.baseSha,
        reviewer: { harnessId: review.reviewerHarnessId, version: review.reviewerHarnessVersion },
        findings: findings.map((f) => ({
          severity: f.severity,
          faultOrigin: f.faultOrigin,
          location: f.location,
          problem: f.problem,
          blocking: f.blocking,
        })),
      },
    });
    for (const f of findings) {
      limitations.push(
        `Task ${task.key}: open ${f.severity} review finding at ${f.location}: ${f.problem}`,
      );
    }
  }
  for (const command of setupCommands) {
    limitations.push(
      `The Repository's setup command (\`${command}\`) ran in the Worktrees on this machine, with network access and lifecycle scripts off: the Tier 0 guardrail, not isolation.`,
    );
  }
  const allCriteria = currentCriteria(db, jobId);
  for (const c of allCriteria) {
    const covered = delivered.some((t) =>
      t.criteria.some((x) => x.code === c.code && x.verdict === 'pass'),
    );
    if (!covered) {
      limitations.push(
        `${c.code} (${c.mandatory ? 'mandatory' : 'optional'}) has no passing Evidence: ${c.text}`,
      );
    }
  }
  return DeliveryReportSchema.parse({
    reportVersion: 6,
    outcome,
    statement,
    job: { id: job.id, title: job.title },
    repository: { id: repo.id, name: repo.name, clonePath: repo.clonePath, source: repo.source },
    branches,
    notes,
    tasks: delivered,
    integration:
      integration === null
        ? null
        : {
            ...integration,
            fetchCommand: integrated ? fetchCommand(repo.clonePath, integration.branch) : null,
          },
    pullRequests: pullRequests.map((pr) => ({
      repository: `${pr.owner}/${pr.name}`,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      headSha: pr.pushedSha,
      mergeSha: pr.mergeSha,
      adopted: pr.adopted,
      ci: ciOf(pr),
    })),
    knownLimitations: limitations,
  } satisfies DeliveryReport);
}

/** The Merge Gate's checks condition of a PR as last polled, with its checks. */
function ciOf(pr: PullRequestRecord): DeliveryReport['pullRequests'][number]['ci'] {
  const checks = pr.gate?.conditions.find((c) => c.id === 'checks');
  if (checks === undefined) return null;
  return {
    status: checks.status,
    reason: checks.reason,
    checks: pr.checks.map((c) => ({ name: c.name, outcome: c.outcome, url: c.url })),
  };
}

/** The reason the Job's newest Run of `stageId` was skipped with, if it was. */
function skippedReason(db: FactoryDb, jobId: string, stageId: string): string | undefined {
  const run = db
    .select({ id: schema.stageRuns.id, state: schema.stageRuns.state })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, stageId)))
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
  if (run?.state !== 'skipped') return undefined;
  const event = db
    .select({ payload: schema.events.payloadJson })
    .from(schema.events)
    .where(and(eq(schema.events.entityId, run.id), eq(schema.events.type, 'stage_run.skipped')))
    .get();
  const reason = z
    .object({ reason: z.string().optional() })
    .safeParse(event === undefined ? {} : JSON.parse(event.payload));
  return reason.success ? (reason.data.reason ?? 'no reason recorded') : 'no reason recorded';
}

/** Why the Job's newest `pull_request` failed. */
function stageFailureOf(db: FactoryDb, jobId: string, stageId: string): string {
  const run = db
    .select({ failureJson: schema.stageRuns.failureJson })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, stageId)))
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
  if (run?.failureJson == null) return 'no detail';
  return StageFailureSchema.parse(JSON.parse(run.failureJson)).message;
}

/**
 * The Job's newest Integration Task (of the newest Plan) as the report shows
 * it: its branch, the base it was built on and the head, the Task Branches it
 * merged, its verification, and why it did not finish. `null` when there is none.
 */
function integrationOf(
  db: FactoryDb,
  jobId: string,
  planId: string | undefined,
): Omit<NonNullable<DeliveryReport['integration']>, 'fetchCommand'> | null {
  const task = db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.jobId, jobId),
        eq(schema.tasks.kind, 'integration'),
        eq(schema.tasks.planArtifactId, planId ?? ''),
      ),
    )
    .orderBy(desc(sql`rowid`))
    .get();
  if (task === undefined) return null;
  const attempt = db
    .select()
    .from(schema.attempts)
    .where(eq(schema.attempts.taskId, task.id))
    .orderBy(desc(schema.attempts.n))
    .get();
  const runs =
    attempt === undefined
      ? []
      : db
          .select()
          .from(schema.verificationRuns)
          .where(eq(schema.verificationRuns.attemptId, attempt.id))
          .orderBy(asc(sql`rowid`))
          .all();
  const evidence =
    attempt === undefined
      ? []
      : db.select().from(schema.evidence).where(eq(schema.evidence.attemptId, attempt.id)).all();
  const blocker =
    task.blockerJson === null ? null : BlockerSchema.parse(JSON.parse(task.blockerJson));
  const state = TaskStateSchema.parse(task.state);
  return {
    taskId: task.id,
    state,
    branch: integrationBranch(jobId),
    baseSha: attempt?.baseSha ?? null,
    headSha: attempt?.headSha ?? null,
    merged:
      attempt === undefined
        ? []
        : integrationSources(db, task).map((s) => ({
            key: s.key,
            branch: s.branch,
            headSha: s.headSha,
          })),
    verification: runs.map((r) => ({
      key: r.commandKey,
      command: r.command,
      exitCode: r.exitCode,
      verdict: EvidenceVerdictSchema.parse(
        evidence.find((e) => e.verificationRunId === r.id)?.verdict ?? 'not_tested',
      ),
    })),
    problem:
      state === 'approved'
        ? null
        : (blocker?.detail ?? attempt?.exitDetail ?? `the Integration Task is ${state}`),
    foreignCommits: foreignCommitsOf(db, task.id),
    droppedCommits: foreignCommitsOf(db, task.id, undefined, 'dropped'),
  };
}
