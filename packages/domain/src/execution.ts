/**
 * Executing a Task (ARCHITECTURE §4.4, §7, §10): the Task and Attempt state
 * machines, the Task Packet the factory sends, the Task Result the Harness
 * claims, and what the factory records about both. No I/O.
 */
import { z } from 'zod';
import { AttemptFindingSchema } from './findings.js';
import { RiskSchema, RuleIssueSchema, TaskRoleSchema } from './proposals.js';

// ---- Task states (ARCHITECTURE §4.4) ---------------------------------------

export const TaskStateSchema = z.enum([
  'pending',
  'ready',
  'claimed',
  'running',
  'verifying',
  'in_review',
  'changes_requested',
  'approved',
  'integrated',
  'blocked',
  'failed',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Allowed Task transitions. Everything else is refused by the engine. */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['claimed', 'cancelled'],
  // `claimed → ready`: recovery gives back a claim whose Attempt never started.
  claimed: ['running', 'ready', 'failed', 'blocked', 'cancelled'],
  // `→ ready` from an Attempt in progress: recovery requeues it as a Retry.
  running: ['verifying', 'ready', 'failed', 'blocked', 'cancelled'],
  verifying: [
    'in_review',
    'approved',
    'changes_requested',
    'ready',
    'failed',
    'blocked',
    'cancelled',
  ],
  in_review: ['approved', 'changes_requested', 'ready', 'failed', 'blocked', 'cancelled'],
  changes_requested: ['ready', 'blocked', 'failed', 'cancelled'],
  approved: ['integrated'],
  blocked: ['ready', 'cancelled'],
  integrated: [],
  failed: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** A Task starts `ready` when it depends on nothing, else `pending` (its dependencies are unmet). */
export function initialTaskState(dependsOn: readonly string[]): TaskState {
  return dependsOn.length === 0 ? 'ready' : 'pending';
}

// ---- Attempts ---------------------------------------------------------------

/**
 * `running`: the Harness Run is alive. `verifying`: the factory is checking the
 * result itself. `in_review`: the independent reviewer is reviewing it.
 * `passed`: every Gate passed and the Task is approved. `failed`: see the exit
 * reason. `interrupted` and `cancelled` are set by recovery and cancellation.
 */
export const AttemptStateSchema = z.enum([
  'running',
  'verifying',
  'in_review',
  'passed',
  'failed',
  'interrupted',
  'cancelled',
]);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

/**
 * Why an Attempt ended. `completed`: it ran to the end and every Gate passed.
 * `gates_failed`: a required verification command failed, a mandatory
 * criterion has no passing Evidence, or Evidence or the review is stale
 * (recorded for another `(head, base)`). `changes_requested`: the review requested changes.
 * `review_failed`: the reviewer Harness Run did not exit 0 (it crashed, timed
 * out or did not start), so there is no review. `invalid_output`: no valid
 * Task Result, or no valid review, after its one re-prompt.
 * `not_done`: the Task Result's status is not `done`. `harness_failed`: the
 * Harness Run did not exit 0. `factory_error`: the factory itself broke.
 * `cancelled`: a human cancelled the Job (state `cancelled`). `interrupted`:
 * the runtime stopped while the Attempt was in progress and its Harness
 * process did not survive (state `interrupted`, set by recovery).
 */
export const AttemptExitReasonSchema = z.enum([
  'completed',
  'gates_failed',
  'changes_requested',
  'review_failed',
  'invalid_output',
  'not_done',
  'harness_failed',
  'factory_error',
  'cancelled',
  'interrupted',
]);
export type AttemptExitReason = z.infer<typeof AttemptExitReasonSchema>;

/**
 * Why an Attempt exists. `initial`: the Task's first. `rework`: the one before
 * failed a Gate or its review. `retry`: the one before was interrupted (an
 * infrastructure failure, not a verdict on the work).
 */
export const AttemptCauseSchema = z.enum(['initial', 'rework', 'retry']);
export type AttemptCause = z.infer<typeof AttemptCauseSchema>;

/**
 * How many of a Task's Attempts count toward its `max_attempts` (the Rework
 * cap): every Attempt but a Retry, which redoes an interrupted one. Pure.
 */
export function attemptsCountedForRework(attempts: readonly { cause: AttemptCause }[]): number {
  return attempts.filter((a) => a.cause !== 'retry').length;
}

/** How far a usage value can be trusted (ARCHITECTURE §13). */
export const UsageTagSchema = z.enum(['actual', 'estimated', 'unknown']);
export type UsageTag = z.infer<typeof UsageTagSchema>;

/**
 * How far the cost can be trusted. `unknown/subscription`: the Run was billed
 * to a subscription, so it has no per-Run cost (ARCHITECTURE §13).
 */
export const CostTagSchema = z.enum(['actual', 'estimated', 'unknown/subscription', 'unknown']);
export type CostTag = z.infer<typeof CostTagSchema>;

/**
 * Usage as recorded per Attempt (ARCHITECTURE §13). `tag` is the trust of the
 * token counts; `costTag` the trust of `costUsd`. Usage recorded before #14 has
 * no `costTag`: its `tag` covered both.
 */
export const UsageSchema = z.object({
  tag: UsageTagSchema,
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  costTag: CostTagSchema.optional(),
  durationMs: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** The trust of a usage's cost: its `costTag`, or (before #14) its `tag`. Pure. */
export function costTagOf(usage: Pick<Usage, 'tag' | 'costTag'>): CostTag {
  return usage.costTag ?? usage.tag;
}

/** The usage of two Harness Runs together, as trustworthy as the less trusted one. Pure. */
export function addUsage(a: Usage, b: Usage): Usage {
  const trust = UsageTagSchema.options;
  const costTrust = CostTagSchema.options;
  const sum = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  return {
    tag: trust[Math.max(trust.indexOf(a.tag), trust.indexOf(b.tag))] ?? 'unknown',
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    costTag:
      costTrust[Math.max(costTrust.indexOf(costTagOf(a)), costTrust.indexOf(costTagOf(b)))] ??
      'unknown',
    durationMs: a.durationMs + b.durationMs,
  };
}

// ---- Task Packet and Task Result (ARCHITECTURE §7) ---------------------------

/** Where the Harness writes its Task Result, relative to the Worktree. Never committed. */
export const RESULT_FILE = '.factory/result.json';

/** What the factory sends a developer Harness Run. Versioned; stored on the Attempt. */
export const TaskPacketSchema = z.object({
  packetVersion: z.literal(1),
  job: z.object({ id: z.string(), title: z.string(), objective: z.string() }),
  task: z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    objective: z.string(),
    role: TaskRoleSchema,
    risk: RiskSchema,
  }),
  repository: z.object({
    id: z.string(),
    name: z.string(),
    worktreePath: z.string(),
    baseBranch: z.string(),
    baseSha: z.string(),
    taskBranch: z.string(),
  }),
  scope: z.object({
    writable: z.array(z.string()),
    forbidden: z.array(z.string()),
    readHints: z.array(z.string()),
  }),
  acceptance: z.array(z.object({ code: z.string(), text: z.string(), mandatory: z.boolean() })),
  verification: z.array(z.object({ key: z.string(), command: z.string(), required: z.boolean() })),
  context: z.object({
    artifacts: z.array(z.object({ id: z.string(), kind: z.string(), contentHash: z.string() })),
    files: z.array(z.string()),
    /** A Rework Attempt: the Findings of the Attempt before it, to fix first. */
    priorFindings: z.array(AttemptFindingSchema).default([]),
  }),
  limits: z.object({ maxTurns: z.number().int().positive(), wallClockS: z.number().positive() }),
  protocol: z.object({ resultFile: z.literal(RESULT_FILE), mayAskQuestions: z.boolean() }),
});
export type TaskPacket = z.infer<typeof TaskPacketSchema>;

/** What the Harness claims. The factory trusts none of it (ARCHITECTURE §7). */
export const TaskResultSchema = z.object({
  status: z.enum(['done', 'needs_decision', 'blocked', 'failed']),
  summary: z.string().max(20_000),
  /** The commits the Harness believes it made. The factory reads the real ones from git. */
  commits: z.array(z.string().max(100)).max(1000),
  criteria: z
    .array(
      z.object({
        code: z.string(),
        claim: z.enum(['met', 'not_met', 'unknown']),
        how: z.string().max(5000),
      }),
    )
    .max(200),
  questions: z
    .array(
      z.object({
        text: z.string(),
        options: z.array(z.string()).optional(),
        recommended: z.string().optional(),
        blocking: z.boolean(),
      }),
    )
    .optional(),
  blocker: z.object({ kind: z.string(), detail: z.string() }).optional(),
  scopeChangeRequest: z.object({ paths: z.array(z.string()), reason: z.string() }).optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

// ---- Worktrees, verification, Evidence (ARCHITECTURE §5, §10) ----------------

export const WorktreeStateSchema = z.enum(['active', 'preserved', 'quarantined', 'removed']);
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;

export const WorktreeSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  taskId: z.string(),
  repositoryId: z.string(),
  /** Inside the workspace root; a Worktree of the Factory Clone, never of the source. */
  path: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  state: WorktreeStateSchema,
  /** First port of the leased block, while the lease is held. */
  portBase: z.number().int().nullable(),
  createdAt: z.string(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const VerificationRunSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  key: z.string(),
  command: z.string(),
  required: z.boolean(),
  /** `null` when the command did not exit (killed at its time limit). */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  headSha: z.string(),
  baseSha: z.string(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** A `log` Artifact holding the command's output. */
  outputArtifactId: z.string(),
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

export const EvidenceVerdictSchema = z.enum([
  'pass',
  'fail',
  'blocked',
  'not_tested',
  'not_applicable',
]);
export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;

/**
 * A recorded verdict, valid only for its `(headSha, baseSha)`. Kind
 * `verification`: one factory-run command. Kind `criterion`: one Acceptance
 * Criterion, from the commands that verify it (source `commands`) or from the
 * independent review (source `review`).
 */
/** Where a criterion verdict came from: the commands that name it, or the review that gave it. */
export function evidenceSource(row: { reviewId: string | null }): 'commands' | 'review' {
  return row.reviewId === null ? 'commands' : 'review';
}

export const EvidenceSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  kind: z.enum(['verification', 'criterion']),
  source: z.enum(['commands', 'review']),
  /** The review that gave the verdict, for source `review`. */
  reviewId: z.string().nullable(),
  verificationKey: z.string().nullable(),
  verificationRunId: z.string().nullable(),
  criterionId: z.string().nullable(),
  criterionCode: z.string().nullable(),
  verdict: EvidenceVerdictSchema,
  detail: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * The verdict of an Acceptance Criterion from the factory's own runs of the
 * commands that verify it. Pure.
 */
export function criterionVerdict(runs: readonly { exitCode: number | null }[]): {
  verdict: EvidenceVerdict;
  detail: string;
} {
  if (runs.length === 0) {
    return { verdict: 'not_tested', detail: 'no verification command verifies it' };
  }
  const failed = runs.filter((r) => r.exitCode !== 0).length;
  return failed === 0
    ? { verdict: 'pass', detail: `${String(runs.length)} verifying command(s) passed` }
    : {
        verdict: 'fail',
        detail: `${String(failed)} of ${String(runs.length)} verifying command(s) failed`,
      };
}

export const AttemptSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  n: z.number().int().positive(),
  /** `initial`, `rework` (the one before failed a Gate or its review) or `retry` (it was interrupted). */
  cause: AttemptCauseSchema,
  state: AttemptStateSchema,
  exitReason: AttemptExitReasonSchema.nullable(),
  /** A human-readable account of the exit reason. */
  exitDetail: z.string().nullable(),
  harness: z.object({ id: z.string(), version: z.string().nullable() }),
  sessionRef: z.string().nullable(),
  promptTemplate: z.object({ id: z.string(), hash: z.string() }),
  /** The Task Packet sent. */
  packet: TaskPacketSchema,
  worktreeId: z.string(),
  baseSha: z.string(),
  /** Read from git after the Run, never taken from the Task Result. */
  headSha: z.string().nullable(),
  /** `baseSha..headSha`, newest first, read from git. */
  commits: z.array(z.string()),
  /** The factory's commit of leftovers the Harness did not commit, if any. */
  wipCommit: z.string().nullable(),
  /** Ways the Task Result disagreed with git. */
  protocolViolations: z.array(RuleIssueSchema),
  /** The Findings raised against it, by the factory's Gates and by its review. */
  findings: z.array(AttemptFindingSchema),
  usage: UsageSchema.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  verificationRuns: z.array(VerificationRunSchema),
  evidence: z.array(EvidenceSchema),
});
export type Attempt = z.infer<typeof AttemptSchema>;

// ---- Delivery Report (Phase A: a local branch) --------------------------------

export const DeliveryReportSchema = z.object({
  reportVersion: z.literal(2),
  job: z.object({ id: z.string(), title: z.string() }),
  repository: z.object({
    id: z.string(),
    name: z.string(),
    /** The Factory Clone, where the Task Branches are. */
    clonePath: z.string(),
    source: z.string(),
  }),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      attemptId: z.string(),
      branch: z.string(),
      baseSha: z.string(),
      headSha: z.string(),
      /** Run from the source checkout: brings the Task Branch into it. */
      fetchCommand: z.string(),
      commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
      changedFiles: z.array(z.string()),
      wipCommit: z.string().nullable(),
      verification: z.array(
        z.object({
          key: z.string(),
          exitCode: z.number().int().nullable(),
          verdict: EvidenceVerdictSchema,
        }),
      ),
      /** Each covered criterion's verdict from all its current Evidence (commands and review). */
      criteria: z.array(
        z.object({
          code: z.string(),
          text: z.string(),
          mandatory: z.boolean(),
          verdict: EvidenceVerdictSchema,
          detail: z.string(),
        }),
      ),
      /** The independent review that approved the Task, on its `(headSha, baseSha)`. */
      review: z.object({
        id: z.string(),
        outcome: z.enum(['approved', 'changes_requested']),
        summary: z.string(),
        headSha: z.string(),
        baseSha: z.string(),
        reviewer: z.object({ harnessId: z.string(), version: z.string().nullable() }),
        findings: z.array(
          z.object({
            severity: z.string(),
            faultOrigin: z.string(),
            location: z.string(),
            problem: z.string(),
            blocking: z.boolean(),
          }),
        ),
      }),
    }),
  ),
  knownLimitations: z.array(z.string()),
});
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;
