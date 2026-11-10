/**
 * Inbox Items (the `approvals` table) and their versioned decisions
 * (ARCHITECTURE §5, §8.1, §16; PRODUCT_SPEC §10; ADR-0016). No I/O.
 */
import { z } from 'zod';

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
 * `POST /v1/jobs/:id/plan/approve` and `/reject` (`approvePlan`, `rejectPlan`):
 * the plan item's version and the plan Artifact the human looked at.
 */
export const PlanDecisionInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  planArtifactId: z.string().min(1),
  comment: z.string().trim().max(5000).optional(),
});
export type PlanDecisionInput = z.infer<typeof PlanDecisionInputSchema>;

/** The fixed options of a `plan` item in this cut (edit and replan come in later tickets). */
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
];

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
