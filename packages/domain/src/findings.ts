/**
 * Findings (ARCHITECTURE §4.6): their severity and Fault Origin, and a Finding
 * as recorded against an Attempt, raised by a factory Gate or by the
 * independent review. Imports nothing else of the domain, so the Task Packet
 * (which carries a Rework Attempt's prior Findings) and the review can both use it.
 */
import { z } from 'zod';

export const FindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** Where a Finding's fix belongs, which decides where Rework is routed (§4.6). */
export const FaultOriginSchema = z.enum(['implementation', 'plan', 'spec', 'infrastructure']);
export type FaultOrigin = z.infer<typeof FaultOriginSchema>;

/**
 * A Finding recorded against an Attempt: raised by a factory Gate (source
 * `gate`, with the Gate's rule) or by the independent review (source
 * `review`). A Rework Attempt's Task Packet carries the Findings of the
 * Attempt before it (`context.priorFindings`).
 */
export const AttemptFindingSchema = z.object({
  id: z.string(),
  /** The Attempt the Finding was raised against. */
  attemptId: z.string(),
  attemptN: z.number().int().positive(),
  source: z.enum(['gate', 'review']),
  /** The Gate rule that failed (`scope.forbidden`, `verification`, …), for source `gate`. */
  rule: z.string().nullable(),
  /** The review that raised it, for source `review`. */
  reviewId: z.string().nullable(),
  severity: FindingSeveritySchema,
  faultOrigin: FaultOriginSchema,
  location: z.string(),
  problem: z.string(),
  why: z.string(),
  recommendation: z.string(),
  blocking: z.boolean(),
  /** The offending paths, for the path-scope Gate. */
  paths: z.array(z.string()),
});
export type AttemptFinding = z.infer<typeof AttemptFindingSchema>;
