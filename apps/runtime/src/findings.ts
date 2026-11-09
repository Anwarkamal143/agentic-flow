/**
 * The Findings recorded against an Attempt: those of the factory's own Gates
 * (stored on the Attempt) and those of its reviews (in `review_findings`). A
 * Rework Attempt's Task Packet carries the Findings of the Attempt before it.
 */
import { schema, type FactoryDb, type Tx } from '@factory/db';
import {
  AttemptFindingSchema,
  FaultOriginSchema,
  FindingSeveritySchema,
  type AttemptFinding,
  type PathScopeViolation,
} from '@factory/domain';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from './ids.js';

type AttemptRow = typeof schema.attempts.$inferSelect;

/** Every Finding raised against the Attempt: its Gates' first, then its reviews', in order. */
export function attemptFindings(db: FactoryDb | Tx, attempt: AttemptRow): AttemptFinding[] {
  const gate = z.array(AttemptFindingSchema).parse(JSON.parse(attempt.gateFindingsJson));
  const review = db
    .select({ f: schema.reviewFindings })
    .from(schema.reviewFindings)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.reviewFindings.reviewId))
    .where(eq(schema.reviews.attemptId, attempt.id))
    .orderBy(asc(schema.reviews.createdAt), asc(schema.reviewFindings.position))
    .all()
    .map(({ f }) => ({
      id: f.id,
      attemptId: attempt.id,
      attemptN: attempt.n,
      source: 'review' as const,
      rule: null,
      reviewId: f.reviewId,
      severity: FindingSeveritySchema.parse(f.severity),
      faultOrigin: FaultOriginSchema.parse(f.faultOrigin),
      location: f.location,
      problem: f.problem,
      why: f.why,
      recommendation: f.recommendation,
      blocking: f.blocking,
      paths: [],
    }));
  return [...gate, ...review];
}

/**
 * A failed Gate as a Finding. It always blocks, and its Fault Origin is the
 * implementation: the Gates judge the work, so Rework is where it is fixed.
 */
export function gateFinding(
  attempt: { id: string; n: number },
  rule: string,
  problem: string,
  opts: { paths?: string[]; why?: string; recommendation?: string } = {},
): AttemptFinding {
  const paths = opts.paths ?? [];
  return {
    id: newId('fnd'),
    attemptId: attempt.id,
    attemptN: attempt.n,
    source: 'gate',
    rule,
    reviewId: null,
    severity: 'high',
    faultOrigin: 'implementation',
    location: paths.length === 1 ? (paths[0] ?? 'general') : 'general',
    problem,
    why: opts.why ?? 'a factory Gate failed, so the Task cannot be approved',
    recommendation: opts.recommendation ?? 'fix the cause and commit again',
    blocking: true,
    paths,
  };
}

/** A path-scope violation as a Finding. */
export function scopeFinding(
  attempt: { id: string; n: number },
  violation: PathScopeViolation,
): AttemptFinding {
  return gateFinding(attempt, violation.rule, violation.message, {
    paths: violation.paths,
    why:
      violation.rule === 'scope.forbidden'
        ? 'the Task’s scope forbids changing these paths'
        : 'the Task may change only paths inside its writable scope',
    recommendation:
      'undo the changes to these paths on the Task Branch (for example restore them from the base commit and commit), so that base..head touches only writable paths',
  });
}
