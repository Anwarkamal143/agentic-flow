/**
 * The independent review Gate and the approval rule (ARCHITECTURE §4.4, §4.6,
 * §9; PRODUCT_SPEC §8). The Review Packet the factory sends a reviewer
 * Harness Run, the review it proposes, the code checks on that proposal, and
 * the decision whether a Task is approved. No I/O.
 */
import { z } from 'zod';
import { EvidenceVerdictSchema, type EvidenceVerdict } from './execution.js';
import { SpecificationProposalSchema, type RuleIssue } from './proposals.js';

// ---- Findings (ARCHITECTURE §4.6) ---------------------------------------------

export const FindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Severities that block by default (PRODUCT_SPEC §8). */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = ['critical', 'high'];

/** Where a Finding's fix belongs, which decides where Rework is routed (#9, Phase B). */
export const FaultOriginSchema = z.enum(['implementation', 'plan', 'spec', 'infrastructure']);
export type FaultOrigin = z.infer<typeof FaultOriginSchema>;

export const ReviewOutcomeSchema = z.enum(['approved', 'changes_requested']);
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

/** One problem a reviewer found, as it proposes it. */
export const FindingProposalSchema = z.object({
  severity: FindingSeveritySchema,
  faultOrigin: FaultOriginSchema,
  /** `path`, `path:line`, or `general`. */
  location: z.string().min(1).max(500),
  problem: z.string().min(1).max(5000),
  why: z.string().max(5000),
  recommendation: z.string().max(5000),
  blocking: z.boolean(),
});
export type FindingProposal = z.infer<typeof FindingProposalSchema>;

/** What a reviewer Harness Run proposes. Validated, stored as a `review` Artifact, never regenerated. */
export const ReviewProposalSchema = z.object({
  outcome: ReviewOutcomeSchema,
  summary: z.string().min(1).max(20_000),
  findings: z.array(FindingProposalSchema).max(200),
  /** The reviewer's verdict on each Acceptance Criterion in the packet, by code. */
  criteria: z
    .array(
      z.object({
        code: z.string(),
        verdict: z.enum(['pass', 'fail', 'blocked', 'not_tested']),
        detail: z.string().max(5000),
      }),
    )
    .max(200),
});
export type ReviewProposal = z.infer<typeof ReviewProposalSchema>;

/**
 * Code checks on a schema-valid review. `criteria`: the codes of the
 * Acceptance Criteria the reviewed Task covers (the ones in the packet).
 */
export function validateReview(
  review: ReviewProposal,
  ctx: { criteria: readonly string[] },
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const seen = new Set<string>();
  for (const c of review.criteria) {
    if (!ctx.criteria.includes(c.code)) {
      issues.push({
        rule: 'review.criteria_known',
        message: `${c.code} is not an Acceptance Criterion of this Task (${ctx.criteria.join(', ') || 'none'})`,
      });
    }
    if (seen.has(c.code)) {
      issues.push({ rule: 'review.criteria_unique', message: `${c.code} has two verdicts` });
    }
    seen.add(c.code);
  }
  review.findings.forEach((f, i) => {
    if (BLOCKING_SEVERITIES.includes(f.severity) && !f.blocking) {
      issues.push({
        rule: 'review.blocking_severity',
        message: `finding ${String(i + 1)} is ${f.severity}, which always blocks; set blocking: true or lower its severity`,
      });
    }
  });
  const blocking = review.findings.filter(isBlocking).length;
  if (review.outcome === 'approved' && blocking > 0) {
    issues.push({
      rule: 'review.outcome_consistent',
      message: `the outcome is approved, but ${String(blocking)} finding(s) block`,
    });
  }
  if (review.outcome === 'changes_requested' && blocking === 0) {
    issues.push({
      rule: 'review.outcome_consistent',
      message: 'the outcome is changes_requested, but no finding blocks; name the blocking finding',
    });
  }
  return issues;
}

/** A Finding blocks when the reviewer says so or its severity always blocks. */
export function isBlocking(finding: Pick<FindingProposal, 'severity' | 'blocking'>): boolean {
  return finding.blocking || BLOCKING_SEVERITIES.includes(finding.severity);
}

// ---- The Review Packet (ARCHITECTURE §9) -----------------------------------------

/**
 * What the factory sends a reviewer Harness Run: the Specification, the
 * Acceptance Criteria the Task covers, the diff `base_sha..head_sha` and the
 * factory's own Evidence. Never the implementer's transcript or Task Result.
 */
export const ReviewPacketSchema = z.object({
  packetVersion: z.literal(1),
  /** What is reviewed: identifiers and SHAs only. */
  subject: z.object({
    jobId: z.string(),
    taskId: z.string(),
    taskKey: z.string(),
    attemptId: z.string(),
    headSha: z.string(),
    baseSha: z.string(),
  }),
  specification: SpecificationProposalSchema,
  acceptanceCriteria: z.array(
    z.object({
      code: z.string(),
      text: z.string(),
      mandatory: z.boolean(),
      verification: z.string(),
    }),
  ),
  diff: z.object({
    files: z.array(z.string()),
    /** `git diff base..head`, cut at a size limit. */
    patch: z.string(),
    truncated: z.boolean(),
  }),
  evidence: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('verification'),
        key: z.string(),
        command: z.string(),
        required: z.boolean(),
        exitCode: z.number().int().nullable(),
        timedOut: z.boolean(),
        verdict: EvidenceVerdictSchema,
        /** The end of the command's output. */
        outputTail: z.string(),
        headSha: z.string(),
        baseSha: z.string(),
      }),
      z.object({
        kind: z.literal('criterion'),
        code: z.string(),
        verdict: EvidenceVerdictSchema,
        detail: z.string(),
        headSha: z.string(),
        baseSha: z.string(),
      }),
    ]),
  ),
});
export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;

// ---- Stored reviews (API) ---------------------------------------------------------

export const FindingSchema = FindingProposalSchema.extend({ id: z.string() });
export type Finding = z.infer<typeof FindingSchema>;

/** A recorded review, valid only for its `(headSha, baseSha)`. */
export const ReviewSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  taskId: z.string(),
  attemptId: z.string(),
  reviewer: z.object({ harnessId: z.string(), version: z.string().nullable() }),
  /** The reviewer's own Session: a fresh one, never the implementer's. */
  sessionRef: z.string().nullable(),
  promptTemplate: z.object({ id: z.string(), hash: z.string() }),
  headSha: z.string(),
  baseSha: z.string(),
  outcome: ReviewOutcomeSchema,
  summary: z.string(),
  /** The `review` Artifact holding the validated proposal. */
  artifactId: z.string(),
  /** The Review Packet the reviewer was sent. */
  packet: ReviewPacketSchema,
  findings: z.array(FindingSchema),
  createdAt: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

// ---- The approval rule --------------------------------------------------------------

/** The commit pair a Gate's Evidence or a review was recorded against. */
export interface GateRef {
  headSha: string;
  baseSha: string;
}

/** Evidence or a review counts only for the `(head, base)` it was recorded against. */
export function isCurrent(gate: GateRef, current: GateRef): boolean {
  return gate.headSha === current.headSha && gate.baseSha === current.baseSha;
}

export interface ApprovalInput {
  /** The Task Branch head and the base, as git says now. */
  current: GateRef;
  verification: (GateRef & {
    key: string;
    required: boolean;
    exitCode: number | null;
    timedOut: boolean;
  })[];
  /** The Acceptance Criteria the Task covers, with every Evidence row for each. */
  criteria: {
    code: string;
    mandatory: boolean;
    evidence: (GateRef & { source: 'commands' | 'review'; verdict: EvidenceVerdict })[];
  }[];
  review: (GateRef & { outcome: ReviewOutcome; blockingFindings: number }) | null;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Why not, one line per Gate that did not pass. */
  problems: string[];
  /** Each covered criterion's verdict from its current Evidence. */
  criteria: { code: string; mandatory: boolean; verdict: EvidenceVerdict }[];
}

/** Strongest first: one `fail` or `blocked` from any source outweighs every `pass`. */
const VERDICT_PRECEDENCE: readonly EvidenceVerdict[] = [
  'fail',
  'blocked',
  'pass',
  'not_applicable',
  'not_tested',
];

/**
 * A criterion's verdict from all its current Evidence (commands and review):
 * the strongest verdict wins, and no current Evidence is `not_tested`.
 */
export function combineVerdicts(verdicts: readonly EvidenceVerdict[]): EvidenceVerdict {
  return VERDICT_PRECEDENCE.find((v) => verdicts.includes(v)) ?? 'not_tested';
}

/**
 * Required verification commands that did not pass on the current commit.
 * The Gates checked before a review is worth running.
 */
export function verificationProblems(
  current: GateRef,
  verification: ApprovalInput['verification'],
): string[] {
  const problems: string[] = [];
  for (const run of verification) {
    if (!run.required) continue;
    if (!isCurrent(run, current)) {
      problems.push(
        `verification ${run.key} ran on ${short(run.headSha)}, not on ${short(current.headSha)}, so it is stale`,
      );
    } else if (run.exitCode !== 0) {
      problems.push(
        `verification ${run.key} ${run.timedOut ? 'timed out' : `exited ${String(run.exitCode)}`}`,
      );
    }
  }
  return problems;
}

/**
 * The full approval rule: every required verification command passed on the
 * current commit, a current review approved, and every mandatory criterion
 * the Task covers is `pass`, combined over its current Evidence from the
 * commands and the review:
 *   1. any current `fail` or `blocked`, from either source, blocks;
 *   2. otherwise any current `pass` satisfies it (a reviewer's `not_tested`
 *      means "I didn't check this", not "this is unverified");
 *   3. otherwise (only `not_tested`, or no Evidence) it blocks.
 * `not_applicable` doesn't satisfy it either: it needs a justification, and
 * nothing checks one yet (PRODUCT_SPEC §8).
 */
export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const problems = verificationProblems(input.current, input.verification);
  const { review } = input;
  if (review === null) {
    problems.push('there is no review');
  } else if (!isCurrent(review, input.current)) {
    problems.push(
      `the review was recorded for ${short(review.headSha)} on base ${short(review.baseSha)}, but the Task Branch is at ${short(input.current.headSha)} on base ${short(input.current.baseSha)}, so the review is stale`,
    );
  } else if (review.outcome !== 'approved') {
    problems.push(
      `the review requested changes (changes requested, ${String(review.blockingFindings)} blocking finding(s))`,
    );
  }
  const criteria = input.criteria.map((c) => ({
    code: c.code,
    mandatory: c.mandatory,
    verdict: combineVerdicts(
      c.evidence.filter((e) => isCurrent(e, input.current)).map((e) => e.verdict),
    ),
  }));
  for (const c of criteria) {
    if (c.mandatory && c.verdict !== 'pass') {
      problems.push(`mandatory ${c.code} has Evidence ${c.verdict}, not pass`);
    }
  }
  return { approved: problems.length === 0, problems, criteria };
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
