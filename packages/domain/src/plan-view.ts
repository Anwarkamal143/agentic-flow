/**
 * The plan approval view (PRODUCT_SPEC §7): what code derives from a Plan, its
 * Workflow Snapshot and the policy. The planner never writes these. No I/O.
 */
import { z } from 'zod';
import { ApprovalSchema } from './approvals.js';
import type { Billing } from './billing.js';
import type { PlanApprovalPolicy, StageId, WorkflowSnapshot } from './index.js';
import { RiskSchema } from './proposals.js';

export const DecisionPointSchema = z.object({
  stageId: z.string(),
  kind: z.enum(['plan', 'blocker']),
  /** When it happens and what the human decides. */
  description: z.string(),
});
export type DecisionPoint = z.infer<typeof DecisionPointSchema>;

/**
 * Where this Job will (or may) stop for a human, from the Stages in its
 * Workflow Snapshot and the policy. Only decision points the factory has built
 * are listed. Pure.
 */
export function humanDecisionPoints(
  snapshot: WorkflowSnapshot,
  policy: { planApproval: PlanApprovalPolicy },
): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const has = (id: StageId) => snapshot.stages.some((s) => s.id === id);
  if (has('plan_approval') && policy.planApproval === 'required') {
    points.push({
      stageId: 'plan_approval',
      kind: 'plan',
      description: 'Before any Task runs: approve or reject this Plan (planApproval: required).',
    });
  }
  if (has('execution')) {
    points.push(
      {
        stageId: 'execution',
        kind: 'blocker',
        description:
          'If a Task reaches its Rework cap (max attempts) or its Retry cap (max retries), or recovery after a crash is uncertain, it stops for a human.',
      },
      {
        stageId: 'execution',
        kind: 'blocker',
        description:
          'If a blocking Finding puts the fault in the Plan, the Specification or the infrastructure, the Task stops for a human.',
      },
    );
  }
  return points;
}

/**
 * Groups Tasks into waves by their longest dependency path: a wave's Tasks can
 * start together once the waves before it are done, and no Task depends on
 * another of its wave. Keys keep their Plan order within a wave. Pure; the
 * Plan validator has already refused cycles and unknown keys.
 */
export function parallelWaves(
  tasks: readonly { key: string; dependsOn: readonly string[] }[],
): string[][] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const level = new Map<string, number>();
  const levelOf = (key: string, seen: ReadonlySet<string>): number => {
    const known = level.get(key);
    if (known !== undefined) return known;
    if (seen.has(key)) throw new Error(`the Plan has a dependency cycle at ${key}`);
    const deps = byKey.get(key)?.dependsOn ?? [];
    const next = new Set(seen).add(key);
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => levelOf(d, next)));
    level.set(key, value);
    return value;
  };
  const waves: string[][] = [];
  for (const t of tasks) {
    const n = levelOf(t.key, new Set());
    (waves[n] ??= []).push(t.key);
  }
  return waves.filter((w) => w.length > 0);
}

export const ESTIMATE_LABEL = 'bounds, not a forecast';

export const PlanEstimateSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  attempts: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    label: z.literal(ESTIMATE_LABEL),
  }),
  cost: z.object({ value: z.literal('unknown'), reason: z.string() }),
});
export type PlanEstimate = z.infer<typeof PlanEstimateSchema>;

/**
 * The estimate: the Task count, and Attempts from one per Task to the sum of
 * every Attempt-creating cap (max attempts + max retries + max questions per
 * Task). Cost is unknown, with the reason. Pure.
 */
export function planEstimate(
  tasks: readonly { maxAttempts: number; maxRetries: number }[],
  /** `billing` is `null` for a Harness without one (the Fake Harness). */
  policy: { maxQuestions: number; billing: Billing | null },
): PlanEstimate {
  const max = tasks.reduce((sum, t) => sum + t.maxAttempts + t.maxRetries + policy.maxQuestions, 0);
  return {
    taskCount: tasks.length,
    attempts: { min: tasks.length, max, label: ESTIMATE_LABEL },
    cost: { value: 'unknown', reason: COST_UNKNOWN[policy.billing ?? 'none'] },
  };
}

const COST_UNKNOWN: Readonly<Record<Billing | 'none', string>> = {
  subscription: 'Claude Code runs on a subscription, which reports no per-Run cost',
  api_key: 'billed to an API key, but the token use of Attempts that have not run is not known',
  none: 'the configured Harness reports no cost',
};

/** `GET /v1/jobs/:id/plan`: everything `factory plan show` prints. */
export const PlanViewSchema = z.object({
  job: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    version: z.number().int(),
  }),
  planArtifactId: z.string(),
  /** The Specification Artifact's content (agent output, validated when stored). */
  specification: z.unknown(),
  specificationArtifactId: z.string().nullable(),
  triageRisk: RiskSchema.nullable(),
  repositories: z.array(z.object({ id: z.string(), name: z.string() })),
  tasks: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      title: z.string(),
      objective: z.string(),
      repositoryId: z.string(),
      state: z.string(),
      risk: RiskSchema,
      dependsOn: z.array(z.string()),
      acceptance: z.array(z.string()),
      writable: z.array(z.string()),
      maxAttempts: z.number().int(),
      maxRetries: z.number().int(),
    }),
  ),
  /** Tasks that can start together, wave by wave. */
  parallel: z.array(z.array(z.string())),
  decisionPoints: z.array(DecisionPointSchema),
  estimate: PlanEstimateSchema,
  /** The plan Inbox Item for this Plan, when there is one. */
  approval: ApprovalSchema.nullable(),
});
export type PlanView = z.infer<typeof PlanViewSchema>;
