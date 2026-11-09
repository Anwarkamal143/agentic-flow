/**
 * The logs of a Job's Attempts (#11): the output of each Harness Run and each
 * verification command, stored as `log` Artifacts (redacted on write,
 * ADR-0011) and served by `GET /v1/jobs/:id/logs` for `factory logs`.
 */
import { z } from 'zod';

const HarnessExitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), code: z.number().int() }),
  z.object({ kind: z.literal('cancelled') }),
  z.object({ kind: z.literal('timed_out'), afterMs: z.number() }),
]);

/** The content of a Harness Run's `log` Artifact. */
export const HarnessLogContentSchema = z.object({
  source: z.literal('harness'),
  role: z.enum(['developer', 'reviewer']),
  /** The Run's number within its Attempt and Role (2 is the re-prompt). */
  n: z.number().int().positive(),
  harnessId: z.string(),
  executionId: z.string(),
  exit: HarnessExitSchema,
  durationMs: z.number(),
  output: z.string(),
});
export type HarnessLogContent = z.infer<typeof HarnessLogContentSchema>;

/** The content of a verification command's `log` Artifact. */
export const VerificationLogContentSchema = z.object({
  source: z.literal('verification'),
  key: z.string(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  output: z.string(),
});
export type VerificationLogContent = z.infer<typeof VerificationLogContentSchema>;

export const LogContentSchema = z.discriminatedUnion('source', [
  HarnessLogContentSchema,
  VerificationLogContentSchema,
]);

/** One entry of `GET /v1/jobs/:id/logs`, in the order the logs were stored. */
export const JobLogEntrySchema = z.object({
  artifactId: z.string(),
  createdAt: z.string(),
  taskId: z.string(),
  taskKey: z.string(),
  attemptId: z.string(),
  attemptN: z.number().int().positive(),
  content: LogContentSchema,
});
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>;
