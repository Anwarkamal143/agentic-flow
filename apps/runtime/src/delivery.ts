/**
 * The Delivery Report v3 (closure, ADR-0028): how the Job ended, every Task
 * Branch with the leaves to fetch (one `git fetch` each, from the Factory
 * Clone into the source checkout), what changed, the Evidence per Acceptance
 * Criterion, the independent review, and known limitations. A failed Job's
 * report lists its approved branches as partial results.
 */
import { schema, type FactoryDb } from '@factory/db';
import {
  AttemptFindingSchema,
  combineVerdicts,
  DeliveryReportSchema,
  deliveryBranches,
  evidenceSource,
  isCurrent,
  EvidenceVerdictSchema,
  InboxQuestionSchema,
  RuleIssueSchema,
  TaskCancelReasonSchema,
  TaskDefinitionSchema,
  TaskStateSchema,
  type DeliveryReport,
} from '@factory/domain';
import { changedPaths, commitsBetween } from '@factory/git';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { criteriaCoveredBy, currentCriteria } from './criteria.js';
import { latestArtifact } from './plan-approval.js';

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

  const limitations = [
    'The Harness ran under the Tier 0 local guardrail (environment allowlist, closed stdin, the Worktree as working directory). It ran as your user; this is not a sandbox.',
    'Harness and verification output is not redacted yet.',
    'Delivery is a local branch in the Factory Clone; nothing was pushed.',
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
    .filter((t) => t.planArtifactId === plan?.id || worktrees.some((w) => w.taskId === t.id));
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
    const offered = mark?.offered === true && branch !== null;
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
  const execution = db
    .select({ state: schema.stageRuns.state })
    .from(schema.stageRuns)
    .where(and(eq(schema.stageRuns.jobId, jobId), eq(schema.stageRuns.stageId, 'execution')))
    .orderBy(desc(schema.stageRuns.attempt))
    .get();
  const outcome = execution?.state === 'failed' ? 'failed' : 'completed';
  const failedTasks = tasks
    .filter((t) => t.state === 'failed')
    .map((t) => `${t.key} (${latestAttempt(t.id)?.exitReason ?? 'factory_error'})`);
  const fetchCount = `${String(offered.length)} marked branch${offered.length === 1 ? '' : 'es'}`;
  const statement =
    outcome === 'failed'
      ? `The Job failed: Task${failedTasks.length === 1 ? '' : 's'} ${failedTasks.join(', ')} failed with no Rework route, and nothing else could make progress. ${
          offered.length === 0
            ? 'No Task was approved, so there is nothing to fetch.'
            : `The approved Task Branches are partial results: fetch the ${fetchCount} below.`
        } Failed and cancelled Tasks are listed, never offered.`
      : `The Job completed: every Task was approved. Fetch the ${fetchCount} below.`;
  const notes = [
    `The Task Branches are local branches in the Factory Clone at ${repo.clonePath} (ADR-0001); nothing was pushed. Run each fetch command from your own checkout.`,
    'Independent leaf branches are not combined before Phase C (no Integration Branch yet): combining them yourself may conflict, and the factory has not checked.',
  ];

  const delivered: DeliveryReport['tasks'] = [];
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
    reportVersion: 3,
    outcome,
    statement,
    job: { id: job.id, title: job.title },
    repository: { id: repo.id, name: repo.name, clonePath: repo.clonePath, source: repo.source },
    branches,
    notes,
    tasks: delivered,
    knownLimitations: limitations,
  } satisfies DeliveryReport);
}
