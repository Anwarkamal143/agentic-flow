/**
 * The clarification engine for proposal Stages (PRODUCT_SPEC §5, ADR-0071):
 * what the scheduler does with a valid triage or specification output that
 * carries questions, routed by the pure `routeClarification`. Its Technical
 * decisions are kept as a `decision_record` Artifact. An output that stops on
 * its questions is kept as a `clarification` Artifact and never applied or
 * regenerated: the Stage Run is superseded by a discovery re-run, waits on one
 * Inbox Question, or blocks. An answered Question starts a new Stage Run that
 * reads every earlier round. Everything that writes runs inside the caller's
 * versioned Job transaction.
 */
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  CLARIFICATION_OPTIONS,
  clarificationAnswers,
  ClarificationContentSchema,
  clarificationItemTitle,
  decisionRecordsOf,
  EffectiveConfigSchema,
  InboxDecisionSchema,
  InboxQuestionSchema,
  routeClarification,
  type ApprovalKind,
  type ClarificationQuestion,
  type ClarificationRoute,
  type ClarificationRound,
  type DecisionRecordContent,
  type ExpiresPolicy,
} from '@factory/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import type { JobState, StageRunStepper } from './engine.js';
import { newId } from './ids.js';
import { addStageRun } from './replan.js';

type StageRunRow = JobState['stageRuns'][number];
type Artifacts = Pick<ArtifactStore, 'writeContent' | 'record'>;
type ReadJson = (artifactId: string) => unknown;

/** One earlier round of a Stage, with the Artifact that holds it. */
export interface StageRound extends ClarificationRound {
  artifactId: string;
}

/**
 * The Stage's earlier rounds in the Job, oldest first: each `clarification`
 * Artifact of one of its Stage Runs, with the answers once its Question was
 * answered.
 */
export function roundsOf(
  db: Tx | FactoryDb,
  jobId: string,
  stageId: string,
  readJson: ReadJson,
): StageRound[] {
  const rows = db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .innerJoin(schema.stageRuns, eq(schema.stageRuns.id, schema.artifacts.stageRunId))
    .where(
      and(
        eq(schema.artifacts.jobId, jobId),
        eq(schema.artifacts.kind, 'clarification'),
        eq(schema.stageRuns.stageId, stageId),
      ),
    )
    .orderBy(asc(sql`"artifacts"."rowid"`))
    .all();
  return rows.map(({ id }) => {
    const content = ClarificationContentSchema.parse(readJson(id));
    const item = db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.kind, 'question'),
          eq(schema.approvals.subjectRef, id),
          eq(schema.approvals.state, 'decided'),
        ),
      )
      .get();
    const answers =
      item?.decisionJson == null || item.questionsJson === null
        ? []
        : clarificationAnswers(
            z.array(InboxQuestionSchema).parse(JSON.parse(item.questionsJson)),
            InboxDecisionSchema.parse(JSON.parse(item.decisionJson)).answers ?? [],
          );
    return {
      artifactId: id,
      route: content.route,
      output: content.output,
      questions: content.questions,
      answers,
    };
  });
}

/**
 * Whether `run` re-runs its Stage after the previous Stage Run stopped on its
 * questions (a discovery re-run, or answered), so it is no re-specification.
 */
export function isClarificationRerun(
  db: Tx | FactoryDb,
  run: { jobId: string; stageId: string; attempt: number },
): boolean {
  if (run.attempt <= 1) return false;
  const held = db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .innerJoin(schema.stageRuns, eq(schema.stageRuns.id, schema.artifacts.stageRunId))
    .where(
      and(
        eq(schema.stageRuns.jobId, run.jobId),
        eq(schema.stageRuns.stageId, run.stageId),
        eq(schema.stageRuns.attempt, run.attempt - 1),
        eq(schema.artifacts.kind, 'clarification'),
      ),
    )
    .get();
  return held !== undefined;
}

/** Where the valid output of `run` goes, from its questions and the Stage's earlier rounds. */
export function clarificationRouteOf(
  tx: Tx,
  input: {
    job: { id: string; configSnapshotJson: string };
    stageId: string;
    questions: readonly ClarificationQuestion[];
    readJson: ReadJson;
  },
): ClarificationRoute {
  const rounds = roundsOf(tx, input.job.id, input.stageId, input.readJson);
  const config = EffectiveConfigSchema.parse(JSON.parse(input.job.configSnapshotJson));
  return routeClarification({
    questions: input.questions,
    discoveryRerunUsed: rounds.some((r) => r.route === 'discover'),
    batchesUsed: rounds.filter((r) => r.route === 'ask').length,
    maxQuestions: config.maxQuestions.value,
  });
}

/** Keeps the Stage Run's Technical decisions as one `decision_record` Artifact, if it made any. */
export function recordDecisions(
  tx: Tx,
  artifacts: Artifacts,
  input: { run: StageRunRow; questions: readonly ClarificationQuestion[]; actor: string },
): void {
  const decisions = decisionRecordsOf(input.questions);
  if (decisions.length === 0) return;
  const content: DecisionRecordContent = {
    stageId: input.run.stageId,
    stageRunId: input.run.id,
    decisions,
  };
  // Named by its content, not `stage_run_id`: a Stage Run holds one proposal Artifact.
  artifacts.record(
    tx,
    {
      jobId: input.run.jobId,
      kind: 'decision_record',
      content: artifacts.writeContent(content),
    },
    input.actor,
  );
}

/**
 * Stops the running `run` on its questions: keeps `output` as a
 * `clarification` Artifact, then supersedes the Stage Run with a queued
 * discovery re-run, waits on one Inbox Question, or blocks it with no
 * Question.
 */
export function stopOnQuestions(
  tx: Tx,
  artifacts: Artifacts,
  input: {
    run: StageRunRow;
    route: Exclude<ClarificationRoute, { kind: 'proceed' }>;
    output: unknown;
    questions: readonly ClarificationQuestion[];
    actor: string;
  },
  step: StageRunStepper,
): void {
  const { run, route, actor } = input;
  const artifact = artifacts.record(
    tx,
    {
      jobId: run.jobId,
      stageRunId: run.id,
      kind: 'clarification',
      content: artifacts.writeContent(
        ClarificationContentSchema.parse({
          stageId: run.stageId,
          stageRunId: run.id,
          route: route.kind,
          output: input.output,
          questions: input.questions,
        }),
      ),
    },
    actor,
  );
  if (route.kind === 'discover') {
    step(run, 'superseded', {
      reason: 'discovery_rerun',
      detail: { clarificationArtifactId: artifact.id, discover: route.questions },
    });
    const next = addStageRun(tx, run.jobId, run, actor, 'discovery_rerun');
    step(next, 'queued', { reason: 'discovery_rerun' });
    return;
  }
  if (route.kind === 'blocked') {
    step(run, 'blocked', {
      blocker: {
        ...route.blocker,
        // A proposal Stage's Blocker has no Task or Attempt (ADR-0071).
        taskId: run.id,
        attemptId: artifact.id,
        createdAt: new Date().toISOString(),
      },
    });
    return;
  }
  step(run, 'waiting_human', {
    reason: 'awaiting_answers',
    detail: { clarificationArtifactId: artifact.id },
  });
  const id = newId('apr');
  const kind: ApprovalKind = 'question';
  const expiresPolicy: ExpiresPolicy = 'remain_pending';
  tx.insert(schema.approvals)
    .values({
      id,
      jobId: run.jobId,
      taskId: null,
      stageRunId: run.id,
      kind,
      subjectRef: artifact.id,
      question: clarificationItemTitle(run.stageId, route.questions),
      questionsJson: JSON.stringify(route.questions),
      why:
        `The ${run.stageId} agent needs a human's answer before it can go on. The questions are grouped by category; a Security question needs a human with approver rights. ` +
        'Your answers start a new Stage Run; the output that asked stays an Artifact and is never regenerated. ' +
        'The questions and their options are proposed by an agent, and an answer never grants a permission.',
      optionsJson: JSON.stringify(CLARIFICATION_OPTIONS),
      recommended: null,
      evidenceJson: JSON.stringify([artifact.id]),
      state: 'open',
      deferred: false,
      requestedBy: actor,
      expiresPolicy,
      createdAt: new Date().toISOString(),
      version: 0,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'approval',
    entityId: id,
    jobId: run.jobId,
    type: 'approval.opened',
    actor,
    payload: {
      kind,
      subjectRef: artifact.id,
      taskId: null,
      stageRunId: run.id,
      questions: route.questions.length,
      categories: [...new Set(route.questions.map((q) => q.category))],
    },
  });
}

/**
 * An answered proposal Stage Question: the waiting Stage Run is superseded
 * and a new one queued, which reads the answers as input.
 */
export function continueAfterAnswers(
  state: JobState,
  step: StageRunStepper,
  input: { itemId: string; stageRunId: string; actor: string },
  tx: Tx,
): void {
  const run = state.stageRuns.find((r) => r.id === input.stageRunId);
  if (run?.state !== 'waiting_human') {
    throw new Error(`question item ${input.itemId} holds no Stage Run waiting for its answer`);
  }
  step(run, 'superseded', { reason: 'answered', detail: { approvalId: input.itemId } });
  const next = addStageRun(tx, run.jobId, run, input.actor, 'answered');
  step(next, 'queued', { reason: 'answered' });
}

/** What the `harness_run.started` event says of the rounds a Stage Run reads. */
export function roundsSummary(rounds: readonly StageRound[]):
  | {
      rounds: Record<string, unknown>[];
    }
  | undefined {
  if (rounds.length === 0) return undefined;
  return {
    rounds: rounds.map((r) => ({
      artifactId: r.artifactId,
      route: r.route,
      ...(r.route === 'discover'
        ? { discover: r.questions.filter((q) => q.category === 'discoverable').map((q) => q.text) }
        : {}),
      ...(r.route === 'ask' ? { answers: r.answers } : {}),
    })),
  };
}
