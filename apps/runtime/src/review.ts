/**
 * The independent review (ARCHITECTURE §9): the Review Packet the factory
 * builds, the versioned prompt template that renders it, and the check of
 * what the reviewer Harness Run proposes. The reviewer sees the Specification,
 * the Acceptance Criteria the Task covers, the diff `base..head` and the
 * factory's own Evidence; never the implementer's transcript or Task Result.
 */
import { createHash } from 'node:crypto';
import {
  ReviewPacketSchema,
  ReviewProposalSchema,
  schemaIssues,
  validateReview,
  type EvidenceVerdict,
  type ReviewPacket,
  type ReviewProposal,
  type RuleIssue,
  type SpecificationProposal,
} from '@factory/domain';
import { changedPaths, diffBetween } from '@factory/git';
import { describeHarnessExit, type HarnessRawResult } from '@factory/harness';
import { z } from 'zod';

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
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
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
  subject: ReviewPacket['subject'];
  /** The Factory Clone or the Worktree, to read the diff from. */
  repo: string;
  specification: SpecificationProposal;
  criteria: readonly { code: string; text: string; mandatory: boolean; verification: string }[];
  runs: readonly ReviewedRun[];
  /** Command-sourced criterion Evidence, by code. */
  commandVerdicts: readonly { code: string; verdict: EvidenceVerdict; detail: string }[];
}): Promise<ReviewPacket> {
  const { headSha, baseSha } = input.subject;
  const diff = await diffBetween(input.repo, baseSha, headSha, MAX_DIFF_BYTES);
  return ReviewPacketSchema.parse({
    packetVersion: 1,
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
