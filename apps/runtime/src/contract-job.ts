/**
 * The contract step as a follow-up Job (ADR-0052, #110). `closure` opens one
 * `contract_job` item when the Plan deferred Tasks and every Repository's PR
 * has merged; a human's `start_job` creates the follow-up Job, in the same
 * transaction as the decision, with the deferred Tasks as its description.
 */
import { appendEvent, schema, type Tx } from '@factory/db';
import {
  CONTRACT_JOB_OPTIONS,
  contractJobItemText,
  contractJobOffered,
  contractJobRequest,
  DeliveryReportSchema,
  type CreateJobInput,
  type DeliveryReport,
  type ExpiresPolicy,
  type SourceIssue,
} from '@factory/domain';
import { and, eq } from 'drizzle-orm';
import { currentCriteria } from './criteria.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';

const KIND = 'contract_job';

/** Creates a Job inside the caller's transaction and returns its id. */
export type CreateJobIn = (
  tx: Tx,
  input: CreateJobInput,
  opts: { actor: string; followUpOf?: string; sourceIssue?: SourceIssue },
) => string;

/**
 * Opens the Job's `contract_job` item from its Delivery Report, when the
 * report lists a contract step and every Repository's PR merged; at most one
 * per Job, so a resumed closure never opens two. Returns its id, if opened.
 */
export function openContractJobItem(
  tx: Tx,
  ctx: { jobId: string; reportArtifactId: string; report: DeliveryReport; actor: string },
): string | undefined {
  const step = ctx.report.contractStep;
  if (step === null || !contractJobOffered(ctx.report.repositories.map((r) => r.status))) {
    return undefined;
  }
  const existing = tx
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.jobId, ctx.jobId), eq(schema.approvals.kind, KIND)))
    .get();
  if (existing !== undefined) return undefined;
  const id = newId('apr');
  const { question, why } = contractJobItemText(step);
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: ctx.jobId,
      stageRunId: null,
      kind: KIND,
      subjectRef: ctx.reportArtifactId,
      question,
      why,
      questionsJson: null,
      optionsJson: JSON.stringify(CONTRACT_JOB_OPTIONS),
      recommended: 'start_job',
      evidenceJson: JSON.stringify([ctx.reportArtifactId]),
      state: 'open',
      deferred: false,
      requestedBy: ctx.actor,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId: ctx.jobId,
    type: 'approval.opened',
    actor: ctx.actor,
    payload: {
      kind: KIND,
      subjectRef: ctx.reportArtifactId,
      tasks: step.tasks.map((t) => t.key),
      repositories: step.repositories,
    },
  });
  return id;
}

/**
 * A `start_job` decision: the follow-up Job over the contract step's
 * Repositories, in the Job's Project, with the deferred Tasks (and their
 * criteria's text from the Job's Specification) as its description. Returns
 * the new Job's id.
 */
export function startContractJob(
  tx: Tx,
  ctx: {
    item: { jobId: string; subjectRef: string };
    actor: string;
    readJson: (artifactId: string) => unknown;
    createJob: CreateJobIn;
  },
): string {
  const job = tx.select().from(schema.jobs).where(eq(schema.jobs.id, ctx.item.jobId)).get();
  if (job === undefined) throw new Error(`no Job ${ctx.item.jobId}`);
  const step = DeliveryReportSchema.parse(ctx.readJson(ctx.item.subjectRef)).contractStep;
  if (step === null) throw new Error(`report ${ctx.item.subjectRef} lists no contract step`);
  const request = contractJobRequest(job, step, currentCriteria(tx, job.id));
  const repositoryIds = request.repositories.map((name) => {
    const repo = tx
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(
        and(eq(schema.repositories.projectId, job.projectId), eq(schema.repositories.name, name)),
      )
      .get();
    if (repo === undefined) {
      throw new ApiFailure(
        409,
        'repository_not_found',
        `the contract step's Repository ${name} is no longer in the Job's Project`,
      );
    }
    return repo.id;
  });
  return ctx.createJob(
    tx,
    {
      project: job.projectId,
      repositoryIds,
      title: request.title,
      description: request.description,
    },
    { actor: ctx.actor, followUpOf: job.id },
  );
}
