/**
 * The Merge Gate (#58, ADR-0037; PRODUCT_SPEC §9, GLOSSARY): whether a Job's
 * pull request may be merged, decided by plain code over persisted rows (the
 * `pull_requests` and `pr_checks` rows the poller wrote, the approved
 * Integration Task, the Repository). Each condition is pass, fail or pending,
 * with a reason. Pure: the caller passes `now`.
 */
import { z } from 'zod';
import type { ApprovalOption } from './approvals.js';

/**
 * The Merge Policy (Q5, ADR-0038), stored on the Repository. `never_auto` (the
 * default): the factory never merges; a human merges on GitHub.
 * `human_approval`: the factory merges after a human approves the `merge`
 * Inbox Item. `auto_if_low_risk_and_green` is refused until Phase E.
 */
export const MergePolicySchema = z.enum(['never_auto', 'human_approval']);
export type MergePolicy = z.infer<typeof MergePolicySchema>;

/** Strictest first: an override may move only toward the start. */
const STRICTNESS: readonly MergePolicy[] = ['never_auto', 'human_approval'];

/** How the factory merges a PR (`merge.method` per Repository; default a merge commit, ADR-0038). */
export const MergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

/** A Job's Merge Policy as frozen into its Effective Configuration, with the level it came from. */
export const EffectiveMergePolicySchema = z.object({
  value: MergePolicySchema,
  source: z.enum(['repository', 'job']),
});
export type EffectiveMergePolicy = z.infer<typeof EffectiveMergePolicySchema>;

export type MergePolicyResolution =
  | { ok: true; policy: EffectiveMergePolicy }
  | { ok: false; code: 'merge_policy_looser'; message: string };

/**
 * A Job's Merge Policy: the Repository's, or the Job's override when it is at
 * least as strict (PRODUCT_SPEC §9: an override may only make it stricter). Pure.
 */
export function resolveMergePolicy(
  repository: MergePolicy,
  override: MergePolicy | undefined,
): MergePolicyResolution {
  if (override === undefined)
    return { ok: true, policy: { value: repository, source: 'repository' } };
  if (STRICTNESS.indexOf(override) > STRICTNESS.indexOf(repository)) {
    return {
      ok: false,
      code: 'merge_policy_looser',
      message: `a Job may only make the Repository's Merge Policy stricter: ${override} is looser than ${repository}`,
    };
  }
  return { ok: true, policy: { value: override, source: 'job' } };
}

export const GateStatusSchema = z.enum(['pass', 'fail', 'pending']);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const MergeGateConditionIdSchema = z.enum([
  'target',
  'reviewed_head',
  'checks',
  'reviews',
  'mergeable',
  'delivery_order',
  'policy',
]);
export type MergeGateConditionId = z.infer<typeof MergeGateConditionIdSchema>;

export const MergeGateConditionSchema = z.object({
  id: MergeGateConditionIdSchema,
  label: z.string(),
  status: GateStatusSchema,
  reason: z.string(),
});
export type MergeGateCondition = z.infer<typeof MergeGateConditionSchema>;

export const MergeGateSchema = z.object({
  /** `fail` if any condition fails, else `pending` if any is pending, else `pass`. */
  verdict: GateStatusSchema,
  conditions: z.array(MergeGateConditionSchema),
});
export type MergeGate = z.infer<typeof MergeGateSchema>;

/** A check's outcome as the gate reads it: a check run or the newest commit status of a context. */
export const CheckOutcomeSchema = z.enum(['pending', 'success', 'neutral', 'skipped', 'failure']);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

/** A human's approval of a `merge` item: who, and when (ISO time). */
export interface MergeApproval {
  by: string;
  at: string;
}

export interface MergeGateInput {
  /** The PR as the poller last recorded it. */
  pr: {
    owner: string;
    name: string;
    state: 'open' | 'closed' | 'merged';
    baseBranch: string;
    headBranch: string;
    headSha: string;
    baseSha: string;
    /** GitHub's `mergeable_state`; `null` until read. */
    mergeableState: string | null;
    /** When the factory first saw `headSha` as the PR head (the push): the grace window starts here. */
    headSeenAt: string;
  };
  /** Where the PR must be: the Repository's coordinates and default branch, the Integration Branch. */
  expected: { owner: string; name: string; baseBranch: string; headBranch: string };
  /** The head the Integration Review approved (or its skip rule held on). */
  reviewedHeadSha: string | null;
  /** Every check reported on the PR head. */
  checks: readonly { name: string; outcome: CheckOutcome }[];
  /** The Repository's `requiredChecks`: when set, only these count, and each must report. */
  requiredChecks: readonly string[];
  /** How long after a push no check reported still means "wait" (default 2 min). */
  graceMs: number;
  now: string;
  /** Blocking Findings still open on the approved Integration Attempt. */
  blockingFindings: number;
  /** GitHub users whose latest review is `CHANGES_REQUESTED`. */
  changesRequestedBy: readonly string[];
  policy: MergePolicy;
  /** Under `human_approval`: who approved the `merge` item at these SHAs, and when; else `null`. */
  approval: MergeApproval | null;
  /**
   * The Repositories this PR's Repository comes after in the Delivery Order
   * (its `after`, ADR-0052, ADR-0066), each with its current PR. Empty or
   * absent (a single-repo Job, or the first Repository): no such condition.
   */
  earlier?: readonly EarlierPullRequest[];
}

/** The PR of a Repository earlier in the Delivery Order, as the Merge Gate reads it. */
export interface EarlierPullRequest {
  repository: string;
  /** `owner/name#number`; `null` while none is opened. */
  pullRequest: string | null;
  state: 'open' | 'closed' | 'merged' | null;
  /** Under `human_approval`: its `merge` item is approved at its current SHAs. */
  mergeApproved: boolean;
}

/** The default grace window: checks have 2 minutes after a push to report (Q13). */
export const DEFAULT_CHECKS_GRACE_MS = 120_000;

/** The reason of a checks condition that passed by grace. Evidence, the PR body and the report say it. */
export const NO_CHECKS_REPORTED = 'no checks reported';

const short = (sha: string) => sha.slice(0, 12);

export function evaluateMergeGate(input: MergeGateInput): MergeGate {
  const conditions: MergeGateCondition[] = [
    target(input),
    reviewedHead(input),
    checks(input),
    reviews(input),
    mergeable(input),
    ...(input.earlier === undefined || input.earlier.length === 0
      ? []
      : [deliveryOrder(input.earlier, input.policy)]),
    policy(input),
  ];
  return { verdict: verdictOf(conditions), conditions };
}

function verdictOf(conditions: readonly MergeGateCondition[]): GateStatus {
  return conditions.some((c) => c.status === 'fail')
    ? 'fail'
    : conditions.some((c) => c.status === 'pending')
      ? 'pending'
      : 'pass';
}

/**
 * `gate` once a human approved its `merge` item under `human_approval`: the
 * policy condition passes, naming who and when; the others are kept as they
 * were evaluated. Pure.
 */
export function withMergeApproval(gate: MergeGate, approval: MergeApproval): MergeGate {
  const conditions = gate.conditions.map((c) =>
    c.id === 'policy' ? policyCondition('human_approval', approval) : c,
  );
  return { verdict: verdictOf(conditions), conditions };
}

function target({ pr, expected }: MergeGateInput): MergeGateCondition {
  const label = 'Correct repository, base and head';
  const problems: string[] = [];
  if (pr.owner !== expected.owner || pr.name !== expected.name) {
    problems.push(`the PR is on ${pr.owner}/${pr.name}, not ${expected.owner}/${expected.name}`);
  }
  if (pr.baseBranch !== expected.baseBranch) {
    problems.push(`its base is ${pr.baseBranch}, not ${expected.baseBranch}`);
  }
  if (pr.headBranch !== expected.headBranch) {
    problems.push(`its head is ${pr.headBranch}, not ${expected.headBranch}`);
  }
  if (pr.state !== 'open') problems.push(`it is ${pr.state}`);
  return problems.length === 0
    ? {
        id: 'target',
        label,
        status: 'pass',
        reason: `${pr.owner}/${pr.name}: ${pr.headBranch} into ${pr.baseBranch}, open`,
      }
    : { id: 'target', label, status: 'fail', reason: problems.join('; ') };
}

function reviewedHead({ pr, reviewedHeadSha }: MergeGateInput): MergeGateCondition {
  const label = 'The reviewed SHA is the PR head';
  if (reviewedHeadSha === pr.headSha) {
    return {
      id: 'reviewed_head',
      label,
      status: 'pass',
      reason: `the Integration Review approved ${short(pr.headSha)}, the PR head`,
    };
  }
  return {
    id: 'reviewed_head',
    label,
    status: 'fail',
    reason:
      reviewedHeadSha === null
        ? `nothing reviewed is approved for the PR head ${short(pr.headSha)}`
        : `the PR head ${short(pr.headSha)} is not the reviewed ${short(reviewedHeadSha)}`,
  };
}

/** The checks the gate counts: every check, or only the Repository's `requiredChecks` when it names some. */
function countedChecks<T extends { name: string }>(
  checks: readonly T[],
  requiredChecks: readonly string[],
): T[] {
  const required = new Set(requiredChecks);
  return required.size === 0 ? [...checks] : checks.filter((c) => required.has(c.name));
}

/**
 * The checks that fail the gate's checks condition (#61): the counted checks
 * whose outcome is `failure`, in the order given. Non-empty exactly when the
 * condition fails, so `ci_failed` is raised from the same rule. Pure.
 */
export function failingChecks<T extends { name: string; outcome: CheckOutcome }>(
  checks: readonly T[],
  requiredChecks: readonly string[],
): T[] {
  return countedChecks(checks, requiredChecks).filter((c) => c.outcome === 'failure');
}

function checks(input: MergeGateInput): MergeGateCondition {
  const label = 'Checks on the head are green';
  const required = new Set(input.requiredChecks);
  const counted = countedChecks(input.checks, input.requiredChecks);
  const failed = failingChecks(input.checks, input.requiredChecks).map((c) => c.name);
  if (failed.length > 0) {
    return { id: 'checks', label, status: 'fail', reason: `failed: ${failed.join(', ')}` };
  }
  const missing = [...required].filter((name) => !input.checks.some((c) => c.name === name));
  const pending = counted.filter((c) => c.outcome === 'pending').map((c) => c.name);
  if (missing.length > 0 || pending.length > 0) {
    const parts = [
      ...(pending.length === 0 ? [] : [`pending: ${pending.join(', ')}`]),
      ...(missing.length === 0 ? [] : [`required, not reported: ${missing.join(', ')}`]),
    ];
    return { id: 'checks', label, status: 'pending', reason: parts.join('; ') };
  }
  if (counted.length === 0) {
    const endsAt = Date.parse(input.pr.headSeenAt) + input.graceMs;
    if (Date.parse(input.now) < endsAt) {
      return {
        id: 'checks',
        label,
        status: 'pending',
        reason: `no check reported on ${short(input.pr.headSha)} yet; the grace window ends at ${new Date(endsAt).toISOString()}`,
      };
    }
    return {
      id: 'checks',
      label,
      status: 'pass',
      reason: `${NO_CHECKS_REPORTED} on ${short(input.pr.headSha)} within ${String(Math.round(input.graceMs / 1000))} s of the push`,
    };
  }
  return {
    id: 'checks',
    label,
    status: 'pass',
    reason: counted.map((c) => `${c.name}: ${c.outcome}`).join(', '),
  };
}

function reviews(input: MergeGateInput): MergeGateCondition {
  const label = 'No blocking Findings or unresolved change requests';
  const problems: string[] = [];
  if (input.blockingFindings > 0) {
    problems.push(
      `${String(input.blockingFindings)} blocking Finding${input.blockingFindings === 1 ? '' : 's'} open`,
    );
  }
  if (input.changesRequestedBy.length > 0) {
    problems.push(`changes requested on GitHub by ${input.changesRequestedBy.join(', ')}`);
  }
  return problems.length === 0
    ? {
        id: 'reviews',
        label,
        status: 'pass',
        reason: 'no blocking Finding and no unresolved CHANGES_REQUESTED review',
      }
    : { id: 'reviews', label, status: 'fail', reason: problems.join('; ') };
}

/** GitHub's `mergeable_state` values that mean branch protection is satisfied and nothing conflicts. */
const MERGEABLE = new Set(['clean', 'unstable', 'has_hooks']);

function mergeable({ pr }: MergeGateInput): MergeGateCondition {
  const label = 'Branch protection satisfied, no conflicts';
  const state = pr.mergeableState;
  if (state !== null && MERGEABLE.has(state)) {
    return { id: 'mergeable', label, status: 'pass', reason: `GitHub reports ${state}` };
  }
  if (state === 'dirty') {
    return {
      id: 'mergeable',
      label,
      status: 'fail',
      reason: 'GitHub reports dirty: the PR conflicts with its base',
    };
  }
  const why: Record<string, string> = {
    blocked: 'GitHub reports blocked: branch protection is not satisfied yet',
    behind: 'GitHub reports behind: branch protection wants the head up to date with the base',
    draft: 'GitHub reports draft',
  };
  return {
    id: 'mergeable',
    label,
    status: 'pending',
    reason:
      state === null
        ? 'not read from GitHub yet'
        : (why[state] ?? `GitHub reports ${state}: mergeability is not known yet`),
  };
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * The earlier PRs in Delivery Order have merged (ADR-0052). Under
 * `human_approval` an earlier PR whose merge is approved also passes: the
 * factory merges the Job's PRs in Delivery Order, so it merges that one first.
 * Under `never_auto` only a merge counts; a human can still merge out of
 * order on GitHub, which the Delivery Report flags.
 */
function deliveryOrder(
  earlier: readonly EarlierPullRequest[],
  mergePolicy: MergePolicy,
): MergeGateCondition {
  const label = 'The earlier PR in Delivery Order has merged';
  const after = `this Repository comes after ${joinAnd(earlier.map((e) => e.repository))} in the Delivery Order`;
  const approved = (e: EarlierPullRequest) =>
    mergePolicy === 'human_approval' && e.state === 'open' && e.mergeApproved;
  const waiting = earlier.filter((e) => e.state !== 'merged' && !approved(e));
  if (waiting.length > 0) {
    const named = waiting.map((e) =>
      e.pullRequest === null
        ? `${e.repository} (no pull request opened yet)`
        : `${e.pullRequest} (${e.repository}${e.state === 'closed' ? ', closed without merging' : ''})`,
    );
    return {
      id: 'delivery_order',
      label,
      status: 'pending',
      reason: `waits for ${joinAnd(named)} to merge: ${after}`,
    };
  }
  return {
    id: 'delivery_order',
    label,
    status: 'pass',
    reason: earlier
      .map((e) =>
        e.state === 'merged'
          ? `${e.pullRequest ?? e.repository} (${e.repository}) has merged`
          : `${e.pullRequest ?? e.repository} (${e.repository}): its merge is approved, and the factory merges it first, in Delivery Order`,
      )
      .join('; '),
  };
}

function policy(input: MergeGateInput): MergeGateCondition {
  return policyCondition(input.policy, input.approval);
}

function policyCondition(
  mergePolicy: MergePolicy,
  approval: MergeApproval | null,
): MergeGateCondition {
  const label = 'The Merge Policy';
  if (mergePolicy === 'never_auto') {
    return {
      id: 'policy',
      label,
      status: 'pending',
      reason: 'never_auto: the factory never merges; a human merges the PR on GitHub',
    };
  }
  return approval === null
    ? {
        id: 'policy',
        label,
        status: 'pending',
        reason:
          'human_approval: the factory merges once a human approves the merge item in the Inbox',
      }
    : {
        id: 'policy',
        label,
        status: 'pass',
        reason: `human_approval: approved by ${approval.by} at ${approval.at}`,
      };
}

/** Every condition but the policy passes: what `merge` needs to be offered (Q15). */
export function readyButForPolicy(gate: MergeGate): boolean {
  return gate.conditions.every((c) => c.id === 'policy' || c.status === 'pass');
}

export const CheckSourceSchema = z.enum(['check_run', 'status']);
export type CheckSource = z.infer<typeof CheckSourceSchema>;

/** One check on a PR head as the poller recorded it (`pr_checks`). */
export const PrCheckSchema = z.object({
  headSha: z.string(),
  source: CheckSourceSchema,
  name: z.string(),
  /** GitHub's own status (check run) or state (commit status). */
  status: z.string(),
  conclusion: z.string().nullable(),
  outcome: CheckOutcomeSchema,
  url: z.string().nullable(),
  /** A check run's output summary (or title), a status's description: CI text, untrusted. */
  summary: z.string().nullable(),
  /**
   * The slug of the GitHub App that made a check run (`github-actions` for an
   * Actions job), or null: a commit status, or a row from before #77.
   */
  app: z.string().nullable().default(null),
  observedAt: z.string(),
});
export type PrCheck = z.infer<typeof PrCheckSchema>;

export type ObservedCheck = Omit<PrCheck, 'headSha' | 'observedAt'>;

/** A completed check run's conclusion as the gate reads it; anything else red is a failure. */
function runOutcome(status: string, conclusion: string | null): CheckOutcome {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
    return conclusion;
  }
  return 'failure';
}

function statusOutcome(state: string): CheckOutcome {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure';
}

/** A check run as GitHub lists it on a head. */
export interface ObservedCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  /** Its output summary, or title when it has no summary. */
  summary?: string | null;
  /** The slug of the GitHub App that made it (`github-actions` for an Actions job). */
  app?: string | null;
  /** The check suite it belongs to: an Actions workflow run has one of its own. */
  checkSuiteId?: number | null;
}

/** The newest run of each check name (highest id: a re-run replaces the earlier run). */
function newestRuns<T extends { id: number; name: string }>(runs: readonly T[]): T[] {
  const newest = new Map<string, T>();
  for (const run of runs) {
    const seen = newest.get(run.name);
    if (seen === undefined || run.id > seen.id) newest.set(run.name, run);
  }
  return [...newest.values()];
}

/** The app slug GitHub gives the check runs of GitHub Actions jobs. */
export const GITHUB_ACTIONS_APP = 'github-actions';

/** A GitHub Actions workflow run on a head, as `GET /actions/runs?head_sha=` lists it. */
export interface ObservedWorkflowRun {
  id: number;
  name: string;
  /** GitHub's status: `completed` once every job ended; a re-run needs that. */
  status: string;
  /** Its check suite: the check runs of its jobs carry the same id. */
  checkSuiteId: number | null;
}

/** A failed check `rerun_checks` can't re-run with the factory's token, and why. */
export type NotRerun =
  | { name: string; why: 'commit_status' }
  | { name: string; why: 'other_app'; app: string | null }
  | { name: string; why: 'no_workflow_run' }
  | { name: string; why: 'workflow_running'; workflow: string };

/** What `rerun_checks` does on one head: the workflow runs whose failed jobs it re-runs, and what it can't. */
export interface RerunPlan {
  workflowRuns: { id: number; name: string; checks: string[] }[];
  notRerun: NotRerun[];
}

/**
 * What `rerun_checks` re-runs on a head (#77, ADR-0040). GitHub lets only a
 * GitHub App write check runs, so a check run is re-run through the Actions
 * API: each counted failed check run made by GitHub Actions is matched to
 * its workflow run by check suite, and each such workflow run is re-run once
 * (`rerun-failed-jobs`). A check run made by another app, and a commit
 * status, can't be re-run with the factory's token; neither can a check
 * whose workflow run isn't listed or is still running. Those are named.
 * `runs` and `workflowRuns` are read afresh; `failedStatuses` are the
 * counted failed commit statuses. Pure.
 */
export function rerunPlan(input: {
  runs: readonly ObservedCheckRun[];
  failedStatuses: readonly string[];
  workflowRuns: readonly ObservedWorkflowRun[];
  requiredChecks: readonly string[];
}): RerunPlan {
  const failed = failingChecks(
    newestRuns(input.runs).map((r) => ({ ...r, outcome: runOutcome(r.status, r.conclusion) })),
    input.requiredChecks,
  ).sort((a, b) => a.name.localeCompare(b.name));
  const bySuite = new Map(
    input.workflowRuns.flatMap((w) => (w.checkSuiteId === null ? [] : [[w.checkSuiteId, w]])),
  );
  const chosen = new Map<number, { id: number; name: string; checks: string[] }>();
  const notRerun: NotRerun[] = [];
  for (const run of failed) {
    const refused = notRerunnable({ name: run.name, source: 'check_run', app: run.app ?? null });
    if (refused !== null) {
      notRerun.push(refused);
      continue;
    }
    const workflow = run.checkSuiteId == null ? undefined : bySuite.get(run.checkSuiteId);
    if (workflow === undefined) {
      notRerun.push({ name: run.name, why: 'no_workflow_run' });
    } else if (workflow.status !== 'completed') {
      notRerun.push({ name: run.name, why: 'workflow_running', workflow: workflow.name });
    } else {
      const entry = chosen.get(workflow.id) ?? { id: workflow.id, name: workflow.name, checks: [] };
      entry.checks.push(run.name);
      chosen.set(workflow.id, entry);
    }
  }
  for (const name of input.failedStatuses) {
    const refused = notRerunnable({ name, source: 'status', app: null });
    if (refused !== null) notRerun.push(refused);
  }
  return { workflowRuns: [...chosen.values()].sort((a, b) => a.id - b.id), notRerun };
}

/** Why `rerun_checks` can't re-run a check, in words. */
export function describeNotRerun(n: NotRerun): string {
  switch (n.why) {
    case 'commit_status':
      return 'a commit status';
    case 'other_app':
      return n.app === null
        ? 'a check run made by an unknown app'
        : `a check run made by the app ${n.app}`;
    case 'no_workflow_run':
      return 'no GitHub Actions workflow run is listed for it on this head';
    case 'workflow_running':
      return `its workflow run ${n.workflow} is still running`;
  }
}

/**
 * Why `rerun_checks` can never re-run a check, from what is known of it
 * without reading GitHub: a commit status, or a check run another app made.
 * Null for an Actions check run (its workflow run decides the rest). Pure.
 */
function notRerunnable(check: {
  name: string;
  source: CheckSource;
  app: string | null;
}): NotRerun | null {
  if (check.source === 'status') return { name: check.name, why: 'commit_status' };
  if (check.app !== GITHUB_ACTIONS_APP)
    return { name: check.name, why: 'other_app', app: check.app };
  return null;
}

/**
 * What a `ci_failed` Blocker says about `rerun_checks`, from the recorded
 * checks: which it can re-run (an Actions check run, once its workflow run
 * has finished) and which it can't (a check run of another app, a commit
 * status). Pure.
 */
export function describeRerunnability(
  checks: readonly { name: string; source: CheckSource; app: string | null }[],
): string {
  const can = checks.filter((c) => notRerunnable(c) === null);
  const cannot = checks.flatMap((c) => notRerunnable(c) ?? []);
  const parts: string[] = [];
  if (can.length > 0) {
    parts.push(
      `rerun_checks can re-run ${can.map((c) => `${c.name} (GitHub Actions)`).join(', ')}, once ${can.length === 1 ? 'its workflow run has' : 'their workflow runs have'} finished`,
    );
  }
  if (cannot.length > 0) {
    const list = cannot.map((n) => `${n.name} (${describeNotRerun(n)})`).join(', ');
    parts.push(can.length > 0 ? `it can't re-run ${list}` : `rerun_checks can't re-run ${list}`);
  }
  return parts.join('; ');
}

/**
 * The checks GitHub reports on a head, as the gate counts them: the newest
 * check run of each name (highest id: a re-run replaces the earlier run) and
 * the newest commit status of each context (GitHub lists them newest first).
 * Sorted by source, then name, so equal observations compare equal.
 */
export function observedChecks(
  runs: readonly ObservedCheckRun[],
  statuses: readonly {
    context: string;
    state: string;
    targetUrl: string | null;
    description?: string | null;
  }[],
): ObservedCheck[] {
  const newestStatus = new Map<string, (typeof statuses)[number]>();
  for (const st of statuses) if (!newestStatus.has(st.context)) newestStatus.set(st.context, st);
  const out: ObservedCheck[] = [
    ...newestRuns(runs).map((r) => ({
      source: 'check_run' as const,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      outcome: runOutcome(r.status, r.conclusion),
      url: r.detailsUrl,
      summary: r.summary ?? null,
      app: r.app ?? null,
    })),
    ...[...newestStatus.values()].map((st) => ({
      source: 'status' as const,
      name: st.context,
      status: st.state,
      conclusion: null,
      outcome: statusOutcome(st.state),
      url: st.targetUrl,
      summary: st.description ?? null,
      app: null,
    })),
  ];
  return out.sort((a, b) =>
    a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source),
  );
}

/**
 * The GitHub users whose latest review is `CHANGES_REQUESTED`: an
 * unresolved change request. A later `APPROVED` or `DISMISSED` review by the
 * same user resolves it; `COMMENTED` does not change it.
 */
export function unresolvedChangeRequests(
  reviews: readonly { id: number; state: string; author: string | null }[],
): string[] {
  const latest = new Map<string, string>();
  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    if (r.author === null || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(r.author, r.state);
  }
  return [...latest.entries()]
    .filter(([, state]) => state === 'CHANGES_REQUESTED')
    .map(([author]) => author)
    .sort();
}

const CANCEL_JOB_OPTION: ApprovalOption = {
  id: 'cancel_job',
  label: 'Cancel the Job',
  description:
    'Cancel the whole Job, as factory job cancel does: polling stops, Worktrees are preserved, branches kept. The PR stays open on GitHub.',
  agentProposed: false,
};

/** The option that lets the factory merge (`human_approval` only); approving it is audited. */
export const MERGE_OPTION: ApprovalOption = {
  id: 'merge',
  label: 'Merge',
  description:
    "Approve the merge: the factory re-reads the PR and merges it with the Repository's merge method, at the head and base this item names. Your approval is written to the audit log.",
  agentProposed: false,
};

/**
 * `request_changes` (#60, ADR-0039): the comment (required) is the change
 * request; a Rework on the Integration Branch follows and the PR is updated in place.
 */
export const REQUEST_CHANGES_OPTION: ApprovalOption = {
  id: 'request_changes',
  label: 'Request changes',
  description:
    "Send the pull request back for Rework with your comment as the change request: a developer Attempt on the Integration Branch (counts against the Integration Task's maxAttempts), then the Integration Review again, and the same PR updated in place.",
  agentProposed: false,
};

/**
 * The options of a `merge` item under `never_auto` (Q15): the merge is the
 * human's, on GitHub, and the poller closes the item when it sees it.
 */
export const NEVER_AUTO_MERGE_OPTIONS: readonly ApprovalOption[] = [
  REQUEST_CHANGES_OPTION,
  CANCEL_JOB_OPTION,
];

/**
 * A `merge` item's options for `gate` (Q15): under `human_approval`, `merge`
 * only while every other condition passes; `request_changes` and
 * `cancel_job` always. `null` is a gate not evaluated yet. Pure.
 */
export function mergeItemOptions(
  policy: MergePolicy,
  gate: MergeGate | null,
): readonly ApprovalOption[] {
  if (policy === 'human_approval' && gate !== null && readyButForPolicy(gate)) {
    return [MERGE_OPTION, REQUEST_CHANGES_OPTION, CANCEL_JOB_OPTION];
  }
  return NEVER_AUTO_MERGE_OPTIONS;
}

/** What a `merge` item decides on: one PR at one `(head_sha, base_sha)`; any SHA change supersedes it. */
export function mergeItemSubject(pullRequestId: string, headSha: string, baseSha: string): string {
  return `${pullRequestId}@${headSha}..${baseSha}`;
}

/** The decision the poller records on a `merge` item when it sees the PR merged on GitHub. */
export const MERGED_ON_GITHUB = 'merged_on_github';
