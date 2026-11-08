/**
 * The Phase A Delivery Report (closure): what changed, the Evidence per
 * Acceptance Criterion, known limitations, and how to bring each Task Branch
 * from the Factory Clone into the source checkout.
 */
import { schema, type FactoryDb } from '@factory/db';
import {
  DeliveryReportSchema,
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
    'Not independently reviewed: approval rests on the factory’s own Gates (its verification runs and the criterion Evidence from them). The review Gate is not built yet.',
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
        const e = evidence.find((x) => x.criterionId === c.id);
        return {
          code: c.code,
          text: c.text,
          mandatory: c.mandatory,
          verdict: EvidenceVerdictSchema.parse(e?.verdict ?? 'not_tested'),
          detail: e?.detail ?? 'no Evidence',
        };
      }),
    });
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
    reportVersion: 1,
    job: { id: job.id, title: job.title },
    repository: { id: repo.id, name: repo.name, clonePath: repo.clonePath, source: repo.source },
    tasks: delivered,
    knownLimitations: limitations,
  } satisfies DeliveryReport);
}
