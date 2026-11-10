/**
 * The Inbox (PRODUCT_SPEC §10, ADR-0016): Inbox Items, their versioned
 * decisions, defer and undefer, and the plan operations `approvePlan`,
 * `rejectPlan`, `requestPlanChanges` and `editPlan` (ADR-0019) with the plan
 * approval view. Every decision names the item's version and subject, and only
 * a human actor decides.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  ApprovalOptionSchema,
  ApprovalSchema,
  checkInboxChange,
  checkPlanChangeRequest,
  EffectiveConfigSchema,
  humanDecisionPoints,
  InboxDecisionSchema,
  parallelWaves,
  planEstimate,
  PlanProposalSchema,
  RiskSchema,
  schemaIssues,
  TaskDefinitionSchema,
  TriageProposalSchema,
  validatePlan,
  WorkflowSnapshotSchema,
  type Approval,
  type Billing,
  type DecideInput,
  type DeferInput,
  type EditPlanInput,
  type InboxRefusal,
  type PlanChangeRefusal,
  type PlanDecisionInput,
  type PlanView,
  type RequestPlanChangesInput,
} from '@factory/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ArtifactStore } from './artifacts.js';
import { changeJob, type StageRunStepper } from './engine.js';
import { ApiFailure } from './errors.js';
import { latestArtifact, openPlanItem, queueNextStage, startReplan } from './plan-approval.js';
import { cancelPlanTasks, persistPlanTasks, planContextOf, repositoriesOf } from './plans.js';

type ApprovalRow = typeof schema.approvals.$inferSelect;

const REFUSAL_STATUS: Readonly<Record<InboxRefusal['code'], 400 | 403 | 409>> = {
  actor_not_allowed: 403,
  item_not_open: 409,
  version_conflict: 409,
  subject_mismatch: 409,
  unknown_option: 400,
};

const PLAN_CHANGE_STATUS: Readonly<Record<PlanChangeRefusal['code'], 400 | 409>> = {
  feedback_required: 400,
  replan_limit_reached: 409,
};

export class InboxService {
  constructor(
    private readonly db: FactoryDb,
    private readonly artifacts: ArtifactStore,
    /** Called after every committed change (wakes the outbox and the schedulers). */
    private readonly onCommit: () => void,
    /** The configured Harness's billing, for the estimate; `null` when it has none. */
    private readonly billing: Billing | null,
  ) {}

  /** Open items not deferred, oldest first; `all` lists every item. */
  list(opts: { all: boolean }): Approval[] {
    const rows = this.db
      .select()
      .from(schema.approvals)
      .where(
        opts.all
          ? undefined
          : and(eq(schema.approvals.state, 'open'), eq(schema.approvals.deferred, false)),
      )
      .orderBy(asc(schema.approvals.createdAt), asc(sql`"approvals"."rowid"`))
      .all();
    return rows.map((r) => this.toApproval(r));
  }

  get(id: string): Approval {
    return this.toApproval(requireItem(this.db, id));
  }

  /** Decides an item, refused unless it names the open item's version and subject. */
  decide(id: string, input: DecideInput, actor: string): Approval {
    const item = requireItem(this.db, id);
    changeJob(this.db, { jobId: item.jobId, expectedVersion: 'current', actor }, (tx, _s, step) => {
      const row = requireItem(tx, id);
      refuseUnless(row, { actor, ...input });
      if (row.kind === 'plan' && input.option === 'request_changes') {
        refuseReplanUnless(tx, row.jobId, input.comment);
      }
      const now = new Date().toISOString();
      const decision = InboxDecisionSchema.parse({
        option: input.option,
        comment: input.comment ?? null,
      });
      bumpItem(tx, row, {
        state: 'decided',
        decidedBy: actor,
        decidedAt: now,
        decisionJson: JSON.stringify(decision),
      });
      appendEvent(tx, {
        entityKind: 'approval',
        entityId: id,
        jobId: row.jobId,
        type: 'approval.decided',
        actor,
        payload: { kind: row.kind, subjectRef: row.subjectRef, ...decision },
      });
      if (row.kind === 'plan') applyPlanDecision(tx, row, input.option, step, actor);
      else throw new ApiFailure(409, 'not_decidable', `no ${row.kind} items are decided yet`);
    });
    this.onCommit();
    return this.get(id);
  }

  defer(id: string, input: DeferInput, actor: string, deferred: boolean): Approval {
    this.db.transaction(
      (tx) => {
        const row = requireItem(tx, id);
        refuseUnless(row, { actor, expectedVersion: input.expectedVersion });
        if (row.deferred === deferred) {
          throw new ApiFailure(
            409,
            deferred ? 'already_deferred' : 'not_deferred',
            `the item is ${deferred ? 'already' : 'not'} deferred`,
          );
        }
        bumpItem(tx, row, { deferred });
        appendEvent(tx, {
          entityKind: 'approval',
          entityId: id,
          jobId: row.jobId,
          type: deferred ? 'approval.deferred' : 'approval.undeferred',
          actor,
          payload: { kind: row.kind },
        });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return this.get(id);
  }

  /** `approvePlan` / `rejectPlan`: decides the Job's open `plan` item. */
  decidePlan(
    jobId: string,
    option: 'approve' | 'reject',
    input: PlanDecisionInput,
    actor: string,
  ): Approval {
    const item = this.openPlanItemOf(jobId);
    return this.decide(
      item.id,
      {
        expectedVersion: input.expectedVersion,
        subjectRef: input.planArtifactId,
        option,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
      },
      actor,
    );
  }

  /**
   * `requestPlanChanges`: a Replan of the waiting Plan with the human's
   * feedback (ARCHITECTURE §4.7). Refused at `maxReplans`.
   */
  requestPlanChanges(jobId: string, input: RequestPlanChangesInput, actor: string): Approval {
    const item = this.openPlanItemOf(jobId);
    return this.decide(
      item.id,
      {
        expectedVersion: input.expectedVersion,
        subjectRef: input.planArtifactId,
        option: 'request_changes',
        comment: input.feedback,
      },
      actor,
    );
  }

  /**
   * `editPlan` (a Plan Edit, not a Replan): the human's whole replacement Plan,
   * checked by the planner's validator. Invalid: refused with every issue, and
   * nothing changes (no re-prompt; the planner is not involved). Valid: a new
   * plan Artifact by `actor`, the replaced Plan's Tasks cancelled and the new
   * Plan's created, the open item `superseded` and a new one opened on the
   * same Stage Run. Returns the new item.
   */
  async editPlan(jobId: string, input: EditPlanInput, actor: string): Promise<Approval> {
    const item = this.openPlanItemOf(jobId);
    const change = {
      actor,
      expectedVersion: input.expectedVersion,
      subjectRef: input.planArtifactId,
    };
    refuseUnless(item, change);
    const parsed = PlanProposalSchema.safeParse(input.plan);
    if (!parsed.success) throw invalidPlan(schemaIssues(parsed.error));
    const plan = parsed.data;
    const issues = validatePlan(
      plan,
      await planContextOf(this.db, jobId, repositoriesOf(this.db, jobId)),
    );
    if (issues.length > 0) throw invalidPlan(issues);
    const content = this.artifacts.writeContent(plan);
    const newItemId = changeJob(this.db, { jobId, expectedVersion: 'current', actor }, (tx) => {
      const row = requireItem(tx, item.id);
      refuseUnless(row, change);
      if (row.stageRunId === null) throw new Error(`plan item ${row.id} holds no Stage Run`);
      const artifact = this.artifacts.record(tx, { jobId, kind: 'plan', content }, actor);
      cancelPlanTasks(tx, { jobId, actor }, row.subjectRef, 'plan_edited');
      persistPlanTasks(tx, plan, { jobId, artifactId: artifact.id, actor });
      bumpItem(tx, row, { state: 'superseded' });
      const opened = openPlanItem(tx, jobId, row.stageRunId, actor);
      appendEvent(tx, {
        entityKind: 'approval',
        entityId: row.id,
        jobId,
        type: 'approval.superseded',
        actor,
        payload: {
          kind: row.kind,
          subjectRef: row.subjectRef,
          reason: 'plan_edited',
          planArtifactId: artifact.id,
          supersededBy: opened,
        },
      });
      return opened;
    });
    this.onCommit();
    return this.get(newItemId);
  }

  /** The Job's open `plan` item, or 409 `no_open_plan_approval`. */
  private openPlanItemOf(jobId: string): ApprovalRow {
    const item = this.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.jobId, jobId),
          eq(schema.approvals.kind, 'plan'),
          eq(schema.approvals.state, 'open'),
        ),
      )
      .get();
    if (item === undefined) {
      requireJob(this.db, jobId);
      throw new ApiFailure(
        409,
        'no_open_plan_approval',
        `Job ${jobId} has no Plan waiting for approval`,
      );
    }
    return item;
  }

  /** The plan approval view of the Job's newest Plan (PRODUCT_SPEC §7). */
  planView(jobId: string): PlanView {
    const job = requireJob(this.db, jobId);
    const plan = latestArtifact(this.db, jobId, 'plan');
    if (plan === undefined) throw new ApiFailure(404, 'no_plan', `Job ${jobId} has no Plan yet`);
    const spec = latestArtifact(this.db, jobId, 'spec');
    const triage = latestArtifact(this.db, jobId, 'triage');
    const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
    const tasks = this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.planArtifactId, plan.id))
      .orderBy(asc(sql`"tasks"."rowid"`))
      .all()
      .map((t) => {
        const d = TaskDefinitionSchema.parse(JSON.parse(t.definitionJson));
        return {
          id: t.id,
          key: t.key,
          title: t.title,
          objective: d.objective,
          repositoryId: t.repositoryId,
          state: t.state,
          risk: d.risk,
          dependsOn: d.dependsOn,
          acceptance: d.acceptance,
          writable: d.scope.writable,
          maxAttempts: t.maxAttempts,
          maxRetries: t.maxRetries,
        };
      });
    const repoIds = [...new Set(tasks.map((t) => t.repositoryId))];
    const repositories =
      repoIds.length === 0
        ? []
        : this.db
            .select({ id: schema.repositories.id, name: schema.repositories.name })
            .from(schema.repositories)
            .where(inArray(schema.repositories.id, repoIds))
            .all();
    const item = this.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.kind, 'plan'), eq(schema.approvals.subjectRef, plan.id)))
      .orderBy(asc(sql`"approvals"."rowid"`))
      .all()
      .at(-1);
    const triageRisk =
      triage === undefined
        ? null
        : RiskSchema.parse(TriageProposalSchema.parse(this.artifacts.readJson(triage.id)).risk);
    const created = this.db
      .select({ actor: schema.events.actor })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityKind, 'artifact'),
          eq(schema.events.entityId, plan.id),
          eq(schema.events.type, 'artifact.created'),
        ),
      )
      .get();
    if (created === undefined) throw new Error(`Plan ${plan.id} has no artifact.created event`);
    return {
      job: { id: job.id, title: job.title, status: job.status, version: job.version },
      planArtifactId: plan.id,
      planAuthoredBy: created.actor,
      replans: { used: job.replansUsed, max: config.maxReplans.value },
      specification: spec === undefined ? null : this.artifacts.readJson(spec.id),
      specificationArtifactId: spec?.id ?? null,
      triageRisk,
      repositories,
      tasks,
      parallel: parallelWaves(tasks),
      decisionPoints: humanDecisionPoints(
        WorkflowSnapshotSchema.parse(JSON.parse(job.workflowSnapshotJson)),
        { planApproval: config.planApproval.value },
      ),
      estimate: planEstimate(tasks, {
        maxQuestions: config.maxQuestions.value,
        billing: this.billing,
      }),
      approval: item === undefined ? null : this.toApproval(item),
    };
  }

  private toApproval(row: ApprovalRow): Approval {
    const job = requireJob(this.db, row.jobId);
    const link = this.db
      .select()
      .from(schema.jobRepositories)
      .where(eq(schema.jobRepositories.jobId, row.jobId))
      .get();
    const stage =
      row.stageRunId === null
        ? undefined
        : this.db
            .select({ stageId: schema.stageRuns.stageId })
            .from(schema.stageRuns)
            .where(eq(schema.stageRuns.id, row.stageRunId))
            .get();
    return ApprovalSchema.parse({
      id: row.id,
      jobId: row.jobId,
      jobTitle: job.title,
      projectId: job.projectId,
      repositoryId: link?.repositoryId ?? '',
      taskId: row.taskId,
      stageId: stage?.stageId ?? null,
      kind: row.kind,
      subjectRef: row.subjectRef,
      question: row.question,
      why: row.why,
      options: ApprovalOptionSchema.array().parse(JSON.parse(row.optionsJson)),
      recommended: row.recommended,
      evidence: JSON.parse(row.evidenceJson) as unknown,
      state: row.state,
      deferred: row.deferred,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      decision: row.decisionJson === null ? null : (JSON.parse(row.decisionJson) as unknown),
      expiresPolicy: row.expiresPolicy,
      version: row.version,
      createdAt: row.createdAt,
    } satisfies Record<keyof Approval, unknown>);
  }
}

/**
 * Approve: `plan_approval` succeeds and the next Stage (execution) is queued.
 * Reject: it ends `rejected`, so the Job is `rejected`; the Plan's Tasks that
 * never ran are cancelled, and every Artifact is kept.
 * Request changes: a Replan (`startReplan`); the cap was checked first.
 */
function applyPlanDecision(
  tx: Tx,
  item: ApprovalRow,
  option: string,
  step: StageRunStepper,
  actor: string,
): void {
  const run =
    item.stageRunId === null
      ? undefined
      : tx.select().from(schema.stageRuns).where(eq(schema.stageRuns.id, item.stageRunId)).get();
  if (run?.state !== 'waiting_human') {
    throw new Error(`plan item ${item.id} holds no waiting Stage Run`);
  }
  if (option === 'approve') {
    step(run, 'succeeded', { reason: `Plan ${item.subjectRef} approved by ${actor}` });
    queueNextStage(tx, item.jobId, step, run.position, actor);
    return;
  }
  if (option === 'request_changes') {
    startReplan(
      tx,
      { jobId: item.jobId, run, planArtifactId: item.subjectRef, approvalId: item.id },
      step,
      actor,
    );
    return;
  }
  step(run, 'rejected', { reason: `Plan ${item.subjectRef} rejected by ${actor}` });
  cancelPlanTasks(tx, { jobId: item.jobId, actor }, item.subjectRef, 'plan_rejected');
}

/** Refuses "request changes" without feedback or at `maxReplans` (ADR-0019). */
function refuseReplanUnless(tx: Tx, jobId: string, feedback: string | undefined): void {
  const job = requireJob(tx, jobId);
  const config = EffectiveConfigSchema.parse(JSON.parse(job.configSnapshotJson));
  const refusal = checkPlanChangeRequest(
    { replansUsed: job.replansUsed, maxReplans: config.maxReplans.value },
    feedback,
  );
  if (refusal !== undefined) {
    throw new ApiFailure(PLAN_CHANGE_STATUS[refusal.code], refusal.code, refusal.message);
  }
}

/** 422 `invalid_plan`, naming every issue, for a Plan Edit. */
function invalidPlan(issues: readonly { rule: string; message: string }[]): ApiFailure {
  return new ApiFailure(
    422,
    'invalid_plan',
    `the edited Plan is invalid: ${issues.map((i) => `[${i.rule}] ${i.message}`).join('; ')}`,
  );
}

/** Cancels a Job's open Inbox Items, inside the Job's cancel transaction. */
export function cancelOpenItems(tx: Tx, jobId: string, actor: string): void {
  const open = tx
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.jobId, jobId), eq(schema.approvals.state, 'open')))
    .all();
  for (const row of open) {
    bumpItem(tx, row, { state: 'cancelled' });
    appendEvent(tx, {
      entityKind: 'approval',
      entityId: row.id,
      jobId,
      type: 'approval.cancelled',
      actor,
      payload: { kind: row.kind, reason: 'job_cancelled' },
    });
  }
}

function refuseUnless(
  row: ApprovalRow,
  change: { actor: string; expectedVersion: number; subjectRef?: string; option?: string },
): void {
  const refusal = checkInboxChange(
    {
      state: ApprovalSchema.shape.state.parse(row.state),
      version: row.version,
      subjectRef: row.subjectRef,
      options: ApprovalOptionSchema.array().parse(JSON.parse(row.optionsJson)),
    },
    change,
  );
  if (refusal !== undefined) {
    throw new ApiFailure(REFUSAL_STATUS[refusal.code], refusal.code, refusal.message);
  }
}

/** Updates the item, guarded by its version, and bumps it. */
function bumpItem(
  tx: Tx,
  row: ApprovalRow,
  values: Partial<typeof schema.approvals.$inferInsert>,
): void {
  const updated = tx
    .update(schema.approvals)
    .set({ ...values, version: sql`${schema.approvals.version} + 1` })
    .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.version, row.version)))
    .run();
  if (updated.changes !== 1) throw new Error(`Inbox Item ${row.id} changed under its own update`);
}

function requireItem(db: FactoryDb | Tx, id: string): ApprovalRow {
  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
  if (row === undefined) throw new ApiFailure(404, 'item_not_found', `no Inbox Item ${id}`);
  return row;
}

function requireJob(db: FactoryDb | Tx, id: string): typeof schema.jobs.$inferSelect {
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
  if (job === undefined) throw new ApiFailure(404, 'job_not_found', `no Job ${id}`);
  return job;
}
