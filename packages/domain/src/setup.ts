/**
 * The Worktree setup step (spec issue 43, ADR-0047). A Repository may carry
 * one setup command, set by a human at `repo add --setup` and never inferred
 * or taken from repo content, a Plan or agent output (CLAUDE.md §2). The
 * factory runs it itself in a Worktree, under the Tier 0 guardrail, before the
 * developer's Harness Run and before verification, so both see installed
 * dependencies. Lifecycle scripts stay off and the package managers use the
 * factory's shared cache (ARCHITECTURE §10). Pure: no I/O.
 */
import { z } from 'zod';

/** One line: the command runs through `sh -c`, as verification commands do. */
export const SetupCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((c) => !/[\r\n]/.test(c), 'must be one line');

/**
 * The files whose contents decide whether a Worktree's installed dependencies
 * are current: the manifest and every lockfile the supported package managers
 * write. A Repository without a lockfile still has its manifest.
 */
export const DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/**
 * The environment of a setup run: the guardrail environment of the Attempt,
 * plus the factory's own variables, which always win. The package managers'
 * caches point under `cacheDir` (one store shared by every Worktree), and
 * lifecycle scripts are switched off for npm, pnpm and yarn, whatever the
 * command says (ADR-0007 refuses repo setup scripts). Nothing else is added.
 */
export function setupEnvironment(
  guardrail: Readonly<Record<string, string>>,
  cacheDir: string,
): Record<string, string> {
  return {
    ...guardrail,
    npm_config_cache: `${cacheDir}/npm`,
    npm_config_store_dir: `${cacheDir}/pnpm-store`,
    YARN_CACHE_FOLDER: `${cacheDir}/yarn`,
    npm_config_ignore_scripts: 'true',
    YARN_ENABLE_SCRIPTS: 'false',
  };
}

/**
 * Whether a Worktree needs its setup run (again): it has none yet, the latest
 * one did not pass (it may have left a half-written install), or the
 * dependency files changed since it ran. `runs`: this Worktree's setup runs,
 * oldest first.
 */
export function setupNeeded(
  runs: readonly { passed: boolean; dependencyHash: string }[],
  dependencyHash: string,
): boolean {
  const last = runs.at(-1);
  return last === undefined || !last.passed || last.dependencyHash !== dependencyHash;
}

/** A setup run as the API shows it (`GET /v1/jobs/:id/attempts`, on its Attempt). */
export const SetupRunSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  worktreeId: z.string(),
  command: z.string(),
  /** `null`: it timed out or was killed by a signal. */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  /** Exited 0 and left the Worktree as it found it (clean git status, HEAD unmoved). */
  passed: z.boolean(),
  /** Why it did not pass (the exit, or what it changed); `null` when it passed. */
  failure: z.string().nullable(),
  /** `sha256:` over the dependency files ({@link DEPENDENCY_FILES}) it ran for. */
  dependencyHash: z.string(),
  /** What the Worktree held when it ran: the run is tied to these. */
  headSha: z.string(),
  baseSha: z.string(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** The Worktree's disk usage after the run, in bytes; `null` when it couldn't be measured. */
  diskBytes: z.number().int().nonnegative().nullable(),
  /** The redacted output, a `log` Artifact. */
  outputArtifactId: z.string(),
});
export type SetupRun = z.infer<typeof SetupRunSchema>;

/** A Delivery Report Task's `setup`: its Worktree's latest setup run (ADR-0047). */
export const DeliveredSetupSchema = SetupRunSchema.pick({
  command: true,
  exitCode: true,
  timedOut: true,
  passed: true,
  failure: true,
  durationMs: true,
  diskBytes: true,
  headSha: true,
  baseSha: true,
  outputArtifactId: true,
});

/** The `log` Artifact of a setup run. */
export interface SetupLogContent {
  source: 'setup';
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  output: string;
}
