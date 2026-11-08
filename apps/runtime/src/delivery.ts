/**
 * The Phase A Delivery Report (closure): what changed, the Evidence per
 * Acceptance Criterion, the independent review, known limitations, and how to
 * bring each Task Branch from the Factory Clone into the source checkout.
 */
import { schema, type FactoryDb } from '@factory/db';
import {
  combineVerdicts,
  DeliveryReportSchema,
  isCurrent,
  EvidenceVerdictSchema,
  RuleIssueSchema,
  TaskDefinitionSchema,
  type DeliveryReport,
} from '@factory/domain';
import { changedPaths, commitsBetween } from '@factory/git';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { criteriaCoveredBy } from './criteria.js';

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
    'The path-scope Gate is not built yet: changed paths were not checked against the Task’s writable and forbidden scope.',
    'The Harness ran under the Tier 0 local guardrail (environment allowlist, closed stdin, the Worktree as working directory). It ran as your user; this is not a sandbox.',
    'Harness and verification output is not redacted yet.',
    'Delivery is a local branch in the Factory Clone; nothing was pushed.',
  ];

  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.jobId, jobId))
    .orderBy(asc(sql`rowid`))
    .all();
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

    if (attempt.wipCommit !== null) {
      limitations.push(
        `Task ${task.key}: the Harness left uncommitted changes; the factory committed them as WIP commit ${attempt.wipCommit}. Review them before using the branch.`,
      );
    }
    for (const v of z.array(RuleIssueSchema).parse(JSON.parse(attempt.protocolViolationsJson))) {
      limitations.push(`Task ${task.key}: protocol violation [${v.rule}] ${v.message}`);
    }
    const commits = await commitsBetween(repo.clonePath, attempt.baseSha, attempt.headSha);
    delivered.push({
      key: task.key,
      title: task.title,
      attemptId: attempt.id,
      branch: worktree.branch,
      baseSha: attempt.baseSha,
      headSha: attempt.headSha,
      fetchCommand: fetchCommand(repo.clonePath, worktree.branch),
      commits,
      changedFiles: await changedPaths(repo.clonePath, attempt.baseSha, attempt.headSha),
      wipCommit: attempt.wipCommit,
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
              : current
                  .map(
                    (e) =>
                      `${e.reviewId === null ? 'commands' : 'review'}: ${e.verdict} (${e.detail})`,
                  )
                  .join('; '),
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
  const allCriteria = db
    .select()
    .from(schema.acceptanceCriteria)
    .where(eq(schema.acceptanceCriteria.jobId, jobId))
    .all();
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
    reportVersion: 2,
    job: { id: job.id, title: job.title },
    repository: { id: repo.id, name: repo.name, clonePath: repo.clonePath, source: repo.source },
    tasks: delivered,
    knownLimitations: limitations,
  } satisfies DeliveryReport);
}
