/**
 * Inbox Items (the `approvals` table) and their versioned decisions
 * (ARCHITECTURE §5, §8.1, §16; PRODUCT_SPEC §10; ADR-0016). No I/O.
 */
import { z } from 'zod';
import { InboxQuestionSchema, QuestionAnswerSchema, type InboxQuestion } from './questions.js';

export const ApprovalKindSchema = z.enum(['question', 'plan', 'spec_change', 'blocker', 'cleanup']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStateSchema = z.enum(['open', 'decided', 'cancelled', 'superseded']);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

/** Items stay pending until a human decides; nothing ever auto-approves (§17). */
export const ExpiresPolicySchema = z.enum(['remain_pending']);
export type ExpiresPolicy = z.infer<typeof ExpiresPolicySchema>;

export const ApprovalOptionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string(),
  /** What choosing it does. */
  description: z.string(),
  /** `true` when an agent proposed it (a Question's options); it is shown as such. */
  agentProposed: z.boolean(),
});
export type ApprovalOption = z.infer<typeof ApprovalOptionSchema>;

export const InboxDecisionSchema = z.object({
  option: z.string(),
  comment: z.string().nullable(),
  /** A `question` item's answers, one per answered question (ADR-0023). */
  answers: z.array(QuestionAnswerSchema).optional(),
});
export type InboxDecision = z.infer<typeof InboxDecisionSchema>;

/** One Inbox Item, as the API returns it. */
export const ApprovalSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  jobTitle: z.string(),
  projectId: z.string(),
  repositoryId: z.string(),
  taskId: z.string().nullable(),
  /** The Stage it holds, when it holds one. */
  stageId: z.string().nullable(),
  kind: ApprovalKindSchema,
  /** What is decided on (for `plan`, the plan Artifact id). A decision naming another is refused. */
  subjectRef: z.string(),
  question: z.string(),
  /** A `question` item's batched questions (agent-proposed, redacted); `null` for other kinds. */
  questions: z.array(InboxQuestionSchema).nullable(),
  /** Why a human is needed. */
  why: z.string(),
  options: z.array(ApprovalOptionSchema).min(1),
  recommended: z.string().nullable(),
  /** Artifact ids that back the item. */
  evidence: z.array(z.string()),
  state: ApprovalStateSchema,
  /** Hidden from the default Inbox view; undone with undefer. */
  deferred: z.boolean(),
  requestedBy: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decision: InboxDecisionSchema.nullable(),
  expiresPolicy: ExpiresPolicySchema,
  /** Bumped by every change of the item. A decision names it. */
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** `POST /v1/inbox/:id/decide`. */
export const DecideInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  subjectRef: z.string().min(1),
  option: z.string().min(1),
  comment: z.string().trim().max(5000).optional(),
});
export type DecideInput = z.infer<typeof DecideInputSchema>;

/** `POST /v1/inbox/:id/defer` and `/undefer`. */
export const DeferInputSchema = z.object({ expectedVersion: z.number().int().nonnegative() });
export type DeferInput = z.infer<typeof DeferInputSchema>;

/**
 * The one option of a `question` item: answering it, through `answerQuestion`
 * (each question by option or free text). The questions' own options are
 * agent-proposed and are on the questions, not here.
 */
export const QUESTION_OPTIONS: readonly ApprovalOption[] = [
  {
    id: 'answer',
    label: 'Answer',
    description:
      'Answer each question (an offered option or free text); a fresh Attempt continues on the same Task Branch with your answers. An answer never widens the scope or grants a permission.',
    agentProposed: false,
  },
];

/** The question an Inbox Question item shows in a list: how many it batches. */
export function questionItemTitle(taskKey: string, questions: readonly InboxQuestion[]): string {
  const blocking = questions.filter((q) => q.blocking).length;
  const optional = questions.length - blocking;
  return `Task ${taskKey} asks ${String(blocking)} question${blocking === 1 ? '' : 's'}${optional === 0 ? '' : ` (+${String(optional)} optional)`}`;
}

/**
 * `POST /v1/jobs/:id/plan/approve` and `/reject` (`approvePlan`, `rejectPlan`):
 * the plan item's version and the plan Artifact the human looked at.
 */
export const PlanDecisionInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  planArtifactId: z.string().min(1),
  comment: z.string().trim().max(5000).optional(),
});
export type PlanDecisionInput = z.infer<typeof PlanDecisionInputSchema>;

/**
 * The fixed options of a `plan` item. A Plan Edit is not an option: it is a
 * whole replacement Plan (`editPlan`), which supersedes the item instead.
 */
export const PLAN_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  {
    id: 'approve',
    label: 'Approve',
    description: 'Approve this Plan: execution starts.',
    agentProposed: false,
  },
  {
    id: 'reject',
    label: 'Reject',
    description: 'Reject this Plan: the Job ends rejected; every Artifact is kept.',
    agentProposed: false,
  },
  {
    id: 'request_changes',
    label: 'Request changes',
    description:
      'Send the Plan back to the planner with your comment as feedback (a Replan; counts against maxReplans).',
    agentProposed: false,
  },
];

/**
 * `POST /v1/jobs/:id/plan/edit` (`editPlan`): a whole replacement Plan, checked
 * by the same validator as the planner's. Not a Replan.
 */
export const EditPlanInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  planArtifactId: z.string().min(1),
  /** The replacement Plan; validated like a planner's (schema, then the Plan rules). */
  plan: z.unknown(),
});
export type EditPlanInput = z.infer<typeof EditPlanInputSchema>;

/** `POST /v1/jobs/:id/plan/request-changes` (`requestPlanChanges`): a Replan with feedback. */
export const RequestPlanChangesInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  planArtifactId: z.string().min(1),
  feedback: z.string().trim().min(1).max(5000),
});
export type RequestPlanChangesInput = z.infer<typeof RequestPlanChangesInputSchema>;

export interface PlanChangeRefusal {
  code: 'feedback_required' | 'replan_limit_reached';
  message: string;
}

/**
 * Why "request changes" is refused, or `undefined` when the Replan may start.
 * It needs feedback, and a Replan left under `maxReplans`. Pure.
 */
export function checkPlanChangeRequest(
  replans: { replansUsed: number; maxReplans: number },
  feedback: string | null | undefined,
): PlanChangeRefusal | undefined {
  if (feedback == null || feedback.trim() === '') {
    return {
      code: 'feedback_required',
      message: 'request changes needs feedback for the planner (the comment)',
    };
  }
  if (replans.replansUsed >= replans.maxReplans) {
    return {
      code: 'replan_limit_reached',
      message: `this Job has used ${String(replans.replansUsed)} of ${String(replans.maxReplans)} Replans (maxReplans); edit, approve, reject or cancel remain`,
    };
  }
  return undefined;
}

/** Only a human decides (ARCHITECTURE §16): `user:<name>`, never `agent:` or `system:`. */
export function isHumanActor(actor: string): boolean {
  return /^user:[^\s:]+$/.test(actor);
}

export interface InboxItemRef {
  state: ApprovalState;
  version: number;
  subjectRef: string;
  options: readonly Pick<ApprovalOption, 'id'>[];
}

export interface InboxChange {
  actor: string;
  expectedVersion: number;
  /** A decision names its subject and option; defer and undefer don't. */
  subjectRef?: string;
  option?: string;
}

export interface InboxRefusal {
  code:
    | 'actor_not_allowed'
    | 'item_not_open'
    | 'version_conflict'
    | 'subject_mismatch'
    | 'unknown_option';
  message: string;
}

/** Why a change to an Inbox Item is refused, or `undefined` when it may go ahead. Pure. */
export function checkInboxChange(
  item: InboxItemRef,
  change: InboxChange,
): InboxRefusal | undefined {
  if (!isHumanActor(change.actor)) {
    return {
      code: 'actor_not_allowed',
      message: `${change.actor} can't decide an Inbox Item; only a human (user:…) can`,
    };
  }
  if (item.state !== 'open') {
    return { code: 'item_not_open', message: `the item is ${item.state}, not open` };
  }
  if (item.version !== change.expectedVersion) {
    return {
      code: 'version_conflict',
      message: `the item is at version ${String(item.version)}, not ${String(change.expectedVersion)}. Re-read it and decide again`,
    };
  }
  if (change.subjectRef !== undefined && change.subjectRef !== item.subjectRef) {
    return {
      code: 'subject_mismatch',
      message: `the item decides on ${item.subjectRef}, not ${change.subjectRef}. Re-read it and decide again`,
    };
  }
  if (change.option !== undefined && !item.options.some((o) => o.id === change.option)) {
    return {
      code: 'unknown_option',
      message: `no option '${change.option}'; the item offers ${item.options.map((o) => o.id).join(', ')}`,
    };
  }
  return undefined;
}
