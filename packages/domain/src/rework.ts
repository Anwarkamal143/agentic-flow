/**
 * The path-scope Gate, Blockers, and the Rework routing that decides what
 * happens after a failed Attempt (ARCHITECTURE §4.3, §4.6, §7). No I/O.
 */
import picomatch from 'picomatch';
import { z } from 'zod';
import type { AttemptExitReason } from './execution.js';
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
 * no answer Attempt left (`max_questions`).
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
]);
export type BlockerReason = z.infer<typeof BlockerReasonSchema>;

/** Why work cannot proceed, and what would clear it. Stored on the Task and on its Stage Run. */
export const BlockerSchema = z.object({
  kind: BlockerKindSchema,
  reason: BlockerReasonSchema,
  detail: z.string(),
  requiredAction: z.string(),
  taskId: z.string(),
  /** The Attempt whose end raised it. */
  attemptId: z.string(),
  createdAt: z.string(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

export type ReworkRoute =
  | { kind: 'rework' }
  | { kind: 'fail' }
  | { kind: 'blocked'; blocker: Pick<Blocker, 'kind' | 'reason' | 'detail' | 'requiredAction'> };

/** Exit reasons that are a verdict on the work, and so route to Rework. */
const REWORKABLE: readonly AttemptExitReason[] = ['gates_failed', 'changes_requested'];

/**
 * Where a failed Attempt goes next. Only a verdict on the work (a failed Gate,
 * a review that requested changes) routes anywhere; anything else fails the
 * Task. A blocking Finding whose Fault Origin is the Specification, the Plan
 * or the infrastructure (in that precedence) stops for that; otherwise a new
 * Attempt follows, unless this one was the last allowed (`n >= maxAttempts`).
 * Pure.
 */
export function routeFailedAttempt(input: {
  exitReason: AttemptExitReason;
  findings: readonly { faultOrigin: FaultOrigin; blocking: boolean }[];
  /** The Attempts counted so far, this one included (`attemptsCountedForRework`: Retries don't count). */
  n: number;
  maxAttempts: number;
}): ReworkRoute {
  if (!REWORKABLE.includes(input.exitReason)) return { kind: 'fail' };
  // Only blocking Findings route; a non-blocking one is advice (ARCHITECTURE §4.6).
  // Phase B extension point (B4): the spec and plan routes below stop for a human
  // today; Phase B sends them back to the specification or planning Stage instead.
  const origins = new Set(input.findings.filter((f) => f.blocking).map((f) => f.faultOrigin));
  if (origins.has('spec')) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'human',
        reason: 'fault_origin_spec',
        detail: 'a blocking Finding says the Specification is wrong',
        requiredAction:
          'decide on the Specification change (re-specification is not built before Phase B)',
      },
    };
  }
  if (origins.has('plan')) {
    return {
      kind: 'blocked',
      blocker: {
        kind: 'human',
        reason: 'fault_origin_plan',
        detail: 'a blocking Finding says the Plan is wrong',
        requiredAction: 'decide on a replan (replanning is not built before Phase B)',
      },
    };
  }
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
