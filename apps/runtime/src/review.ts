/**
 * The independent review (ARCHITECTURE §9): the Review Packet the factory
 * builds, the versioned prompt template that renders it, and the check of
 * what the reviewer Harness Run proposes. The reviewer sees the Specification,
 * the Acceptance Criteria the Task covers, the diff `base..head` and the
 * factory's own Evidence; never the implementer's transcript or Task Result.
 *
 * Also the review flow the Task scheduler runs for an Attempt in `in_review`:
 * the reviewer Harness Runs (through the scheduler's {@link ReviewRunner}),
 * then one transaction recording the review and deciding approval.
 */
import { createHash } from 'node:crypto';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import {
  criterionVerdict,
  decideApproval,
  EvidenceVerdictSchema,
  isBlocking,
  isCurrent,
  ReviewPacketSchema,
  ReviewOutcomeSchema,
  ReviewProposalSchema,
  schemaIssues,
  SpecificationProposalSchema,
  TaskDefinitionSchema,
  validateReview,
  VerificationLogContentSchema,
  type ApprovalInput,
  type AttemptExitReason,
  type AttemptFinding,
  type AttemptState,
  type EvidenceVerdict,
  type GateRef,
  type ReviewPacket,
  type ReviewProposal,
  type RuleIssue,
  type SpecificationProposal,
  type TaskDefinition,
} from '@factory/domain';
import { changedPaths, diffBetween } from '@factory/git';
import { describeHarnessExit, type HarnessRawResult } from '@factory/harness';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { criteriaCoveredBy, currentCriteria, currentSpec } from './criteria.js';
import { changeJob, type JobState, type StageRunStepper } from './engine.js';
import { gateFinding } from './findings.js';
import { newId } from './ids.js';
import { otherRepositoryChanges } from './upstream-context.js';

export const REVIEW_TEMPLATE_ID = 'review-packet@1';

/** The diff a reviewer gets, at most. */
const MAX_DIFF_BYTES = 256 * 1024;
/** The end of each verification command's output a reviewer gets. */
const OUTPUT_TAIL_BYTES = 4 * 1024;

const TEMPLATE = `You are the independent reviewer of one Task in an automated software factory.
You did not write this change, and you have no access to how it was written.
The current directory is the Task's git Worktree at the reviewed commit. Read it if you need to; change nothing (no edits, no commits). A change you make invalidates your review.

Review the change on two axes: (A) engineering standards, and (B) compliance with the Specification and its Acceptance Criteria.
Give every Acceptance Criterion in the packet a verdict: pass, fail, blocked or not_tested. Say not_tested when nothing in the diff or the Evidence shows it.
Each finding has a severity (critical, high, medium, low, info), a fault origin (implementation, plan, spec, infrastructure), a location (path, path:line, or general), the problem, why it matters, a recommendation, and whether it blocks. Critical and high findings always block.
The outcome is approved when no finding blocks, and changes_requested when one does.

The Review Packet (JSON):
{{packet}}
{{rejected}}
Reply with exactly one JSON object and nothing else. It must match this JSON Schema:
{{schema}}
`;

/** Hash of the template text, recorded with each review. */
export const REVIEW_TEMPLATE_HASH = `sha256:${createHash('sha256').update(TEMPLATE).digest('hex')}`;

export const INTEGRATION_REVIEW_TEMPLATE_ID = 'integration-review-packet@2';

/**
 * The Integration Review (ARCHITECTURE §9, ADR-0035): the whole combined change
 * of a Job, after its approved Task Branches were merged, against the whole
 * Specification. Same output schema as a Task review.
 */
const INTEGRATION_TEMPLATE = `You are the independent Integration Reviewer of one Job in an automated software factory.
Each Task of the Job was reviewed on its own and approved. Their Task Branches are now merged into one Integration Branch, and you review the combined change: the diff from the base to the integration head.
You did not write any of it, and you have no access to how it was written.
The current directory is the Integration Branch's git Worktree at the reviewed commit. Read it if you need to; change nothing (no edits, no commits). A change you make invalidates your review.

Look for what no single Task's review could see: changes that are each correct but inconsistent together, duplicated helpers or behavior, conflicting conventions, and Acceptance Criteria that no single Task fully satisfies.
When the Job spans several Repositories, the packet's otherRepositories holds the other Repositories' approved changes as read-only context. You review only this Repository's Integration Branch, but judge whether it is consistent with them (an interface one side provides and the other uses). Their pull requests are separate and not atomic. They are not in your Worktree; never ask for changes there.
Review the combined change on two axes: (A) engineering standards, and (B) compliance with the whole Specification and every Acceptance Criterion.
Give every Acceptance Criterion in the packet a verdict: pass, fail, blocked or not_tested. Say not_tested when nothing in the diff or the Evidence shows it.
Each finding has a severity (critical, high, medium, low, info), a fault origin (implementation, plan, spec, infrastructure), a location (path, path:line, or general), the problem, why it matters, a recommendation, and whether it blocks. Critical and high findings always block.
Use fault origin implementation for what a fix on the Integration Branch can solve, plan when the Tasks themselves were split or defined wrongly, and spec when the Specification is wrong.
The outcome is approved when no finding blocks, and changes_requested when one does.

The Review Packet (JSON):
{{packet}}
{{rejected}}
Reply with exactly one JSON object and nothing else. It must match this JSON Schema:
{{schema}}
`;

export const INTEGRATION_REVIEW_TEMPLATE_HASH = `sha256:${createHash('sha256').update(INTEGRATION_TEMPLATE).digest('hex')}`;

/** The template a packet is rendered with, by its scope. */
function templateOf(scope: ReviewPacket['scope']): { id: string; hash: string; text: string } {
  return scope === 'integration'
    ? {
        id: INTEGRATION_REVIEW_TEMPLATE_ID,
        hash: INTEGRATION_REVIEW_TEMPLATE_HASH,
        text: INTEGRATION_TEMPLATE,
      }
    : { id: REVIEW_TEMPLATE_ID, hash: REVIEW_TEMPLATE_HASH, text: TEMPLATE };
}

export function renderReviewPrompt(packet: ReviewPacket, rejected?: readonly RuleIssue[]): string {
  const values: Record<string, string> = {
    packet: JSON.stringify(packet, null, 2),
    rejected:
      rejected === undefined
        ? ''
        : `\nYour previous output was rejected. Fix every problem below:\n${rejected
            .map((i) => `- [${i.rule}] ${i.message}`)
            .join('\n')}\n`,
    schema: JSON.stringify(z.toJSONSchema(ReviewProposalSchema, { io: 'input' })),
  };
  return templateOf(packet.scope).text.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => values[key] ?? '',
  );
}

/** A verification run as the factory recorded it, with its output. */
export interface ReviewedRun {
  key: string;
  command: string;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** Builds the Review Packet from the factory's own records and git. Nothing from the Harness. */
export async function buildReviewPacket(input: {
  scope: ReviewPacket['scope'];
  subject: ReviewPacket['subject'];
  /** The Factory Clone or the Worktree, to read the diff from. */
  repo: string;
  specification: SpecificationProposal;
  criteria: readonly { code: string; text: string; mandatory: boolean; verification: string }[];
  runs: readonly ReviewedRun[];
  /** Command-sourced criterion Evidence, by code. */
  commandVerdicts: readonly { code: string; verdict: EvidenceVerdict; detail: string }[];
  /** `integration` only: the Job's other Repositories' changes (#106). */
  otherRepositories?: ReviewPacket['otherRepositories'];
}): Promise<ReviewPacket> {
  const { headSha, baseSha } = input.subject;
  const diff = await diffBetween(input.repo, baseSha, headSha, MAX_DIFF_BYTES);
  return ReviewPacketSchema.parse({
    packetVersion: 1,
    scope: input.scope,
    subject: input.subject,
    specification: input.specification,
    acceptanceCriteria: input.criteria.map((c) => ({
      code: c.code,
      text: c.text,
      mandatory: c.mandatory,
      verification: c.verification,
    })),
    diff: {
      files: await changedPaths(input.repo, baseSha, headSha),
      patch: diff.patch,
      truncated: diff.truncated,
    },
    ...(input.otherRepositories === undefined
      ? {}
      : { otherRepositories: input.otherRepositories }),
    evidence: [
      ...input.runs.map((r) => ({
        kind: 'verification' as const,
        key: r.key,
        command: r.command,
        required: r.required,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        verdict: r.exitCode === 0 ? ('pass' as const) : ('fail' as const),
        outputTail: tail(r.output, OUTPUT_TAIL_BYTES),
        headSha,
        baseSha,
      })),
      ...input.commandVerdicts.map((c) => ({
        kind: 'criterion' as const,
        code: c.code,
        verdict: c.verdict,
        detail: c.detail,
        headSha,
        baseSha,
      })),
    ],
  } satisfies ReviewPacket);
}

/** What one reviewer Harness Run's output is worth. Exit code 0 proves nothing. */
export type ReviewEvaluation =
  | { kind: 'valid'; value: ReviewProposal }
  | { kind: 'invalid'; issues: RuleIssue[] }
  | { kind: 'harness_failed'; message: string };

export function evaluateReview(
  result: HarnessRawResult | undefined,
  packet: ReviewPacket,
): ReviewEvaluation {
  if (result === undefined) {
    return { kind: 'harness_failed', message: 'the reviewer Harness Run did not start' };
  }
  const { exit } = result;
  if (exit.kind !== 'exited' || exit.code !== 0) {
    return {
      kind: 'harness_failed',
      message: `the reviewer Harness Run ${describeHarnessExit(exit)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.output);
  } catch (err) {
    return {
      kind: 'invalid',
      issues: [
        {
          rule: 'json',
          message: `the review is not a JSON object (${err instanceof Error ? err.message : String(err)})`,
        },
      ],
    };
  }
  const parsed = ReviewProposalSchema.safeParse(json);
  if (!parsed.success) return { kind: 'invalid', issues: schemaIssues(parsed.error) };
  const issues = validateReview(parsed.data, {
    criteria: packet.acceptanceCriteria.map((c) => c.code),
  });
  return issues.length === 0 ? { kind: 'valid', value: parsed.data } : { kind: 'invalid', issues };
}

function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString('utf8');
}

// ---- the review flow ---------------------------------------------------------------

/** The Task scheduler, which runs the review. */
const ACTOR = 'system:scheduler';
/** Reviewer Harness Runs per review: the first, plus one re-prompt. */
const REVIEW_RUNS = 2;

/** A verification run as recorded for an Attempt, with its output and the criteria it verifies. */
export interface RecordedRun extends ReviewedRun {
  criteria: string[];
  startedAt: string;
  durationMs: number;
}

/** How an Attempt ends, and what the factory's Gates found (a review's Findings are recorded with it). */
export interface AttemptOutcome {
  state: Extract<AttemptState, 'passed' | 'failed'>;
  exitReason: AttemptExitReason;
  detail: string;
  findings?: AttemptFinding[];
}

/** The reviewer's proposal and what it was given, or why there is none. */
export type Reviewed =
  | {
      kind: 'valid';
      packet: ReviewPacket;
      value: ReviewProposal;
      sessionRef: string | null;
      harnessId: string;
    }
  | { kind: 'failed'; exitReason: 'review_failed' | 'invalid_output'; detail: string }
  /**
   * A base merge-in left the reviewed diff unchanged (ADR-0041): `original`, the
   * approving Review of the head before, is re-anchored to the new SHAs; no reviewer ran.
   */
  | {
      kind: 'reanchored';
      original: typeof schema.reviews.$inferSelect;
      reason: string;
      /** `git patch-id --stable` of the diff, the same before and after the merge-in (`null`: empty). */
      patchId: string | null;
    };

/** One reviewer Harness Run, as the review asks the Task scheduler to run it. */
export interface ReviewerRunInput {
  role: 'reviewer';
  template: { id: string; hash: string };
  /** 1, or 2 for the re-prompt. */
  run: number;
  prompt: string;
  wallClockMs: number;
  reprompt?: readonly RuleIssue[];
}

/** How the review runs its reviewer Harness Runs: the Task scheduler's Harness Run loop. */
export interface ReviewRunner {
  /** Runs (or finishes a re-attached) reviewer Harness Run; `evaluate` judges its output for the record. */
  run(
    input: ReviewerRunInput,
    evaluate: (result: HarnessRawResult) => { outcome: string; issues?: RuleIssue[] },
  ): Promise<{ result: HarnessRawResult | undefined; sessionRef: string | undefined }>;
  /** `true` when the work must stop here (shutdown or cancellation). */
  stopped(): Promise<boolean>;
}

/** What the review flow reads and writes through. */
export interface ReviewDeps {
  db: FactoryDb;
  artifacts: ArtifactStore;
  harnessVersion: string | null;
  onCommit: () => void;
}

/** The Attempt's recorded verification runs, with their output, as the review is sent them. */
export function recordedRuns(
  deps: Pick<ReviewDeps, 'db' | 'artifacts'>,
  attemptId: string,
  definition: TaskDefinition,
): RecordedRun[] {
  return deps.db
    .select()
    .from(schema.verificationRuns)
    .where(eq(schema.verificationRuns.attemptId, attemptId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((r) => {
      const log = VerificationLogContentSchema.parse(deps.artifacts.readJson(r.outputArtifactId));
      return {
        key: r.commandKey,
        command: r.command,
        required: r.required,
        criteria: definition.verification.find((v) => v.key === r.commandKey)?.criteria ?? [],
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        output: log.output,
      };
    });
}

/**
 * The independent review: a reviewer Harness Run in a new Session, in the
 * Worktree at the reviewed head, given the Review Packet only. Its output
 * is checked like any proposal; one re-prompt (again a new Session) carries
 * the problems. `undefined` when the work stopped. `firstRun`: the Run to
 * start the loop at (a re-attached reviewer Run's number).
 */
export async function runReview(
  deps: Pick<ReviewDeps, 'db' | 'artifacts'>,
  input: {
    subject: { jobId: string; taskId: string; taskKey: string; attemptId: string };
    /** The Worktree, at the reviewed head. */
    worktree: string;
    definition: TaskDefinition;
    at: GateRef;
    runs: readonly RecordedRun[];
    harnessId: string;
    wallClockMs: number;
    firstRun: number;
    /** `integration`: the Integration Review (ADR-0035). */
    scope: ReviewPacket['scope'];
  },
  runner: ReviewRunner,
): Promise<Reviewed | undefined> {
  const { db, artifacts } = deps;
  const { jobId } = input.subject;
  const { runs } = input;
  const spec = currentSpec(db, jobId);
  if (spec === undefined) throw new Error(`Job ${jobId} has no Specification to review against`);
  const criteria = reviewedCriteria(db, jobId, input.scope, input.definition);
  const template = templateOf(input.scope);
  const reviewed = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, input.subject.taskId))
    .get();
  if (reviewed === undefined) throw new Error(`no Task ${input.subject.taskId}`);
  const packet = await buildReviewPacket({
    scope: input.scope,
    subject: { ...input.subject, ...input.at },
    repo: input.worktree,
    specification: SpecificationProposalSchema.parse(artifacts.readJson(spec.id)),
    criteria,
    runs,
    commandVerdicts: criteria.map((c) => ({
      code: c.code,
      ...criterionVerdict(runs.filter((r) => r.criteria.includes(c.code))),
    })),
    ...(input.scope === 'integration'
      ? { otherRepositories: await otherRepositoryChanges(db, reviewed) }
      : {}),
  });
  let rejected: RuleIssue[] | undefined;
  for (let n = input.firstRun; n <= REVIEW_RUNS; n++) {
    let evaluation: ReviewEvaluation | undefined;
    const evaluate = (r: HarnessRawResult) => {
      evaluation = evaluateReview(r, packet);
      return evaluation.kind === 'invalid'
        ? { outcome: 'invalid', issues: evaluation.issues }
        : { outcome: evaluation.kind };
    };
    const { result, sessionRef } = await runner.run(
      {
        role: 'reviewer',
        template: { id: template.id, hash: template.hash },
        run: n,
        prompt: renderReviewPrompt(packet, rejected),
        wallClockMs: input.wallClockMs,
        ...(rejected === undefined ? {} : { reprompt: rejected }),
      },
      evaluate,
    );
    if (await runner.stopped()) return undefined;
    evaluation ??= evaluateReview(result, packet);
    if (evaluation.kind === 'valid') {
      return {
        kind: 'valid',
        packet,
        value: evaluation.value,
        sessionRef: sessionRef ?? null,
        harnessId: input.harnessId,
      };
    }
    if (evaluation.kind === 'harness_failed') {
      return { kind: 'failed', exitReason: 'review_failed', detail: evaluation.message };
    }
    rejected = evaluation.issues;
  }
  return {
    kind: 'failed',
    exitReason: 'invalid_output',
    detail: `the review was invalid after ${String(REVIEW_RUNS - 1)} re-prompt: ${(rejected ?? []).map((i) => `[${i.rule}] ${i.message}`).join('; ')}`,
  };
}

/**
 * Records a valid review (its Artifact, its row, its Findings and its
 * criterion verdicts as Evidence), then decides approval with the full rule
 * against the Task Branch head as git reads it now, and ends the Attempt with
 * `end`. One transaction. No review is stored without a valid proposal: the
 * Attempt fails `invalid_output` (still invalid after the re-prompt) or
 * `review_failed` (the reviewer Run crashed, timed out or did not start).
 */
export function finishReview(
  deps: ReviewDeps,
  input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    reviewedHead: string;
    reviewed: Reviewed;
    current: GateRef;
    reviewerChanges: string[];
    /** `integration`: the Integration Review (ADR-0035). */
    scope: ReviewPacket['scope'];
  },
  end: (tx: Tx, state: JobState, step: StageRunStepper, outcome: AttemptOutcome) => void,
): void {
  const { jobId, taskId, attemptId, reviewed, reviewedHead } = input;
  const base = input.current.baseSha;
  const content =
    reviewed.kind === 'valid' ? deps.artifacts.writeContent(reviewed.value) : undefined;
  changeJob(deps.db, { jobId, expectedVersion: 'current', actor: ACTOR }, (tx, state, step) => {
    const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (task?.state !== 'in_review') {
      throw new Error(`Task ${taskId} is ${String(task?.state)}, not in_review`);
    }
    const definition = TaskDefinitionSchema.parse(JSON.parse(task.definitionJson));
    const criteria = reviewedCriteria(tx, jobId, input.scope, definition);
    let review: ApprovalInput['review'] = null;
    if (reviewed.kind === 'reanchored') {
      review = recordReanchoredReview(tx, {
        jobId,
        taskId,
        attemptId,
        at: { headSha: reviewedHead, baseSha: base },
        original: reviewed.original,
        reason: reviewed.reason,
        patchId: reviewed.patchId,
        criteria,
      });
    } else if (reviewed.kind === 'valid' && content !== undefined) {
      const { value } = reviewed;
      const template = templateOf(reviewed.packet.scope);
      const artifact = deps.artifacts.record(
        tx,
        { jobId, taskId, attemptId, kind: 'review', content },
        ACTOR,
      );
      const reviewId = newId('rev');
      tx.insert(schema.reviews)
        .values({
          id: reviewId,
          jobId,
          taskId,
          attemptId,
          reviewerHarnessId: reviewed.harnessId,
          reviewerHarnessVersion: deps.harnessVersion,
          sessionRef: reviewed.sessionRef,
          promptTemplateId: template.id,
          promptTemplateHash: template.hash,
          packetJson: JSON.stringify(reviewed.packet),
          headSha: reviewedHead,
          baseSha: base,
          outcome: value.outcome,
          summary: value.summary,
          artifactId: artifact.id,
          createdAt: new Date().toISOString(),
        })
        .run();
      value.findings.forEach((f, position) => {
        tx.insert(schema.reviewFindings)
          .values({ id: newId('fnd'), reviewId, position, ...f, blocking: isBlocking(f) })
          .run();
      });
      for (const criterion of criteria) {
        const verdict = value.criteria.find((c) => c.code === criterion.code);
        tx.insert(schema.evidence)
          .values({
            id: newId('evd'),
            attemptId,
            kind: 'criterion',
            criterionId: criterion.id,
            reviewId,
            verdict: verdict?.verdict ?? 'not_tested',
            detail: verdict?.detail ?? 'the review gave no verdict',
            headSha: reviewedHead,
            baseSha: base,
            artifactId: artifact.id,
          })
          .run();
      }
      appendEvent(tx, {
        entityKind: 'review',
        entityId: reviewId,
        jobId,
        type: 'review.recorded',
        actor: ACTOR,
        payload: {
          taskId,
          attemptId,
          outcome: value.outcome,
          headSha: reviewedHead,
          baseSha: base,
          findings: value.findings.length,
          blocking: value.findings.filter(isBlocking).length,
        },
      });
      review = {
        outcome: value.outcome,
        blockingFindings: value.findings.filter(isBlocking).length,
        headSha: reviewedHead,
        baseSha: base,
      };
    }
    let outcome: AttemptOutcome;
    if (reviewed.kind === 'failed') {
      outcome = { state: 'failed', exitReason: reviewed.exitReason, detail: reviewed.detail };
    } else {
      const decision = decideApproval(
        approvalInput(tx, { attemptId, criteria, current: input.current, review }),
      );
      const problems = [...decision.problems, ...input.reviewerChanges];
      const changesRequested =
        review?.outcome === 'changes_requested' && isCurrent(review, input.current);
      const attempt = tx
        .select({ n: schema.attempts.n })
        .from(schema.attempts)
        .where(eq(schema.attempts.id, attemptId))
        .get();
      if (attempt === undefined) throw new Error(`no Attempt ${attemptId}`);
      const self = { id: attemptId, n: attempt.n };
      outcome =
        problems.length === 0
          ? {
              state: 'passed',
              exitReason: 'completed',
              detail: 'every Gate passed and the review approved',
            }
          : {
              state: 'failed',
              exitReason: changesRequested ? 'changes_requested' : 'gates_failed',
              detail: problems.join('; '),
              // A review that requested changes brings its own Findings; the rest are the Gates'.
              findings: [
                ...(changesRequested
                  ? []
                  : decision.problems.map((p) => gateFinding(self, 'approval', p))),
                ...input.reviewerChanges.map((p) => gateFinding(self, 'worktree.clean', p)),
              ],
            };
    }
    end(tx, state, step, outcome);
  });
  deps.onCommit();
}

/**
 * Records `original` re-anchored to `at` for `attemptId` (ADR-0041): a new
 * Review row pointing to it (`reanchored_from_review_id`), with the original's
 * reviewer, template, packet, outcome, Artifact and Findings, and its
 * criterion verdicts as Evidence on the new SHAs. No reviewer ran. Returns the
 * review as the approval rule reads it.
 */
function recordReanchoredReview(
  tx: Tx,
  input: {
    jobId: string;
    taskId: string;
    attemptId: string;
    at: GateRef;
    original: typeof schema.reviews.$inferSelect;
    reason: string;
    patchId: string | null;
    criteria: readonly CriterionRow[];
  },
): NonNullable<ApprovalInput['review']> {
  const { jobId, taskId, attemptId, at, original } = input;
  const reviewId = newId('rev');
  tx.insert(schema.reviews)
    .values({
      ...original,
      id: reviewId,
      attemptId,
      sessionRef: null,
      headSha: at.headSha,
      baseSha: at.baseSha,
      reanchoredFromReviewId: original.id,
      createdAt: new Date().toISOString(),
    })
    .run();
  const findings = tx
    .select()
    .from(schema.reviewFindings)
    .where(eq(schema.reviewFindings.reviewId, original.id))
    .orderBy(asc(schema.reviewFindings.position))
    .all();
  for (const f of findings) {
    tx.insert(schema.reviewFindings)
      .values({ ...f, id: newId('fnd'), reviewId })
      .run();
  }
  const verdicts = tx
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.reviewId, original.id), eq(schema.evidence.kind, 'criterion')))
    .all();
  for (const criterion of input.criteria) {
    const verdict = verdicts.find((e) => e.criterionId === criterion.id);
    tx.insert(schema.evidence)
      .values({
        id: newId('evd'),
        attemptId,
        kind: 'criterion',
        criterionId: criterion.id,
        reviewId,
        verdict: verdict?.verdict ?? 'not_tested',
        detail:
          verdict === undefined
            ? `the re-anchored review ${original.id} gave no verdict`
            : `${verdict.detail} (re-anchored from review ${original.id})`,
        headSha: at.headSha,
        baseSha: at.baseSha,
        artifactId: original.artifactId,
      })
      .run();
  }
  const blocking = findings.filter((f) => f.blocking).length;
  appendEvent(tx, {
    entityKind: 'review',
    entityId: reviewId,
    jobId,
    type: 'review.reanchored',
    actor: ACTOR,
    payload: {
      taskId,
      attemptId,
      reanchoredFrom: original.id,
      fromHeadSha: original.headSha,
      fromBaseSha: original.baseSha,
      headSha: at.headSha,
      baseSha: at.baseSha,
      outcome: original.outcome,
      patchId: input.patchId,
      reason: input.reason,
    },
  });
  return {
    outcome: ReviewOutcomeSchema.parse(original.outcome),
    blockingFindings: blocking,
    headSha: at.headSha,
    baseSha: at.baseSha,
  };
}

/** The approval rule's input, read from what is recorded for the Attempt. */
function approvalInput(
  tx: Tx,
  input: {
    attemptId: string;
    criteria: readonly CriterionRow[];
    current: GateRef;
    review: ApprovalInput['review'];
  },
): ApprovalInput {
  const { attemptId, criteria, current, review } = input;
  const runs = tx
    .select()
    .from(schema.verificationRuns)
    .where(eq(schema.verificationRuns.attemptId, attemptId))
    .all();
  const evidence = tx
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.attemptId, attemptId), eq(schema.evidence.kind, 'criterion')))
    .all();
  return {
    current,
    verification: runs.map((r) => ({
      key: r.commandKey,
      required: r.required,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      headSha: r.headSha,
      baseSha: r.baseSha,
    })),
    criteria: criteria.map((c) => ({
      code: c.code,
      mandatory: c.mandatory,
      evidence: evidence
        .filter((e) => e.criterionId === c.id)
        .map((e) => ({
          // Criterion Evidence only: from the commands or the review, never GitHub's checks.
          source: e.reviewId === null ? ('commands' as const) : ('review' as const),
          verdict: EvidenceVerdictSchema.parse(e.verdict),
          headSha: e.headSha,
          baseSha: e.baseSha,
        })),
    })),
    review,
  };
}

type CriterionRow = ReturnType<typeof currentCriteria>[number];

/**
 * The Acceptance Criteria a review judges: those the Task covers, or for the
 * Integration Review every one of the current Specification (ADR-0035).
 */
function reviewedCriteria(
  db: FactoryDb | Tx,
  jobId: string,
  scope: ReviewPacket['scope'],
  definition: TaskDefinition,
): CriterionRow[] {
  return scope === 'integration'
    ? currentCriteria(db, jobId)
    : criteriaCoveredBy(db, jobId, definition.acceptance);
}
