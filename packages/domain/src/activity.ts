/**
 * Live activity (#49, PRODUCT_SPEC §11 "What's running right now?"): every
 * running Attempt, and a redacted tail of the process it waits on (ADR-0018).
 */
import { z } from 'zod';
import { AttemptStateSchema, SecurityTierSchema } from './execution.js';

/** How many lines of a running process's output a tail shows. */
export const TAIL_LINES = 200;

/** How a model no Harness reported is shown, everywhere. */
export const MODEL_UNKNOWN_LABEL = 'unknown (not reported by the Harness)';

/** The Task lease's last renewal, and how long ago it was when the answer was made. */
export const HeartbeatSchema = z.object({ at: z.string(), ageMs: z.number().int() }).nullable();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const ActivityAttemptSchema = z.object({
  attemptId: z.string(),
  n: z.number().int(),
  /** `running`, `verifying` or `in_review`. */
  state: AttemptStateSchema,
  job: z.object({ id: z.string(), title: z.string() }),
  task: z.object({ id: z.string(), key: z.string(), title: z.string() }),
  harness: z.object({ id: z.string(), version: z.string().nullable() }),
  /** The model the Harness reported; `null` when it reported none ({@link MODEL_UNKNOWN_LABEL}). */
  model: z.string().nullable(),
  repository: z.object({ id: z.string(), name: z.string() }),
  tier: SecurityTierSchema,
  /** `SECURITY_TIER_LABELS[tier]`. */
  tierLabel: z.string(),
  tierDetail: z.string(),
  startedAt: z.string(),
  heartbeat: HeartbeatSchema,
  /** The block of ports the Attempt leases: `base` to `base + size - 1`. */
  ports: z.object({ base: z.number().int(), size: z.number().int() }),
});
export type ActivityAttempt = z.infer<typeof ActivityAttemptSchema>;

export const ActivitySchema = z.object({
  /** When the runtime answered (heartbeat ages are as of then). */
  at: z.string(),
  /** Oldest first. */
  attempts: z.array(ActivityAttemptSchema),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const AttemptTailSchema = z.object({
  attemptId: z.string(),
  /** `false` once the Attempt ended: its output is then in its `log` Artifacts. */
  running: z.boolean(),
  /**
   * The process whose output this is: `label` names it within the Attempt
   * (`developer-1`, `reviewer-1`, `verify-<key>`). `null`: none right now.
   */
  process: z.object({ kind: z.enum(['harness', 'verification']), label: z.string() }).nullable(),
  /** At most {@link TAIL_LINES}, redacted. */
  lines: z.array(z.string()),
  /** Earlier output was left out. */
  truncated: z.boolean(),
  heartbeat: HeartbeatSchema,
});
export type AttemptTail = z.infer<typeof AttemptTailSchema>;

/**
 * The last `max` lines of a chunk of process output. `fromStart`: the chunk
 * is the output from its first byte; otherwise it was cut from the middle,
 * and its first line, which is partial, is dropped. A last line without a
 * newline is still being written and is kept.
 */
export function tailLines(
  chunk: string,
  opts: { max: number; fromStart: boolean },
): { lines: string[]; truncated: boolean } {
  const lines = chunk.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (!opts.fromStart) lines.shift();
  const kept = lines.slice(Math.max(0, lines.length - opts.max));
  return { lines: kept, truncated: !opts.fromStart || kept.length < lines.length };
}
