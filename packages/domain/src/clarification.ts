/**
 * The clarification engine for proposal Stages (PRODUCT_SPEC §5, Phase D
 * Q14, ADR-0071). Triage and specification may end with categorized
 * `questions`; this code, never the agent, decides what happens to them:
 * - Discoverable: the factory finds the answer in the Repository. The Stage
 *   re-runs once with a discovery instruction; still open, it blocks with no
 *   Question (a human is never asked).
 * - Technical: the agent decides, kept as an ADR-style Decision Record.
 * - Product, Security, Operational: one Inbox Question batch per Stage Run,
 *   grouped by category, each with options and a recommended default
 *   (Security marked as needing approver rights). `maxQuestions` caps the
 *   batches per Stage; over the cap blocks.
 * Everything a question says is agent output, shown as agent-proposed; an
 * answer never grants a permission. No I/O.
 */
import { z } from 'zod';
import type { RuleIssue } from './proposals.js';
import type { InboxQuestion } from './questions.js';
import type { Blocker } from './rework.js';

export const ClarificationCategorySchema = z.enum([
  'discoverable',
  'technical',
  'product',
  'security',
  'operational',
]);
export type ClarificationCategory = z.infer<typeof ClarificationCategorySchema>;

/** The categories a human answers, in the order a batch groups them. */
export const HUMAN_CATEGORIES = ['product', 'security', 'operational'] as const;
export type HumanCategory = (typeof HUMAN_CATEGORIES)[number];

const item = z.string().trim().min(1).max(500);

/** One open question of a triage or specification proposal. */
export const ClarificationQuestionSchema = z.object({
  category: ClarificationCategorySchema,
  text: z.string().trim().min(1).max(2000),
  /** The answers offered: at least two for a human category, with `recommended` among them. */
  options: z.array(item).max(10).default([]),
  /** The recommended default (human categories): one of `options`. */
  recommended: item.optional(),
  /** Technical only: what the agent decided. */
  decision: z.string().trim().min(1).max(2000).optional(),
  /** Technical only: why. */
  rationale: z.string().trim().min(1).max(4000).optional(),
});
export type ClarificationQuestion = z.input<typeof ClarificationQuestionSchema>;

/** The `questions` field triage and specification proposals carry (optional). */
export const ProposalQuestionsSchema = z.array(ClarificationQuestionSchema).max(20).optional();

/**
 * Where a proposal's questions break the shape their category needs (the
 * usual one re-prompt follows): a Technical question without the agent's
 * decision, a human one with fewer than two options or no recommended
 * option among them. Pure.
 */
export function clarificationIssues(questions: readonly ClarificationQuestion[]): RuleIssue[] {
  const issues: RuleIssue[] = [];
  questions.forEach((q, i) => {
    const at = `questions[${String(i)}] (${q.category})`;
    if (q.category === 'technical' && q.decision === undefined) {
      issues.push({
        rule: 'clarification.technical_decision',
        message: `${at}: a technical question is yours to decide; give your decision (and rationale)`,
      });
    }
    if (!isHuman(q.category)) return;
    const options = q.options ?? [];
    if (options.length < 2) {
      issues.push({
        rule: 'clarification.options',
        message: `${at}: a question for a human offers at least two options`,
      });
    } else if (q.recommended === undefined || !options.includes(q.recommended)) {
      issues.push({
        rule: 'clarification.recommended',
        message: `${at}: give the recommended default as one of its options (${options.join(', ')})`,
      });
    }
  });
  return issues;
}

export type ClarificationRoute =
  /** Nothing for a human or the Repository to answer: the output is applied. */
  | { kind: 'proceed' }
  /** The Stage re-runs once, told to find these in the Repository. */
  | { kind: 'discover'; questions: string[] }
  /** One Inbox Question batch, grouped by category. */
  | { kind: 'ask'; questions: InboxQuestion[] }
  /** The Stage blocks with no Question. */
  | { kind: 'blocked'; blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'> };

/**
 * What a proposal Stage's questions lead to. Discoverable questions come
 * first: they re-run the Stage once (`discoveryRerunUsed` counts the Stage's
 * re-run over the Job), then block. Human questions are asked in one batch
 * while fewer than `maxQuestions` batches were asked for the Stage, and
 * block beyond. Technical questions never stop the Stage. Pure.
 */
export function routeClarification(input: {
  questions: readonly ClarificationQuestion[];
  discoveryRerunUsed: boolean;
  batchesUsed: number;
  maxQuestions: number;
}): ClarificationRoute {
  const discoverable = input.questions.filter((q) => q.category === 'discoverable');
  if (discoverable.length > 0) {
    if (!input.discoveryRerunUsed) {
      return { kind: 'discover', questions: discoverable.map((q) => q.text) };
    }
    return {
      kind: 'blocked',
      blocker: {
        kind: 'policy',
        reason: 'discoverable_unresolved',
        detail: `the Stage re-ran once to find these in the Repository and still could not: ${discoverable.map((q) => q.text).join(' | ')}. A Discoverable question is never asked of a human`,
        requiredAction:
          'cancel the Job (factory job cancel <job>) and create one whose description answers it, or make the Repository answer it',
      },
    };
  }
  const human = HUMAN_CATEGORIES.flatMap((c) => input.questions.filter((q) => q.category === c));
  if (human.length === 0) return { kind: 'proceed' };
  if (input.batchesUsed >= input.maxQuestions) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'policy',
        reason: 'clarification_cap_reached',
        detail: `the Stage asked again after ${String(input.batchesUsed)} of at most ${String(input.maxQuestions)} Question batches (maxQuestions), so no Question is opened`,
        requiredAction:
          'cancel the Job (factory job cancel <job>), or raise maxQuestions for new Jobs and create the Job again',
      },
    };
  }
  return {
    kind: 'ask',
    questions: human.map((q, i) => {
      const options = q.options ?? [];
      const category = q.category as HumanCategory;
      return {
        id: `q${String(i + 1)}`,
        source: 'clarification',
        text: q.text,
        options,
        recommended:
          q.recommended !== undefined && options.includes(q.recommended) ? q.recommended : null,
        blocking: true,
        agentProposed: true,
        paths: [],
        category,
        requiresApprover: category === 'security',
      };
    }),
  };
}

/** One Technical decision the agent made, as its Decision Record keeps it. */
export const DecisionRecordSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  decision: z.string(),
  rationale: z.string().nullable(),
  agentProposed: z.literal(true),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** The `decision_record` Artifact's content: one Stage Run's Technical decisions. */
export const DecisionRecordContentSchema = z.object({
  stageId: z.string(),
  stageRunId: z.string(),
  decisions: z.array(DecisionRecordSchema).min(1),
});
export type DecisionRecordContent = z.infer<typeof DecisionRecordContentSchema>;

/** The Technical questions' decisions, in order. Pure. */
export function decisionRecordsOf(questions: readonly ClarificationQuestion[]): DecisionRecord[] {
  return questions
    .filter((q) => q.category === 'technical' && q.decision !== undefined)
    .map((q) => ({
      question: q.text,
      options: [...(q.options ?? [])],
      decision: q.decision ?? '',
      rationale: q.rationale ?? null,
      agentProposed: true,
    }));
}

/**
 * The `clarification` Artifact's content: a proposal Stage Run's output that
 * stopped on its questions (never applied, never regenerated), the route the
 * factory took, and, for `ask`, the Inbox Question's id.
 */
export const ClarificationContentSchema = z.object({
  stageId: z.string(),
  stageRunId: z.string(),
  route: z.enum(['discover', 'ask', 'blocked']),
  output: z.unknown(),
  questions: z.array(ClarificationQuestionSchema),
});
export type ClarificationContent = z.infer<typeof ClarificationContentSchema>;

/**
 * One earlier round of a Stage, as its next Stage Run's prompt carries it:
 * the output that stopped, its questions, and the answers (`ask`) or the
 * questions to discover (`discover`).
 */
export interface ClarificationRound {
  route: 'discover' | 'ask' | 'blocked';
  output: unknown;
  questions: readonly ClarificationQuestion[];
  /** `ask`, once answered: each question with its answer. */
  answers: readonly { question: string; category: string; answer: string | null }[];
}

/** The one option of a proposal Stage's Question (ADR-0071). */
export const CLARIFICATION_OPTIONS = [
  {
    id: 'answer',
    label: 'Answer',
    description:
      'Answer each question (an offered option or free text); a new Stage Run continues with your answers, and the output that asked stays an Artifact. An answer never grants a permission.',
    agentProposed: false,
  },
] as const;

/** The line a proposal Stage's Question shows in a list. */
export function clarificationItemTitle(
  stageId: string,
  questions: readonly InboxQuestion[],
): string {
  const n = questions.length;
  return `${stageId.charAt(0).toUpperCase()}${stageId.slice(1)} asks ${String(n)} question${n === 1 ? '' : 's'}`;
}

/** Each asked question with its answer (`null`: left unanswered), for the next Stage Run. Pure. */
export function clarificationAnswers(
  questions: readonly InboxQuestion[],
  answers: readonly {
    questionId: string;
    option?: string | undefined;
    text?: string | undefined;
  }[],
): ClarificationRound['answers'] {
  return questions.map((q) => {
    const a = answers.find((x) => x.questionId === q.id);
    return {
      question: q.text,
      category: q.category ?? 'product',
      answer: a === undefined ? null : (a.option ?? a.text ?? null),
    };
  });
}

function isHuman(category: ClarificationCategory): category is HumanCategory {
  return (HUMAN_CATEGORIES as readonly string[]).includes(category);
}
