/**
 * GitHub Issues intake (#112, ADR-0072; PRODUCT_SPEC §5, Phase D Q15, Q33).
 *
 * - A Repository with GitHub Coordinates opts in with an intake label. Every
 *   `github.pollIntervalMs` the intake poller lists its open issues with that
 *   label (a conditional request: the ETag is kept in memory, a 304 changes
 *   nothing) and offers each one it has not seen as an `issue_job` Approval
 *   "Start a Job from owner/name#N?".
 * - An open offer whose issue is no longer listed is read once: closed or
 *   unlabeled, the item is cancelled by `system:github-intake`. It is never
 *   approved by the system: only a human's `start_job` creates the Job.
 * - `issue_intakes` holds at most one row per issue, so an issue starts at
 *   most one Job; the text kept is the issue as it was when offered, and
 *   later edits are not picked up.
 * - `job create --from-issue owner/name#N` (`createFromIssue`) reads the
 *   issue and creates the Job at once, the operator's own choice.
 *
 * The issue's text is GitHub content: the Job's description labels it
 * untrusted (`issueJobRequest`), and the DB redacts it like any text.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  INTAKE_ITEM_OPTIONS,
  intakeCancelReason,
  intakeItemText,
  intakeOffers,
  issueJobRequest,
  issueLabel,
  IssueIntakeStateSchema,
  parseIssueRef,
  type CreateJobFromIssueInput,
  type ExpiresPolicy,
  type IntakeCancelReason,
  type IssueRef,
  type SourceIssue,
} from '@factory/domain';
import {
  describeGitHubFailure,
  pauseInForce,
  type GitHubPort,
  type GitHubRead,
  type Issue,
  type RateLimitGate,
} from '@factory/github';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { CreateJobIn } from './contract-job.js';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';
import { PassLoop } from './pass-loop.js';

/** The actor of everything the intake does on its own: offering, and cancelling. */
export const INTAKE_ACTOR = 'system:github-intake';
const KIND = 'issue_job';
const OPERATOR = 'user:local';

type RepositoryRow = typeof schema.repositories.$inferSelect;
type IntakeRow = typeof schema.issueIntakes.$inferSelect;

function refOf(repo: RepositoryRow, number: number): IssueRef {
  if (repo.githubOwner === null || repo.githubName === null) {
    throw new Error(`Repository ${repo.id} has no GitHub coordinates`);
  }
  return { owner: repo.githubOwner, name: repo.githubName, number };
}

function requireRepository(db: FactoryDb | Tx, id: string): RepositoryRow {
  const repo = db.select().from(schema.repositories).where(eq(schema.repositories.id, id)).get();
  if (repo === undefined) throw new Error(`no Repository ${id}`);
  return repo;
}

/** The Repository (and its Project) of an `issue_job` item, for its Inbox view. */
export function intakeOfItem(
  db: FactoryDb | Tx,
  approvalId: string,
): { repositoryId: string; projectId: string } | undefined {
  return db
    .select({
      repositoryId: schema.issueIntakes.repositoryId,
      projectId: schema.repositories.projectId,
    })
    .from(schema.issueIntakes)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.issueIntakes.repositoryId))
    .where(eq(schema.issueIntakes.approvalId, approvalId))
    .get();
}

/** Moves the intake row on, guarded by its version. */
function stepIntake(tx: Tx, row: IntakeRow, values: Partial<IntakeRow>): void {
  const updated = tx
    .update(schema.issueIntakes)
    .set({ ...values, version: sql`${schema.issueIntakes.version} + 1` })
    .where(and(eq(schema.issueIntakes.id, row.id), eq(schema.issueIntakes.version, row.version)))
    .run();
  if (updated.changes !== 1) throw new Error(`issue intake ${row.id} changed under its own update`);
}

function sourceIssueOf(
  repo: RepositoryRow,
  row: { number: number; url: string },
  via: SourceIssue['via'],
): SourceIssue {
  const ref = refOf(repo, row.number);
  return { ...ref, repositoryId: repo.id, url: row.url, via };
}

/**
 * A human's decision on an `issue_job` item, inside its transaction:
 * `start_job` creates the Job (the issue's Repository, its text as the
 * untrusted description, linked to the issue) and links the item to it;
 * `decline` creates none. Returns the new Job's id, if any.
 */
export function decideIssueJob(
  tx: Tx,
  ctx: { approvalId: string; option: string; actor: string; createJob: CreateJobIn },
): string | undefined {
  const row = tx
    .select()
    .from(schema.issueIntakes)
    .where(eq(schema.issueIntakes.approvalId, ctx.approvalId))
    .get();
  if (row === undefined || row.state !== 'offered') {
    throw new Error(`issue_job item ${ctx.approvalId} has no open offer`);
  }
  if (ctx.option !== 'start_job') {
    stepIntake(tx, row, { state: 'declined' });
    return undefined;
  }
  const repo = requireRepository(tx, row.repositoryId);
  const ref = refOf(repo, row.number);
  const request = issueJobRequest({ ref, title: row.title, body: row.body, url: row.url });
  const jobId = ctx.createJob(
    tx,
    { project: repo.projectId, repositoryIds: [repo.id], ...request },
    { actor: ctx.actor, sourceIssue: sourceIssueOf(repo, row, 'intake') },
  );
  stepIntake(tx, row, { state: 'job_created', jobId });
  // The item is now the Job's: it links the Job to the decision that started it.
  tx.update(schema.approvals).set({ jobId }).where(eq(schema.approvals.id, ctx.approvalId)).run();
  return jobId;
}

/**
 * Cancels a Repository's open offers, inside the caller's transaction (its
 * intake turned off, or the issue closed or unlabeled). Never a decision.
 */
function cancelOffer(
  tx: Tx,
  row: IntakeRow,
  reason: IntakeCancelReason | 'intake_off',
  actor: string,
): boolean {
  if (row.approvalId === null) return false;
  const item = tx
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.id, row.approvalId))
    .get();
  if (item?.state !== 'open') return false;
  const now = new Date().toISOString();
  const updated = tx
    .update(schema.approvals)
    .set({
      state: 'cancelled',
      decidedBy: actor,
      decidedAt: now,
      version: sql`${schema.approvals.version} + 1`,
    })
    .where(and(eq(schema.approvals.id, item.id), eq(schema.approvals.version, item.version)))
    .run();
  if (updated.changes !== 1) throw new Error(`Inbox Item ${item.id} changed under its own update`);
  stepIntake(tx, row, { state: 'cancelled' });
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: item.id,
    type: 'approval.cancelled',
    actor,
    payload: { kind: KIND, subjectRef: item.subjectRef, reason },
  });
  return true;
}

/** `repo intake off`: the Repository's open offers are cancelled with it. */
export function cancelOpenOffers(tx: Tx, repositoryId: string, actor: string): void {
  const rows = tx
    .select()
    .from(schema.issueIntakes)
    .where(
      and(
        eq(schema.issueIntakes.repositoryId, repositoryId),
        eq(schema.issueIntakes.state, 'offered'),
      ),
    )
    .all();
  for (const row of rows) cancelOffer(tx, row, 'intake_off', actor);
}

/** Offers `issue` of `repo` as an `issue_job` item, unless it was offered meanwhile. */
function offer(tx: Tx, repo: RepositoryRow, issue: Issue): boolean {
  const existing = tx
    .select()
    .from(schema.issueIntakes)
    .where(
      and(
        eq(schema.issueIntakes.repositoryId, repo.id),
        eq(schema.issueIntakes.number, issue.number),
      ),
    )
    .get();
  if (existing !== undefined && existing.state !== 'cancelled') return false;
  const ref = refOf(repo, issue.number);
  const approvalId = newId('apr');
  const now = new Date().toISOString();
  const { question, why } = intakeItemText(ref, issue.title);
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id: approvalId,
      jobId: null,
      stageRunId: null,
      kind: KIND,
      subjectRef: issueLabel(ref),
      question,
      why,
      questionsJson: null,
      optionsJson: JSON.stringify(INTAKE_ITEM_OPTIONS),
      // Starting work from a stranger's text is the human's call: no option is recommended.
      recommended: null,
      evidenceJson: JSON.stringify([]),
      state: 'open',
      deferred: false,
      requestedBy: INTAKE_ACTOR,
      expiresPolicy,
      createdAt: now,
      version: 0,
    })
    .run();
  const snapshot = { title: issue.title, body: issue.body, url: issue.htmlUrl, approvalId };
  if (existing === undefined) {
    tx.insert(schema.issueIntakes)
      .values({
        id: newId('iss'),
        repositoryId: repo.id,
        number: issue.number,
        ...snapshot,
        state: 'offered',
        jobId: null,
        createdAt: now,
        version: 0,
      })
      .run();
  } else {
    stepIntake(tx, existing, { ...snapshot, state: 'offered' });
  }
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: approvalId,
    type: 'approval.opened',
    actor: INTAKE_ACTOR,
    payload: {
      kind: KIND,
      subjectRef: issueLabel(ref),
      repositoryId: repo.id,
      label: repo.intakeLabel,
    },
  });
  return true;
}

export interface IntakePollerDeps {
  db: FactoryDb;
  github: Pick<GitHubPort, 'listIssues' | 'getIssue'>;
  /** The GitHub-wide pause: nothing is read while it holds one (ADR-0045). */
  pause: Pick<RateLimitGate, 'current'>;
  pollIntervalMs: number;
  onCommit: () => void;
  log: (message: string) => void;
}

/** The intake poller: each intake Repository's labeled issues, offered and cancelled. */
export class IssueIntakePoller {
  private readonly loop: PassLoop;
  /** The last ETag and list of each Repository's labeled issues. In memory only. */
  private readonly seen = new Map<string, { etag: string; value: Issue[] }>();

  constructor(private readonly deps: IntakePollerDeps) {
    this.loop = new PassLoop(() => this.pass(), deps.pollIntervalMs);
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

  private async pass(): Promise<boolean> {
    const repos = this.deps.db
      .select()
      .from(schema.repositories)
      .where(
        and(
          isNotNull(schema.repositories.intakeLabel),
          isNotNull(schema.repositories.githubOwner),
          isNotNull(schema.repositories.githubName),
        ),
      )
      .all();
    for (const repo of repos) {
      if (pauseInForce(this.deps.pause.current())) return false;
      try {
        await this.poll(repo);
      } catch (err) {
        if (!(err instanceof ReadFailed)) throw err;
        this.deps.log(`github intake: ${repo.name}: ${err.message}`);
      }
    }
    return false;
  }

  private async poll(repo: RepositoryRow): Promise<void> {
    const label = repo.intakeLabel;
    if (label === null) return;
    const coordinates = refOf(repo, 1);
    const key = `${repo.id}:${label}`;
    const cached = this.seen.get(key);
    const listed = unwrap(
      await this.deps.github.listIssues(
        coordinates,
        label,
        cached === undefined ? {} : { etag: cached.etag },
      ),
      cached?.value,
    );
    if (listed.etag !== null) this.seen.set(key, { etag: listed.etag, value: listed.value });
    if (listed.notModified) return;
    const known = this.deps.db
      .select()
      .from(schema.issueIntakes)
      .where(eq(schema.issueIntakes.repositoryId, repo.id))
      .all();
    const plan = intakeOffers(
      listed.value.map((i) => i.number),
      known.map((k) => ({ number: k.number, state: IssueIntakeStateSchema.parse(k.state) })),
    );
    let changed = false;
    for (const number of plan.offer) {
      const issue = listed.value.find((i) => i.number === number);
      if (issue === undefined) continue;
      changed =
        this.deps.db.transaction((tx) => offer(tx, repo, issue), { behavior: 'immediate' }) ||
        changed;
    }
    for (const number of plan.vanished) {
      const res = await this.deps.github.getIssue(coordinates, number);
      if (!res.ok) {
        this.deps.log(
          `github intake: ${issueLabel(refOf(repo, number))}: ${describeGitHubFailure(res.failure)}`,
        );
        continue;
      }
      const reason = intakeCancelReason(res.value, label);
      // Still open and labeled: listed beyond the first page, say. The offer stays.
      if (reason === null) continue;
      changed =
        this.deps.db.transaction(
          (tx) => {
            const row = tx
              .select()
              .from(schema.issueIntakes)
              .where(
                and(
                  eq(schema.issueIntakes.repositoryId, repo.id),
                  eq(schema.issueIntakes.number, number),
                ),
              )
              .get();
            return row?.state === 'offered' && cancelOffer(tx, row, reason, INTAKE_ACTOR);
          },
          { behavior: 'immediate' },
        ) || changed;
    }
    if (changed) this.deps.onCommit();
  }
}

/** A failed read: nothing is recorded for the Repository; the next poll reads again. */
class ReadFailed extends Error {}

function unwrap(
  res: GitHubRead<Issue[]>,
  cached: Issue[] | undefined,
): { notModified: boolean; value: Issue[]; etag: string | null } {
  if (!res.ok) throw new ReadFailed(describeGitHubFailure(res.failure));
  if (res.notModified) {
    if (cached === undefined) throw new ReadFailed('304 without a list read before');
    return { notModified: true, value: cached, etag: res.etag };
  }
  return { notModified: false, value: res.value, etag: res.etag };
}

/**
 * `job create --from-issue owner/name#N` (#112): reads the issue of a
 * registered Repository and creates its Job at once, the operator's choice.
 * Refused while the issue has an open intake item, or once it started a Job.
 * Returns the new Job's id.
 */
export async function createFromIssue(
  ctx: {
    db: FactoryDb;
    github: Pick<GitHubPort, 'getIssue'>;
    createJob: CreateJobIn;
  },
  input: CreateJobFromIssueInput,
): Promise<string> {
  const parsed = parseIssueRef(input.issue);
  if (!parsed.ok) throw new ApiFailure(400, 'invalid_issue', parsed.error);
  const { ref } = parsed;
  const repo = ctx.db
    .select()
    .from(schema.repositories)
    .where(
      and(
        sql`lower(${schema.repositories.githubOwner}) = ${ref.owner.toLowerCase()}`,
        sql`lower(${schema.repositories.githubName}) = ${ref.name.toLowerCase()}`,
      ),
    )
    .get();
  if (repo === undefined) {
    throw new ApiFailure(
      404,
      'repository_not_found',
      `no registered Repository is on GitHub as ${ref.owner}/${ref.name}. Register it with: factory repo add <path> --github ${ref.owner}/${ref.name}`,
    );
  }
  refuseTaken(ctx.db, repo.id, ref);
  const res = await ctx.github.getIssue(refOf(repo, ref.number), ref.number);
  if (!res.ok) {
    throw new ApiFailure(
      res.failure.kind === 'refused' ? 409 : 502,
      'issue_not_read',
      `could not read ${issueLabel(ref)} from GitHub: ${describeGitHubFailure(res.failure)}`,
    );
  }
  const issue = res.value;
  return ctx.db.transaction(
    (tx) => {
      const row = refuseTaken(tx, repo.id, ref);
      const request = issueJobRequest({
        ref: refOf(repo, ref.number),
        title: issue.title,
        body: issue.body,
        url: issue.htmlUrl,
      });
      const repositoryIds = [
        repo.id,
        ...(input.repositoryIds ?? []).filter((id) => id !== repo.id),
      ];
      const jobId = ctx.createJob(
        tx,
        {
          project: repo.projectId,
          repositoryIds,
          ...request,
          ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
          ...(input.mergePolicy === undefined ? {} : { mergePolicy: input.mergePolicy }),
        },
        {
          actor: OPERATOR,
          sourceIssue: sourceIssueOf(repo, { number: ref.number, url: issue.htmlUrl }, 'manual'),
        },
      );
      const snapshot = { title: issue.title, body: issue.body, url: issue.htmlUrl };
      if (row === undefined) {
        tx.insert(schema.issueIntakes)
          .values({
            id: newId('iss'),
            repositoryId: repo.id,
            number: ref.number,
            ...snapshot,
            state: 'job_created',
            approvalId: null,
            jobId,
            createdAt: new Date().toISOString(),
            version: 0,
          })
          .run();
      } else {
        stepIntake(tx, row, { ...snapshot, state: 'job_created', jobId });
      }
      return jobId;
    },
    { behavior: 'immediate' },
  );
}

/** Refuses an issue that already started a Job or has an open intake item; returns its row. */
function refuseTaken(
  db: FactoryDb | Tx,
  repositoryId: string,
  ref: IssueRef,
): IntakeRow | undefined {
  const row = db
    .select()
    .from(schema.issueIntakes)
    .where(
      and(
        eq(schema.issueIntakes.repositoryId, repositoryId),
        eq(schema.issueIntakes.number, ref.number),
      ),
    )
    .get();
  if (row?.state === 'job_created') {
    throw new ApiFailure(
      409,
      'issue_has_job',
      `${issueLabel(ref)} already started Job ${row.jobId ?? '?'}: an issue starts at most one Job`,
    );
  }
  if (row?.state === 'offered') {
    throw new ApiFailure(
      409,
      'issue_offered',
      `${issueLabel(ref)} waits in the Inbox as item ${row.approvalId ?? '?'}: decide it (factory inbox decide ${row.approvalId ?? '<id>'} start_job --expect-version <n>)`,
    );
  }
  return row;
}
