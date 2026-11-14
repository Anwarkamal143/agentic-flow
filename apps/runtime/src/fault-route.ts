/**
 * Where a failed review goes when its blocking Findings blame the Plan or the
 * Specification (ARCHITECTURE §4.6): the `plan` route replans (ADR-0030), the
 * `spec` route re-specifies (ADR-0031). Runs inside the transaction that ends
 * the raising Attempt.
 */
import type { schema, Tx } from '@factory/db';
import type { AttemptFinding } from '@factory/domain';
import type { ArtifactStore } from './artifacts.js';
import type { StageRunStepper } from './engine.js';
import { routeToPlanning } from './plan-route.js';
import { routeToSpecification } from './spec-route.js';

/** The Task whose review blamed the Plan or the Specification, and that review's Attempt. */
export interface FaultRouteInput {
  task: typeof schema.tasks.$inferSelect;
  attemptId: string;
  attemptN: number;
  headSha: string | null;
  findings: readonly AttemptFinding[];
}

/** Routes the failed Attempt to planning (`replan`) or to specification (`respecify`). */
export function routeByFaultOrigin(
  tx: Tx,
  artifacts: Pick<ArtifactStore, 'writeContent' | 'record'>,
  op: { jobId: string; actor: string },
  route: 'replan' | 'respecify',
  input: FaultRouteInput,
  step: StageRunStepper,
): void {
  if (route === 'replan') routeToPlanning(tx, artifacts, op, input, step);
  else routeToSpecification(tx, artifacts, op, input, step);
}
