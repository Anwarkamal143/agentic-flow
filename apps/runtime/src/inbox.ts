/**
 * The Inbox (PRODUCT_SPEC §10, ADR-0016): Inbox Items, their versioned
 * decisions, defer and undefer, `answerQuestion` (ADR-0023), and the plan operations `approvePlan`,
 * `rejectPlan`, `requestPlanChanges` and `editPlan` (ADR-0019) with the plan
 * approval view. Every decision names the item's version and subject, and only
 * a human actor decides.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import { rmSync } from 'node:fs';
import {
  ApprovalOptionSchema,
  ApprovalSchema,
  AttemptCauseSchema,
  AuditEntrySchema,
  attemptsCountedForRework,
  BlockerSchema,
  checkBlockerDecision,
  grantedCap,
  KILL_AND_RETRY_OPTIONS,
  retriesAfterRetryNow,
  retryNowCheck,
  checkAnswers,
  checkInboxChange,
  InboxQuestionSchema,
  checkPlanChangeRequest,
  EffectiveConfigSchema,
  humanDecisionPoints,
  InboxDecisionSchema,
  JobStatusSchema,
  TERMINAL_JOB_STATUSES,
  parallelWaves,
  planEstimate,
  PlanProposalSchema,
  RiskSchema,
  schemaIssues,
  TaskDefinitionSchema,
  TriageProposalSchema,
  validatePlan,
  WorkflowSnapshotSchema,
  type AnswerQuestionInput,
  type AnswerRefusal,
  type Approval,
  type AuditEntry,
  type Blocker,
  type CancelJobInput,
  type RetryNowProcess,
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
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { inspectSpool } from '@factory/harness';
import { raiseCap, replaceBlocker } from './blocker-approvals.js';
import {
  changeJob,
  stepTask,
  stepWorktree,
  type JobState,
  type StageRunStepper,
} from './engine.js';
import { ApiFailure } from './errors.js';
import { parseProcess } from './execution.js';
import { openQuestionItem } from './questions.js';
import { stopIfAlive, worktreeStatus } from './recovery.js';
import { requireWorktree } from './worktree.js';
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

const ANSWER_STATUS: Readonly<Record<AnswerRefusal['code'], 400>> = {
  answer_missing: 400,
  unknown_question: 400,
  invalid_answer: 400,
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
    /** The Job cancel operation (`JobService.cancel`), for a Blocker Approval's "cancel the Job". */
    private readonly cancelJob: (jobId: string, input: CancelJobInput) => Promise<unknown> = () =>
      Promise.reject(new Error('no cancel operation configured')),
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

  /** The Job's audit log, oldest first (cap raises by Blocker Approvals, ADR-0026). */
  audit(jobId: string): AuditEntry[] {
    requireJob(this.db, jobId);
    return this.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.jobId, jobId))
      .orderBy(asc(schema.auditLog.ts), asc(sql`"audit_log"."rowid"`))
      .all()
      .map((r) =>
        AuditEntrySchema.parse({
          id: r.id,
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          target: r.target,
          before: JSON.parse(r.beforeJson) as unknown,
          after: JSON.parse(r.afterJson) as unknown,
          policyRef: r.policyRef,
          correlationId: r.correlationId,
        }),
      );
  }

  /** Decides an item, refused unless it names the open item's version and subject. */
  async decide(id: string, input: DecideInput, actor: string): Promise<Approval> {
    const item = requireItem(this.db, id);
    if (item.kind === 'blocker') return this.decideBlocker(item, input, actor);
    if (input.grant !== undefined) {
      throw new ApiFailure(400, 'invalid_grant', `a ${item.kind} item takes no grant size`);
    }
    changeJob(this.db, { jobId: item.jobId, expectedVersion: 'current', actor }, (tx, _s, step) => {
      const row = requireItem(tx, id);
      if (row.kind === 'question') {
        throw new ApiFailure(
          409,
          'answer_required',
          'a question item is answered, not decided: POST /v1/inbox/:id/answer (factory inbox answer)',
        );
      }
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

  /**
   * `answerQuestion` (ARCHITECTURE §8 step 3): answers each question of an
   * open `question` item (an offered option or free text) in one transaction.
   * The item is decided, its Task goes `blocked → ready` and `execution`
   * queued again, so a fresh Attempt (`cause: answer`) starts on the same Task
   * Branch with the answers in its packet. The answers are guidance only:
   * nothing here changes a scope, a cap or a policy.
   */
  answer(id: string, input: AnswerQuestionInput, actor: string): Approval {
    const item = requireItem(this.db, id);
    changeJob(
      this.db,
      { jobId: item.jobId, expectedVersion: 'current', actor },
      (tx, state, step) => {
        const row = requireItem(tx, id);
        if (row.kind !== 'question') {
          throw new ApiFailure(
            409,
            'not_a_question',
            `the item is a ${row.kind} item; decide it instead (POST /v1/inbox/:id/decide)`,
          );
        }
        refuseUnless(row, {
          actor,
          expectedVersion: input.expectedVersion,
          subjectRef: input.subjectRef,
          option: 'answer',
        });
        const questions = z.array(InboxQuestionSchema).parse(JSON.parse(row.questionsJson ?? '[]'));
        const refusal = checkAnswers(questions, input.answers);
        if (refusal !== undefined) {
          throw new ApiFailure(ANSWER_STATUS[refusal.code], refusal.code, refusal.message);
        }
        const decision = InboxDecisionSchema.parse({
          option: 'answer',
          comment: null,
          answers: input.answers,
        });
        bumpItem(tx, row, {
          state: 'decided',
          decidedBy: actor,
          decidedAt: new Date().toISOString(),
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
        const task =
          row.taskId === null
            ? undefined
            : tx.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get();
        const blocker =
          task?.blockerJson == null ? undefined : BlockerSchema.parse(JSON.parse(task.blockerJson));
        if (
          task?.state !== 'blocked' ||
          blocker?.reason !== 'awaiting_human' ||
          blocker.attemptId !== row.subjectRef
        ) {
          throw new Error(`question item ${id} holds no Task waiting for its answer`);
        }
        stepTask(tx, { jobId: row.jobId, actor }, task, 'ready', {
          reason: 'answered',
          payload: { approvalId: id, answeredAttemptId: row.subjectRef },
        });
        const execution = state.stageRuns.filter((r) => r.stageId === 'execution').at(-1);
        if (execution?.state === 'waiting_human' || execution?.state === 'blocked') {
          step(execution, 'queued', { reason: `Question ${id} answered by ${actor}` });
        }
      },
    );
    this.onCommit();
    return this.get(id);
  }

  /**
   * Decides a Blocker Approval (ARCHITECTURE §8.1, ADR-0026). `grant` raises
   * the Task's cap by +N (audited) and the Task goes on: Rework is readied, a
   * capped Question is opened for its answer. `retry_now` / `kill_and_retry`
   * re-check the recorded process (pid plus start time) before a Retry, and
   * never start one beside a live process. `cancel_job` decides the item, then
   * runs the Job cancel operation.
   */
  private async decideBlocker(
    item: ApprovalRow,
    input: DecideInput,
    actor: string,
  ): Promise<Approval> {
    refuseUnless(item, { actor, ...input });
    const check = checkBlockerDecision({ option: input.option, grant: input.grant });
    if (!check.ok) throw new ApiFailure(400, check.code, check.message);
    const { blocker } = blockedTaskOf(this.db, item);

    if (input.option === 'cancel_job') {
      this.decideOnly(item, input, actor, null, (tx) => {
        const job = requireJob(tx, item.jobId);
        if (TERMINAL_JOB_STATUSES.includes(JobStatusSchema.parse(job.status))) {
          throw new ApiFailure(409, 'job_terminal', `Job ${job.id} is already ${job.status}`);
        }
      });
      await this.cancelFromItem(item);
      return this.get(item.id);
    }

    if (input.option === 'grant') {
      const grant = check.grant ?? 1;
      this.decideOnly(item, input, actor, grant, (tx, state, step) => {
        applyGrant(tx, { item, grant, actor }, state, step);
      });
      return this.get(item.id);
    }

    // retry_now or kill_and_retry: the process is checked (and, if asked, stopped) first.
    const attempt = this.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.id, blocker.attemptId))
      .get();
    if (attempt === undefined) throw new Error(`Blocker Approval ${item.id} names no Attempt`);
    const recorded = attempt.processJson === null ? undefined : parseProcess(attempt.processJson);
    let process: RetryNowProcess =
      recorded === undefined ? 'unrecorded' : inspectSpool(recorded.spool).state;
    if (recorded !== undefined && process === 'alive' && input.option === 'kill_and_retry') {
      // Proven ours (pid plus start time), so its group is stopped; the stop settles only
      // once the group is gone. Its spool may be cleaned up meanwhile, so what was seen
      // alive and then stopped counts as dead unless it still shows alive.
      await stopIfAlive(recorded.spool, recorded.startedAt);
      process = inspectSpool(recorded.spool).state === 'alive' ? 'alive' : 'dead';
    }
    const verdict = retryNowCheck(process);
    if (verdict === 'kill_first') {
      if (input.option === 'kill_and_retry') {
        throw new ApiFailure(
          409,
          'process_alive',
          `the recorded process of Attempt ${attempt.id} is still alive after it was stopped; nothing was retried`,
        );
      }
      const version = this.offerKillAndRetry(item, actor);
      throw new ApiFailure(
        409,
        'process_alive',
        `the recorded process of Attempt ${attempt.id} is still alive (pid and start time match), so no Retry starts beside it. The item now offers kill_and_retry (version ${String(version)})`,
      );
    }
    if (verdict === 'unconfirmed') {
      throw new ApiFailure(
        409,
        'process_unconfirmed',
        `the recorded process of Attempt ${attempt.id} can't be checked (its spool has no readable pid), so it may still be running. No Retry starts until it is proven gone (it writes its exit status when it ends); cancelling the Job remains`,
      );
    }
    const worktree = requireWorktree(this.db, attempt.worktreeId);
    if (worktree.state === 'quarantined' && (await worktreeStatus(worktree.path)) === 'unknown') {
      throw new ApiFailure(
        409,
        'worktree_unknown',
        `the quarantined Worktree ${worktree.path} is still missing or unreadable by git, so a Retry can't run there; restore it, or cancel the Job`,
      );
    }
    this.decideOnly(item, input, actor, null, (tx, state, step) => {
      applyRetry(tx, { item, process, actor }, state, step);
    });
    // The process is gone: its spool (raw output) goes too.
    if (recorded !== undefined) rmSync(recorded.spool, { recursive: true, force: true });
    return this.get(item.id);
  }

  /**
   * Decides `item` in one versioned Job transaction: the version, subject and
   * option are checked again inside it, then `body` applies the decision.
   */
  private decideOnly(
    item: ApprovalRow,
    input: DecideInput,
    actor: string,
    grant: number | null,
    body: (tx: Tx, state: JobState, step: StageRunStepper) => void,
  ): void {
    changeJob(
      this.db,
      { jobId: item.jobId, expectedVersion: 'current', actor },
      (tx, state, step) => {
        const row = requireItem(tx, item.id);
        refuseUnless(row, { actor, ...input });
        const decision = InboxDecisionSchema.parse({
          option: input.option,
          comment: input.comment ?? null,
          ...(grant === null ? {} : { grant }),
        });
        bumpItem(tx, row, {
          state: 'decided',
          decidedBy: actor,
          decidedAt: new Date().toISOString(),
          decisionJson: JSON.stringify(decision),
        });
        appendEvent(tx, {
          entityKind: 'approval',
          entityId: row.id,
          jobId: row.jobId,
          type: 'approval.decided',
          actor,
          payload: { kind: row.kind, subjectRef: row.subjectRef, ...decision },
        });
        body(tx, state, step);
      },
    );
    this.onCommit();
  }

  /** Swaps "retry now" for "kill and retry" on the item; returns its new version. */
  private offerKillAndRetry(item: ApprovalRow, actor: string): number {
    this.db.transaction(
      (tx) => {
        const row = requireItem(tx, item.id);
        bumpItem(tx, row, { optionsJson: JSON.stringify(KILL_AND_RETRY_OPTIONS) });
        appendEvent(tx, {
          entityKind: 'approval',
          entityId: row.id,
          jobId: row.jobId,
          type: 'approval.options_changed',
          actor,
          payload: {
            kind: row.kind,
            reason: 'process_alive',
            options: KILL_AND_RETRY_OPTIONS.map((o) => o.id),
          },
        });
      },
      { behavior: 'immediate' },
    );
    this.onCommit();
    return requireItem(this.db, item.id).version;
  }

  /** Runs the Job cancel operation at the Job's current version (re-read on a race). */
  private async cancelFromItem(item: ApprovalRow): Promise<void> {
    for (let tries = 0; ; tries++) {
      const job = requireJob(this.db, item.jobId);
      try {
        await this.cancelJob(item.jobId, {
          expectedVersion: job.version,
          reason: `cancelled from Inbox item ${item.id}`,
        });
        return;
      } catch (err) {
        const conflict = err instanceof ApiFailure && err.code === 'version_conflict';
        if (!conflict || tries >= 4) throw err;
      }
    }
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
  ): Promise<Approval> {
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
  requestPlanChanges(
    jobId: string,
    input: RequestPlanChangesInput,
    actor: string,
  ): Promise<Approval> {
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
      questions: row.questionsJson === null ? null : (JSON.parse(row.questionsJson) as unknown),
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

/** The `blocked` Task a Blocker Approval holds, and the Blocker it was opened for. */
function blockedTaskOf(
  db: FactoryDb | Tx,
  item: ApprovalRow,
): { task: typeof schema.tasks.$inferSelect; blocker: Blocker } {
  const task =
    item.taskId === null
      ? undefined
      : db.select().from(schema.tasks).where(eq(schema.tasks.id, item.taskId)).get();
  const blocker =
    task?.blockerJson == null ? undefined : BlockerSchema.parse(JSON.parse(task.blockerJson));
  if (task?.state !== 'blocked' || blocker?.attemptId !== item.subjectRef) {
    throw new Error(`Blocker Approval ${item.id} holds no Task blocked by it`);
  }
  return { task, blocker };
}

function requireAttemptRow(tx: Tx, id: string): typeof schema.attempts.$inferSelect {
  const row = tx.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
  if (row === undefined) throw new Error(`no Attempt ${id}`);
  return row;
}

/** Re-queues `execution` once a Blocker is cleared, so the next claim picks the Task up. */
function requeueExecution(state: JobState, step: StageRunStepper, reason: string): void {
  const execution = state.stageRuns.filter((r) => r.stageId === 'execution').at(-1);
  if (execution?.state === 'waiting_human' || execution?.state === 'blocked') {
    step(execution, 'queued', { reason });
  }
}

/**
 * A grant of +N: the cap is raised to N more than were used (audited). A
 * Rework cap readies the Task for its next Rework Attempt; a question cap
 * opens the capped Attempt's Question, whose answer starts the next Attempt.
 * The comment is guidance for every later Attempt (`guidanceAfter`).
 */
function applyGrant(
  tx: Tx,
  input: { item: ApprovalRow; grant: number; actor: string },
  state: JobState,
  step: StageRunStepper,
): void {
  const { item, grant, actor } = input;
  const { task, blocker } = blockedTaskOf(tx, item);
  const op = { jobId: item.jobId, actor };
  const causes = tx
    .select({ cause: schema.attempts.cause })
    .from(schema.attempts)
    .where(eq(schema.attempts.taskId, task.id))
    .all()
    .map((a) => ({ cause: AttemptCauseSchema.parse(a.cause) }));
  const audit = { jobId: item.jobId, taskId: task.id, actor, approvalId: item.id, option: 'grant' };
  if (blocker.reason === 'rework_cap_reached') {
    const to = grantedCap({ used: attemptsCountedForRework(causes), cap: task.maxAttempts }, grant);
    raiseCap(tx, { ...audit, cap: 'maxAttempts', from: task.maxAttempts, to });
    stepTask(tx, op, task, 'ready', {
      reason: 'granted',
      payload: { approvalId: item.id, grant, maxAttempts: to, attemptId: blocker.attemptId },
    });
    requeueExecution(
      state,
      step,
      `Blocker Approval ${item.id}: ${actor} granted +${String(grant)}`,
    );
    return;
  }
  if (blocker.reason !== 'question_cap_reached') {
    throw new Error(`a ${blocker.reason} Blocker takes no grant`);
  }
  const used = causes.filter((c) => c.cause === 'answer').length;
  const to = grantedCap({ used, cap: task.maxQuestions }, grant);
  raiseCap(tx, { ...audit, cap: 'maxQuestions', from: task.maxQuestions, to });
  const asking = requireAttemptRow(tx, blocker.attemptId);
  const questionId = openQuestionItem(tx, {
    jobId: item.jobId,
    taskId: task.id,
    taskKey: task.key,
    attemptId: asking.id,
    questions: z.array(InboxQuestionSchema).parse(JSON.parse(asking.questionsJson)),
    evidence: [],
    requestedBy: `agent:${asking.harnessId}/${asking.id}`,
    actor,
  });
  replaceBlocker(tx, op, blockedTaskOf(tx, item).task, {
    kind: 'human',
    reason: 'awaiting_human',
    detail: `the developer's questions were reopened by a grant of +${String(grant)} (maxQuestions ${String(to)})`,
    requiredAction: `answer Inbox Item ${questionId} (factory inbox answer ${questionId})`,
    taskId: task.id,
    attemptId: asking.id,
    createdAt: new Date().toISOString(),
  });
}

/**
 * "Retry now" once the process is gone: the Task goes `ready` for a Retry in
 * its Worktree (a quarantined one, readable again, is preserved first), with
 * `maxRetries` raised by one (audited) when no Retry was left.
 */
function applyRetry(
  tx: Tx,
  input: { item: ApprovalRow; process: RetryNowProcess; actor: string },
  state: JobState,
  step: StageRunStepper,
): void {
  const { item, process, actor } = input;
  const { task, blocker } = blockedTaskOf(tx, item);
  const op = { jobId: item.jobId, actor };
  const attempt = requireAttemptRow(tx, blocker.attemptId);
  const worktree = requireWorktree(tx, attempt.worktreeId);
  if (worktree.state === 'quarantined') {
    stepWorktree(tx, op, worktree, 'quarantined', 'preserved', { approvalId: item.id });
  }
  // The process is proven gone: its record goes, so nothing checks it again.
  tx.update(schema.attempts)
    .set({ processJson: null })
    .where(eq(schema.attempts.id, attempt.id))
    .run();
  const retriesUsed = tx
    .select({ id: schema.attempts.id })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.taskId, task.id), eq(schema.attempts.cause, 'retry')))
    .all().length;
  const raised = retriesAfterRetryNow({ retriesUsed, maxRetries: task.maxRetries });
  if (raised !== undefined) {
    raiseCap(tx, {
      jobId: item.jobId,
      taskId: task.id,
      cap: 'maxRetries',
      from: task.maxRetries,
      to: raised,
      actor,
      approvalId: item.id,
      option: item.optionsJson.includes('kill_and_retry') ? 'kill_and_retry' : 'retry_now',
    });
  }
  stepTask(tx, op, task, 'ready', {
    reason: 'retry_now',
    payload: { approvalId: item.id, attemptId: attempt.id, process },
  });
  requeueExecution(
    state,
    step,
    `Blocker Approval ${item.id}: ${actor} chose a Retry (process ${process})`,
  );
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
