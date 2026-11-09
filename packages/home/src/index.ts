/**
 * The factory home directory (default `~/.factory`, overridable with FACTORY_HOME).
 * Shared by the CLI and the runtime. Holds files only: the database inside it is
 * owned by the runtime, which is its single writer.
 *
 *   token          API bearer token, mode 0600
 *   config.json    operator config (workspace root, port)
 *   runtime.json   pid record of the running runtime (pidfile)
 *   factory.db     SQLite database (runtime only)
 *   artifacts/     immutable Artifact contents, named by content hash (runtime only)
 *   logs/runtime.log
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BillingSchema, PriceTableSchema } from '@factory/domain';
import { z } from 'zod';

export const DEFAULT_PORT = 7420;
export const RUNTIME_HOST = '127.0.0.1';

export interface FactoryHome {
  readonly root: string;
  readonly tokenPath: string;
  readonly configPath: string;
  readonly runtimeRecordPath: string;
  readonly dbPath: string;
  readonly artifactDir: string;
  readonly logDir: string;
  readonly runtimeLogPath: string;
  /**
   * Spool directories of the processes the factory starts (pid, start time,
   * exit status, raw output), so they can outlive a runtime crash. Each is
   * removed once its process's end is recorded (ADR-0012).
   */
  readonly spoolDir: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): FactoryHome {
  // The comment tells the dashboard's bundler (Turbopack) this is a runtime path, not a file to trace.
  const root = resolve(
    /*turbopackIgnore: true*/ env['FACTORY_HOME'] ?? join(homedir(), '.factory'),
  );
  const logDir = join(root, 'logs');
  return {
    root,
    tokenPath: join(root, 'token'),
    configPath: join(root, 'config.json'),
    runtimeRecordPath: join(root, 'runtime.json'),
    dbPath: join(root, 'factory.db'),
    artifactDir: join(root, 'artifacts'),
    logDir,
    runtimeLogPath: join(logDir, 'runtime.log'),
    spoolDir: join(root, 'run'),
  };
}

export function ensureHomeDirs(home: FactoryHome): void {
  mkdirSync(home.root, { recursive: true, mode: 0o700 });
  chmodSync(home.root, 0o700);
  mkdirSync(home.logDir, { recursive: true, mode: 0o700 });
  mkdirSync(home.artifactDir, { recursive: true, mode: 0o700 });
  mkdirSync(home.spoolDir, { recursive: true, mode: 0o700 });
}

// ---- config ---------------------------------------------------------------

/**
 * Which Harness the runtime drives. Runtime configuration is the only way to
 * choose it: the runtime has no other switch. Unset: no Harness, so queued
 * Stages wait.
 */
export const HarnessConfigSchema = z.discriminatedUnion('id', [
  z.object({
    id: z.literal('fake'),
    /** The Fake Harness's YAML script. */
    script: z.string().refine((p) => isAbsolute(p), 'must be an absolute path'),
  }),
  z
    .object({
      id: z.literal('claude-code'),
      /** The `claude` executable: an absolute path, or a name looked up on the runtime's PATH. */
      command: z.string().min(1).default('claude'),
      /** `--model` for every Run; the CLI's default when unset. */
      model: z.string().min(1).optional(),
      /**
       * How Harness Runs are billed. `subscription` (default): the operator's
       * own `claude` login, and no credential is passed. `api_key`: the
       * runtime's `ANTHROPIC_API_KEY` is passed to every Claude Code Harness
       * Run, so the Harness and every command it runs can read it (Tier 0 is
       * a guardrail, not isolation). A permission expansion (ADR-0015).
       */
      billing: BillingSchema.default('subscription'),
      /** USD per million tokens by model, for cost estimates under `api_key`; else the CLI's list price. */
      prices: PriceTableSchema.optional(),
    })
    .strict(),
]);
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const FactoryConfigSchema = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  harness: HarnessConfigSchema.optional(),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

export function readConfig(home: FactoryHome): FactoryConfig | undefined {
  const raw = readIfExists(home.configPath);
  if (raw === undefined) return undefined;
  return FactoryConfigSchema.parse(JSON.parse(raw));
}

export function writeConfig(home: FactoryHome, config: FactoryConfig): void {
  writeFileSync(
    home.configPath,
    JSON.stringify(FactoryConfigSchema.parse(config), null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
}

// ---- token ----------------------------------------------------------------

/** Creates the API token. Never overwrites an existing one. */
export function createToken(home: FactoryHome): void {
  writeFileSync(home.tokenPath, randomBytes(32).toString('hex') + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(home.tokenPath, 0o600);
}

export function readToken(home: FactoryHome): string | undefined {
  const raw = readIfExists(home.tokenPath)?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

// ---- runtime record (pidfile) ---------------------------------------------

export const RuntimeRecordSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  port: z.number().int().positive(),
  startedAt: z.string(),
  version: z.string(),
});
export type RuntimeRecord = z.infer<typeof RuntimeRecordSchema>;

export function readRuntimeRecord(home: FactoryHome): RuntimeRecord | undefined {
  const raw = readIfExists(home.runtimeRecordPath);
  if (raw === undefined) return undefined;
  const parsed = RuntimeRecordSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

/** Written atomically (a temp file, then a rename), so a reader never sees it half-written. */
export function writeRuntimeRecord(home: FactoryHome, record: RuntimeRecord): void {
  const tmp = `${home.runtimeRecordPath}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(tmp, home.runtimeRecordPath);
}

export function removeRuntimeRecord(home: FactoryHome): void {
  rmSync(home.runtimeRecordPath, { force: true });
}

export function runtimeUrl(record: RuntimeRecord): string {
  return `http://${record.host}:${String(record.port)}`;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
