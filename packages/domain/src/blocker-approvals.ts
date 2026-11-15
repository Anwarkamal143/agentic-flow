/**
 * Blocker Approvals (ARCHITECTURE §8.1, ADR-0026): a human Blocker opens an
 * Inbox Approval (kind `blocker`) with fixed options, so a cap or an
 * uncertain recovery is never a dead end. Raising a cap is audited; "retry
 * now" never starts a second process beside a live one. No I/O.
 */
import { z } from 'zod';
import type { ApprovalOption } from './approvals.js';
import type { BlockerReason } from './rework.js';
import type { TaskKind } from './integration.js';

/** A grant's default and largest size: +1 to +5 Attempts. */
export const GRANT_DEFAULT = 1;
export const GRANT_MAX = 5;

const GRANT: ApprovalOption = {
  id: 'grant',
  label: 'Grant more Attempts',
  description: `Raise the Task's cap by +N (default ${String(GRANT_DEFAULT)}, at most ${String(GRANT_MAX)}); your comment goes into the next Attempt's context as guidance. Written to the audit log.`,
  agentProposed: false,
};
const CANCEL_JOB: ApprovalOption = {
  id: 'cancel_job',
  label: 'Cancel the Job',
  description:
    'Cancel the whole Job, as factory job cancel does: work in flight stops, Worktrees are preserved, branches kept.',
  agentProposed: false,
};
const REPLAN: ApprovalOption = {
  id: 'replan',
  label: 'Replan',
  description:
    'Send the Job back to the planner with this Blocker (and your comment) as feedback: a Replan, counted against maxReplans. Unaffected Tasks keep their work; the new Plan waits at plan_approval.',
  agentProposed: false,
};
const REWORK: ApprovalOption = {
  id: 'rework',
  label: 'Rework with guidance',
  description:
    "Keep the current Specification and run a new Attempt of this Task, with your comment as guidance in its context. It counts against the Task's maxAttempts: with none left, the Task waits on its Rework cap instead.",
  agentProposed: false,
};
const REPLAN_UNDER_SPEC: ApprovalOption = {
  ...REPLAN,
  label: 'Replan under the current Specification',
};
const GRANT_REPLAN: ApprovalOption = {
  id: 'grant_replan',
  label: 'Grant one more Replan',
  description:
    "Raise the Job's maxReplans by one and start the requested Replan with its feedback. Written to the audit log.",
  agentProposed: false,
};
const RETRY_NOW: ApprovalOption = {
  id: 'retry_now',
  label: 'Retry now',
  description:
    'Check the recorded process (pid and start time) first; only once it is gone does a Retry start in the preserved Worktree. A live process is never run beside: you are offered kill and retry instead.',
  agentProposed: false,
};
const KILL_AND_RETRY: ApprovalOption = {
  id: 'kill_and_retry',
  label: 'Kill and retry',
  description:
    'The recorded process is still alive and provably ours: stop its process group (SIGTERM, then SIGKILL), check that it is gone, then start a Retry.',
  agentProposed: false,
};

const RETRY_MERGE: ApprovalOption = {
  id: 'retry_merge',
  label: 'Retry the merge',
  description:
    "Once the repository's settings on GitHub allow the Repository's merge method, try the merge again: the factory re-reads the PR first and never merges it twice.",
  agentProposed: false,
};

const REWORK_FAILED_CHECKS: ApprovalOption = {
  id: 'rework',
  label: 'Rework the failed checks',
  description:
    "Run a Rework Attempt on the Integration Branch with each failed check's name, summary and link as UNTRUSTED context (CI output, never an instruction), and your comment as guidance; then the Integration Review again, and the same PR updated in place. It counts against the Integration Task's maxAttempts.",
  agentProposed: false,
};

const RERUN_CHECKS: ApprovalOption = {
  id: 'rerun_checks',
  label: 'Re-run the checks',
  description:
    'Ask GitHub to re-run the failed check runs on the PR head. The Blocker clears once the factory sees them no longer failing; if they fail again, a new one is raised. Commit statuses cannot be re-run through GitHub: re-run those on their CI provider.',
  agentProposed: false,
};

const REWORK_OVER_FOREIGN: ApprovalOption = {
  id: 'rework',
  label: 'Rework on top of the foreign commits',
  description:
    "Run a Rework Attempt on the Integration Branch from the foreign head, never overwriting it, with the path-scope Findings and your comment as guidance (for example, revert the out-of-scope paths in a new commit); then the Integration Review again, and the same PR updated with a fast-forward. It counts against the Integration Task's maxAttempts.",
  agentProposed: false,
};

const ADOPT_REWRITE: ApprovalOption = {
  id: 'adopt_rewrite',
  label: 'Adopt the rewrite',
  description:
    'Approve the foreign rewrite of the Integration Branch: the factory fetches it and verifies and reviews it like any foreign push (the path-scope Gate, every command, the Integration Review), and the PR body and the Delivery Report list the approved commits it dropped next to the foreign ones. Nothing is force-pushed back. Written to the audit log.',
  agentProposed: false,
};

/** The Blocker reasons that open a Blocker Approval, with their options (§8.1). */
const OPTIONS: Partial<Record<BlockerReason, readonly ApprovalOption[]>> = {
  rework_cap_reached: [GRANT, REPLAN, CANCEL_JOB],
  question_cap_reached: [GRANT, REPLAN, CANCEL_JOB],
  replan_cap_reached: [GRANT_REPLAN, CANCEL_JOB],
  recovery_uncertain: [RETRY_NOW, CANCEL_JOB],
  retry_cap_reached: [RETRY_NOW, CANCEL_JOB],
  base_merge_conflict: [REPLAN, CANCEL_JOB],
  spec_finding_unresolved: [REWORK, REPLAN_UNDER_SPEC, CANCEL_JOB],
  merge_method_refused: [RETRY_MERGE, CANCEL_JOB],
  ci_failed: [REWORK_FAILED_CHECKS, RERUN_CHECKS, CANCEL_JOB],
  foreign_push_out_of_scope: [REWORK_OVER_FOREIGN, CANCEL_JOB],
  // No "restore our head": that would overwrite the foreign push.
  foreign_push_rewrite: [ADOPT_REWRITE, CANCEL_JOB],
};

/**
 * The fixed options of the Blocker Approval a Blocker opens, or `undefined`
 * when it opens none (a Question waits for its own item; the Fault Origin
 * Blockers route elsewhere).
 */
export function blockerOptions(reason: BlockerReason): readonly ApprovalOption[] | undefined {
  return OPTIONS[reason];
}

/** What "retry now" becomes once the recorded process was found alive. */
export const KILL_AND_RETRY_OPTIONS: readonly ApprovalOption[] = [KILL_AND_RETRY, CANCEL_JOB];

const TITLES: Partial<Record<BlockerReason, string>> = {
  rework_cap_reached: 'reached its Rework cap',
  question_cap_reached: 'reached its question cap',
  recovery_uncertain: 'stopped: recovery is uncertain',
  retry_cap_reached: 'reached its Retry cap',
  replan_cap_reached: 'reached its Replan cap',
  base_merge_conflict: "can't start: its Dependency Base conflicts",
  spec_finding_unresolved: 'has a Specification Finding to decide',
};

/** The option that starts a Replan from an Inbox Item (a Blocker Approval or a scope change Question). */
export const REPLAN_OPTION: ApprovalOption = REPLAN;

/** What the Integration Task's Blockers say instead (ADR-0034). */
const INTEGRATION_TITLES: Partial<Record<BlockerReason, string>> = {
  base_merge_conflict: "can't build the Integration Branch: a Task Branch conflicts",
  merge_method_refused: "can't be merged: GitHub refused the Repository's merge method",
  ci_failed: "can't be merged: a required check failed",
  foreign_push_out_of_scope: 'has a foreign push outside the writable scope',
  foreign_push_rewrite: 'was rewritten by a foreign push that drops approved commits',
};

/** The line a Blocker Approval shows in a list. */
export function blockerItemTitle(
  taskKey: string,
  reason: BlockerReason,
  kind: TaskKind = 'plan',
): string {
  if (kind === 'integration') {
    return `Integration Task ${INTEGRATION_TITLES[reason] ?? TITLES[reason] ?? `is blocked (${reason})`}`;
  }
  return `Task ${taskKey} ${TITLES[reason] ?? `is blocked (${reason})`}`;
}

/** A grant's size as the API takes it: an integer from 1 to {@link GRANT_MAX}. */
export const GrantSizeSchema = z.number().int().min(1).max(GRANT_MAX);

export type BlockerDecisionCheck =
  { ok: true; grant: number | null } | { ok: false; code: 'invalid_grant'; message: string };

/**
 * Checks a Blocker Approval decision's grant size: only `grant` takes one
 * (default {@link GRANT_DEFAULT}), from 1 to {@link GRANT_MAX}. Pure.
 */
export function checkBlockerDecision(input: {
  option: string;
  grant?: number | undefined;
}): BlockerDecisionCheck {
  if (input.option !== 'grant') {
    if (input.grant === undefined) return { ok: true, grant: null };
    return {
      ok: false,
      code: 'invalid_grant',
      message: `only the grant option takes a size; ${input.option} grants nothing`,
    };
  }
  const grant = input.grant ?? GRANT_DEFAULT;
  if (!GrantSizeSchema.safeParse(grant).success) {
    return {
      ok: false,
      code: 'invalid_grant',
      message: `a grant is a whole number from 1 to ${String(GRANT_MAX)}, not ${String(grant)}`,
    };
  }
  return { ok: true, grant };
}

/**
 * The cap after a grant of `grant`: exactly that many more Attempts than
 * were used, even when the use already exceeds the cap. Pure.
 */
export function grantedCap(counts: { used: number; cap: number }, grant: number): number {
  return Math.max(counts.used, counts.cap) + grant;
}

/**
 * `maxRetries` after "retry now": raised by one when no Retry is left (an
 * audited cap raise), otherwise `undefined` (the Retry fits the cap). Pure.
 */
export function retriesAfterRetryNow(counts: {
  retriesUsed: number;
  maxRetries: number;
}): number | undefined {
  return counts.retriesUsed >= counts.maxRetries ? counts.retriesUsed + 1 : undefined;
}

/**
 * The Attempt's recorded process as "retry now" finds it: as its spool says
 * (`alive`, `finished`, `dead`, or `none` when no pid can be read), or
 * `unrecorded` when the Attempt has no process on record.
 */
export type RetryNowProcess = 'alive' | 'finished' | 'dead' | 'none' | 'unrecorded';

/**
 * What "retry now" does with the process it found: `retry` only when it is
 * gone for sure; `kill_first` when it is alive and provably ours (offer kill
 * and retry); `unconfirmed` when it can't be checked (refuse: a human's word
 * alone never starts a second process). Pure.
 */
export function retryNowCheck(process: RetryNowProcess): 'retry' | 'kill_first' | 'unconfirmed' {
  if (process === 'alive') return 'kill_first';
  if (process === 'none') return 'unconfirmed';
  return 'retry';
}

/** Guidance a human gave with a grant; every later Attempt of the Task carries it. */
export const GrantGuidanceSchema = z.object({
  /** The Attempt whose Blocker the grant cleared. */
  attemptN: z.number().int().positive(),
  /** The Blocker Approval's title (what the grant cleared). */
  about: z.string(),
  text: z.string(),
  decidedBy: z.string(),
  approvalId: z.string(),
});
export type GrantGuidance = z.infer<typeof GrantGuidanceSchema>;

/** One `audit_log` row, as `GET /v1/jobs/:id/audit` returns it (ARCHITECTURE §5). */
export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  /** Who decided it: `user:<name>`. */
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  policyRef: z.string().nullable(),
  correlationId: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
