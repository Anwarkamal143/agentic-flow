/**
 * A triage-chosen Repository set (ADR-0052, ADR-0067). A Job created with no
 * Repository named, in a Project with several, has none until triage chooses
 * them from the Project's Repositories that have a section in the Job's frozen
 * Effective Configuration (so every chosen one runs under values frozen at
 * creation). The set is written once, when triage succeeds; a named set is
 * never changed. A chosen set of more than one waits for a human at
 * `plan_approval`, whatever the policy, until a Plan of the Job is approved.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  EffectiveConfigSchema,
  InboxDecisionSchema,
  RepositorySetBySchema,
  repositorySetNeedsConfirmation,
  triageRepositorySet,
  type TriageProposal,
} from '@factory/domain';
import { and, asc, eq } from 'drizzle-orm';
import { repositoriesOf, type JobRepository } from './plans.js';

/**
 * The Repositories triage chooses the Job's set from, by name; `null` when
 * the set is not triage's to choose (named by the operator, or already chosen).
 */
export function repositoryCandidatesOf(db: FactoryDb | Tx, jobId: string): JobRepository[] | null {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new Error(`no Job ${jobId}`);
  if (RepositorySetBySchema.parse(job.repositorySetBy) !== 'triage') return null;
  if (repositoriesOf(db, jobId).length > 0) return null;
  const frozen = new Set(
    EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson)).repositories.map(
      (r) => r.repositoryId,
    ),
  );
  return db
    .select({
      id: schema.repositories.id,
      name: schema.repositories.name,
      clonePath: schema.repositories.clonePath,
      defaultBranch: schema.repositories.defaultBranch,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.projectId, job.projectId))
    .orderBy(asc(schema.repositories.name), asc(schema.repositories.id))
    .all()
    .filter((r) => frozen.has(r.id));
}

/**
 * Writes the set a valid triage proposal chose as the Job's Repositories, with
 * a `job.repositories_chosen` event, in the transaction that stores the
 * proposal. Does nothing when the set is not triage's to choose.
 */
export function applyTriageRepositorySet(
  tx: Tx,
  input: { jobId: string; proposal: TriageProposal; artifactId: string; actor: string },
): void {
  const candidates = repositoryCandidatesOf(tx, input.jobId);
  if (candidates === null) return;
  const chosen = triageRepositorySet(input.proposal, candidates);
  if (chosen.length === 0) throw new Error('a valid triage proposal chose no Repository');
  for (const repo of chosen) {
    tx.insert(schema.jobRepositories).values({ jobId: input.jobId, repositoryId: repo.id }).run();
  }
  appendEvent(tx, {
    entityKind: 'job',
    entityId: input.jobId,
    jobId: input.jobId,
    type: 'job.repositories_chosen',
    actor: input.actor,
    payload: {
      repositoryIds: chosen.map((r) => r.id),
      names: chosen.map((r) => r.name),
      triageArtifactId: input.artifactId,
    },
  });
}

/**
 * Whether the Job's `plan_approval` must wait for a human whatever the policy:
 * a triage-chosen set of more than one, while no `plan` item of the Job has
 * been decided `approve`. Returns the set's names when it must.
 */
export function repositorySetToConfirm(db: FactoryDb | Tx, jobId: string): string[] | null {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (job === undefined) throw new Error(`no Job ${jobId}`);
  const repositories = repositoriesOf(db, jobId);
  const confirmed = db
    .select({ decisionJson: schema.approvals.decisionJson })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.jobId, jobId),
        eq(schema.approvals.kind, 'plan'),
        eq(schema.approvals.state, 'decided'),
      ),
    )
    .all()
    .some(
      (a) =>
        a.decisionJson !== null &&
        InboxDecisionSchema.parse(JSON.parse(a.decisionJson)).option === 'approve',
    );
  const needed = repositorySetNeedsConfirmation({
    setBy: RepositorySetBySchema.parse(job.repositorySetBy),
    count: repositories.length,
    confirmed,
  });
  return needed ? repositories.map((r) => r.name).sort() : null;
}
