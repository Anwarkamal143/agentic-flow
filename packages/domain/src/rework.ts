/**
 * The path-scope Gate, Blockers, and the Rework routing that decides what
 * happens after a failed Attempt (ARCHITECTURE §4.3, §4.6, §7). No I/O.
 */
import picomatch from 'picomatch';
import { z } from 'zod';
import type { AttemptCause, AttemptExitReason } from './execution.js';
import type { FaultOrigin } from './findings.js';

// ---- The path-scope Gate (ARCHITECTURE §7 step 3) -------------------------------

/**
 * One path the diff `base..head` touches. A rename is two changes (git
 * `--no-renames`): the old path `deleted`, the new one `added`.
 */
export interface PathChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'type_changed';
}

export interface PathScopeViolation {
  rule: 'scope.forbidden' | 'scope.outside_writable';
  /** The offending paths, sorted, each once. */
  paths: string[];
  message: string;
}

/**
 * Checks every changed path against the Task's scope: it must match a
 * `writable` glob and no `forbidden` glob. A path that is both is reported as
 * forbidden only. Globs match the whole path, case-sensitively, and match
 * dotfiles like any other path. Pure.
 */
export function checkPathScope(
  changes: readonly PathChange[],
  scope: { writable: readonly string[]; forbidden: readonly string[] },
): PathScopeViolation[] {
  const matcher = (glob: string) => ({ glob, test: picomatch(glob, { dot: true }) });
  const writable = scope.writable.map(matcher);
  const forbidden = scope.forbidden.map(matcher);
  const byPath = new Map<string, PathChange['kind'][]>();
  for (const c of changes) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c.kind]);
  const paths = [...byPath.keys()].sort();
  const describe = (path: string) => [...new Set(byPath.get(path))].join(', ');

  const violations: PathScopeViolation[] = [];
  const forbiddenHits = paths
    .map((path) => ({ path, glob: forbidden.find((m) => m.test(path))?.glob }))
    .filter((h): h is { path: string; glob: string } => h.glob !== undefined);
  if (forbiddenHits.length > 0) {
    violations.push({
      rule: 'scope.forbidden',
      paths: forbiddenHits.map((h) => h.path),
      message: `the diff touches forbidden paths: ${forbiddenHits
        .map((h) => `${h.path} (${describe(h.path)}, matches forbidden ${h.glob})`)
        .join(', ')}`,
    });
  }
  const outside = paths.filter(
    (path) => !forbiddenHits.some((h) => h.path === path) && !writable.some((m) => m.test(path)),
  );
  if (outside.length > 0) {
    violations.push({
      rule: 'scope.outside_writable',
      paths: outside,
      message: `the diff touches paths outside the writable scope (${scope.writable.join(', ')}): ${outside
        .map((p) => `${p} (${describe(p)})`)
        .join(', ')}`,
    });
  }
  return violations;
}

// ---- Blockers and Rework routing (ARCHITECTURE §4.3, §4.6) ------------------------

export const BlockerKindSchema = z.enum(['human', 'infrastructure', 'recovery', 'policy']);
export type BlockerKind = z.infer<typeof BlockerKindSchema>;

/**
 * `rework_cap_reached`: the Task's last allowed Attempt failed a Gate or its
 * review. `fault_origin_plan` / `fault_origin_spec` / `fault_origin_infrastructure`:
 * a blocking Finding puts the cause outside the implementation.
 * `recovery_uncertain`: after a crash the factory can't safely go on (the
 * interrupted Attempt left uncommitted changes, or its Worktree's state is
 * unknown). `retry_cap_reached`: an interrupted Attempt has no Retry left.
 * `awaiting_human`: the developer asked a Question; the Task waits for the
 * answer in the Inbox (ADR-0023). `question_cap_reached`: it asked again with
 * no answer Attempt left (`max_questions`). `replan_cap_reached`: a Replan was
 * asked for with none left (`max_replans`, ADR-0029); a Job-level Blocker
 * whose Approval holds the request. `base_merge_conflict`: merging its
 * dependencies' approved heads into its Dependency Base conflicts, so it
 * can't start (ADR-0028); never an automatic replan.
 * `spec_finding_unresolved`: a blocking Finding blames the Specification and
 * no Specification change resolves it (the operator rejected the change, or
 * none could start); its Approval offers Rework with guidance, a Replan under
 * the current Specification, or cancelling the Job (#47).
 */
export const BlockerReasonSchema = z.enum([
  'awaiting_human',
  'question_cap_reached',
  'rework_cap_reached',
  'fault_origin_plan',
  'fault_origin_spec',
  'fault_origin_infrastructure',
  'recovery_uncertain',
  'retry_cap_reached',
  'replan_cap_reached',
  'base_merge_conflict',
  'spec_finding_unresolved',
  /**
   * The Repository's setup command failed in the Worktree, or left it changed
   * (ADR-0047). Not a verdict on the work: a human retries or cancels.
   */
  'setup_failed',
  /** `merge_approval` waits for a human to merge the PR on GitHub (`never_auto`, #58). */
  'awaiting_merge',
  /** GitHub refused the Repository's merge method (`human_approval`, #59); held by the `merge` Stage. */
  'merge_method_refused',
  /** A required check failed on the PR head (#61); held by `merge_approval`, cleared when it no longer fails. */
  'ci_failed',
  /**
   * A foreign push to the Integration Branch touches paths outside the union
   * of the Plan Tasks' writable globs (#63, ADR-0042): the factory never
   * overwrites someone else's commits, so a human decides.
   */
  'foreign_push_out_of_scope',
  /**
   * A foreign push rewrote the Integration Branch: its head no longer holds
   * the approved head, so adopting it drops approved commits (ADR-0042). A
   * rewrite of a published Integration Branch needs a human's Approval.
   */
  'foreign_push_rewrite',
  /**
   * The PR was closed on GitHub without merging (#64, Q16): `merge_approval`
   * waits for a human to reopen it or cancel the Job; nothing cancels on its
   * own. Cleared when polling sees the PR open again.
   */
  'pr_closed',
  /**
   * A Replan or a re-specification rebuilt the Integration Branch while its
   * PR is open (#65, Q25): the rebuilt branch doesn't descend from the head
   * the factory pushed, so publishing it rewrites the PR's branch. Held by
   * `pull_request`; a human decides (force-push with lease, a new PR, or
   * cancel). The factory never force-pushes on its own judgment.
   */
  'integration_rewrite',
  /**
   * The factory can't deliver to the Task's Repository (#108, ADR-0052,
   * ADR-0068): before its first Attempt, the Factory Clone is not writable or
   * the GitHub token has no push permission; or GitHub refused the push of the
   * Integration Branch for lack of permission. The detail names the exact
   * reason. Dependent Tasks wait; other Repositories go on. A human fixes the
   * permission and checks again, or cancels.
   */
  'repository_not_writable',
]);

/**
 * Whether the factory adopts a foreign head on the Integration Branch now, or
 * waits for a human's Approval (`foreign_push_rewrite`, ADR-0042): a head that
 * holds the approved head (a fast-forward), or one that holds a rewrite a human
 * already approved, is adopted; any other rewrite is not. Pure.
 */
export function foreignPushAdoption(input: {
  /** The fetched head holds the approved head. */
  fastForward: boolean;
  /** The fetched head holds the rewrite a human approved (`adopt_rewrite`); `false` when none was. */
  holdsApprovedRewrite: boolean;
}): 'adopt' | 'needs_approval' {
  return input.fastForward || input.holdsApprovedRewrite ? 'adopt' : 'needs_approval';
}
export type BlockerReason = z.infer<typeof BlockerReasonSchema>;

/** Why work cannot proceed, and what would clear it. Stored on the Task and on its Stage Run. */
export const BlockerSchema = z.object({
  kind: BlockerKindSchema,
  reason: BlockerReasonSchema,
  detail: z.string(),
  requiredAction: z.string(),
  taskId: z.string(),
  /**
   * The Attempt whose end raised it: the subject of its Blocker Approval. A
   * `base_merge_conflict` arises before its Task has any Attempt, so it holds
   * the Task's id instead (ADR-0028).
   */
  attemptId: z.string(),
  createdAt: z.string(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

export type ReworkRoute =
  | { kind: 'rework' }
  | { kind: 'fail' }
  /** A blocking Finding blames the Plan: back to `planning` (ARCHITECTURE §4.6, B4). */
  | { kind: 'replan' }
  /** A blocking Finding blames the Specification: `specification` re-runs (§4.6, #47). */
  | { kind: 'respecify' }
  | { kind: 'blocked'; blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'> };

/** Exit reasons that are a verdict on the work, and so route to Rework. */
const REWORKABLE: readonly AttemptExitReason[] = ['gates_failed', 'changes_requested'];

/**
 * Where a failed Attempt goes next. Only a verdict on the work (a failed Gate,
 * a review that requested changes) routes anywhere; anything else fails the
 * Task. A blocking Finding whose Fault Origin is the Specification, the Plan
 * or the infrastructure (in that precedence) routes there: the Specification
 * is re-specified (`respecify`, #47) and the Plan goes back to planning
 * (`replan`), both counted against `max_replans`, not `max_attempts`; the
 * infrastructure blocks; otherwise a new Attempt follows, unless this one was the last
 * allowed (`n >= maxAttempts`). A foreign push that fails the path-scope Gate
 * blocks first (`foreign_push_out_of_scope`, ADR-0042). Pure.
 */
export function routeFailedAttempt(input: {
  exitReason: AttemptExitReason;
  /** `rule`: the Gate rule a factory Finding names (`scope.*` for the path-scope Gate). */
  findings: readonly { faultOrigin: FaultOrigin; blocking: boolean; rule?: string | null }[];
  /** The Attempts counted so far, this one included (`attemptsCountedForRework`: Retries don't count). */
  n: number;
  maxAttempts: number;
  /** Why the failed Attempt exists; a `foreign_push` out of scope waits for a human (ADR-0042). */
  cause?: AttemptCause;
}): ReworkRoute {
  // The install, not the work, failed: no agent Rework, a human decides (ADR-0047).
  if (input.exitReason === 'setup_failed') {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'human',
        reason: 'setup_failed',
        detail: "the Repository's setup command failed in the Worktree, or left it changed",
        requiredAction:
          'look at the setup log on the Attempt, fix the cause (the network, the registry, the lockfile), then decide the Blocker Approval in the Inbox: retry (the setup runs again first) or cancel the Job',
      },
    };
  }
  if (!REWORKABLE.includes(input.exitReason)) return { kind: 'fail' };
  if (
    input.cause === 'foreign_push' &&
    input.findings.some((f) => f.rule?.startsWith('scope.') === true)
  ) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'human',
        reason: 'foreign_push_out_of_scope',
        detail:
          "commits someone else pushed to the Integration Branch touch paths outside the union of the Plan Tasks' writable globs; the factory never overwrites them",
        requiredAction:
          'decide the Blocker Approval in the Inbox: a Rework on top of the foreign commits (with your guidance) or cancel the Job',
      },
    };
  }
  // Only blocking Findings route; a non-blocking one is advice (ARCHITECTURE §4.6).
  const origins = new Set(input.findings.filter((f) => f.blocking).map((f) => f.faultOrigin));
  if (origins.has('spec')) return { kind: 'respecify' };
  if (origins.has('plan')) return { kind: 'replan' };
  if (origins.has('infrastructure')) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'infrastructure',
        reason: 'fault_origin_infrastructure',
        detail: 'a blocking Finding says the setup, tooling or machine broke',
        requiredAction: 'fix the infrastructure the Finding names',
      },
    };
  }
  if (input.n >= input.maxAttempts) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'human',
        reason: 'rework_cap_reached',
        detail: `Attempt ${String(input.n)} of at most ${String(input.maxAttempts)} failed, so no further Rework starts`,
        requiredAction:
          'look at the Attempts, then decide the Blocker Approval in the Inbox: grant more Attempts (with guidance) or cancel the Job',
      },
    };
  }
  return { kind: 'rework' };
}
