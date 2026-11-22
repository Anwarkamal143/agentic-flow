/**
 * The Integration Task (ARCHITECTURE §14, GLOSSARY, ADR-0034): the Task the
 * factory, not the planner, creates for each (Job, Repository) once every
 * Plan Task is approved. Its first Attempt (cause `merge`) merges the approved
 * Task Branches `--no-ff`, in the order below, into the Integration Branch
 * from the freshly fetched default branch, then re-runs verification there.
 * No I/O: this decides the order and the definition; git does the merging.
 */
import { z } from 'zod';
import type { Risk, VerificationCommand } from './proposals.js';
import { RiskSchema } from './proposals.js';
import type { TaskDefinition } from './index.js';

/**
 * `plan`: from the Plan (the planner's or a human's edit). `integration`:
 * the factory's own Integration Task; never part of a Plan, never carried
 * over, replanned or edited.
 */
export const TaskKindSchema = z.enum(['plan', 'integration']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** The Integration Task's key. Unique per (Plan, Repository); a Plan Task may share it (its kind differs). */
export const INTEGRATION_TASK_KEY = 'integration';

/**
 * The Integration Branch of a Job (ARCHITECTURE §14; `factory/<job-id>` would
 * clash with its Task Branches). `n` > 1 names the branch a new PR is opened
 * on after a human chose `new_pr` on an `integration_rewrite` Blocker (#65):
 * `factory/<job-id>/integration-2`, and so on.
 */
export function integrationBranch(jobId: string, n = 1): string {
  return n <= 1 ? `factory/${jobId}/integration` : `factory/${jobId}/integration-${String(n)}`;
}

/** A Stage a Task's Attempts run in. */
export type TaskStageId = 'execution' | 'integration' | 'integration_review';

/**
 * The Stage a Task's Attempts run in: `execution` for Plan Tasks; for the
 * Integration Task, `integration` until its Integration Review has started
 * (the Job's newest `integration_review` Stage Run has left `pending`), then
 * `integration_review`, where its Integration Review Rework stays (ADR-0035).
 */
export function stageOfTask(kind: TaskKind, integrationReviewStarted: boolean): TaskStageId {
  if (kind !== 'integration') return 'execution';
  return integrationReviewStarted ? 'integration_review' : 'integration';
}

/** Whether the Integration Review runs, or is skipped with the reason recorded. */
export type IntegrationReviewSkip = { skip: true; reason: string } | { skip: false };

/**
 * The Integration Review skip rule (Phase C grilling Q18, ARCHITECTURE §9):
 * skipped when the Job has exactly one Plan Task and the Integration Branch's
 * tree equals that Task's reviewed head tree, so integration changed nothing
 * the Task review did not see. `reviewedTree` is `null` when the Task has no
 * approving review to compare with. Pure.
 */
export function integrationReviewSkip(input: {
  planTasks: number;
  integrationTree: string;
  reviewedTree: string | null;
}): IntegrationReviewSkip {
  if (input.planTasks !== 1 || input.reviewedTree !== input.integrationTree) {
    return { skip: false };
  }
  return {
    skip: true,
    reason: `the Job has one Plan Task and the Integration Branch has the same tree (${input.integrationTree}) as that Task's reviewed head: integration changed nothing its review did not see`,
  };
}

/**
 * The order the approved Task Branches merge into the Integration Branch: a
 * Task after every Task it depends on, ties broken by Task key (the smallest
 * ready key first at each step). Dependencies on Tasks outside the set (another
 * Repository's) are ignored. Throws on a cycle (a validated Plan has none). Pure.
 */
export function integrationOrder(
  tasks: readonly { key: string; dependsOn: readonly string[] }[],
): string[] {
  const keys = new Set(tasks.map((t) => t.key));
  const pending = new Map(
    tasks.map((t) => [t.key, new Set(t.dependsOn.filter((d) => keys.has(d) && d !== t.key))]),
  );
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([key]) => key)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const [next] = ready;
    if (next === undefined) {
      throw new Error(`the Tasks have a dependency cycle among ${[...pending.keys()].join(', ')}`);
    }
    order.push(next);
    pending.delete(next);
    for (const deps of pending.values()) deps.delete(next);
  }
  return order;
}

/**
 * The Integration Task's definition, from its Repository's Plan Tasks in Plan
 * order (Phase C grilling Q24): writable paths are the union of their writable
 * globs (forbidden globs are not carried: one Task's forbidden path may be
 * another's to write); covered criteria the union of theirs; verification every
 * command they listed, a command (with the same arguments) shared by several
 * run once (required if any required it, verifying every criterion any named),
 * keys kept unique; the
 * highest risk. It depends on nothing in the Plan. Pure.
 */
export function integrationDefinition(
  planTasks: readonly { key: string; definition: TaskDefinition }[],
): TaskDefinition {
  if (planTasks.length === 0) {
    throw new Error('an Integration Task integrates at least one Plan Task');
  }
  const unique = <T>(values: readonly T[]) => [...new Set(values)];
  const verification: VerificationCommand[] = [];
  for (const { definition } of planTasks) {
    for (const v of definition.verification) {
      const same = verification.find(
        (o) => o.command === v.command && (o.args ?? []).join('\0') === (v.args ?? []).join('\0'),
      );
      if (same !== undefined) {
        same.required ||= v.required;
        same.criteria = unique([...same.criteria, ...v.criteria]);
        continue;
      }
      verification.push({
        key: uniqueKey(
          v.key,
          verification.map((o) => o.key),
        ),
        command: v.command,
        ...(v.args === undefined ? {} : { args: [...v.args] }),
        required: v.required,
        criteria: unique(v.criteria),
      });
    }
  }
  const risks = RiskSchema.options;
  const risk: Risk =
    risks[Math.max(...planTasks.map((t) => risks.indexOf(t.definition.risk)))] ?? 'low';
  return {
    objective: `Combine the approved Task Branches of ${planTasks.map((t) => t.key).join(', ')} into the Integration Branch and verify the combined change.`,
    role: 'developer',
    risk,
    scope: {
      writable: unique(planTasks.flatMap((t) => t.definition.scope.writable)),
      forbidden: [],
      readHints: [],
    },
    dependsOn: [],
    acceptance: unique(planTasks.flatMap((t) => t.definition.acceptance)),
    verification,
  };
}

/** `key`, or `key-2`, `key-3`, … when taken; a slug of at most 40 characters. */
function uniqueKey(key: string, taken: readonly string[]): string {
  if (!taken.includes(key)) return key;
  for (let n = 2; ; n++) {
    const suffix = `-${String(n)}`;
    const candidate = `${key.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
