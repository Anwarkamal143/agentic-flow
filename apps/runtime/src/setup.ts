/**
 * The Worktree setup step's records (ADR-0047): the dependency files' hash a
 * setup run is tied to, the Worktree's disk usage after it, and the
 * `setup_runs` row with its redacted `log` Artifact and `setup_run.finished`
 * event, in the caller's transaction. The run itself is the Task scheduler's
 * (`execution.ts`), under the Tier 0 guardrail like a verification command.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import { DEPENDENCY_FILES, SetupRunSchema, type SetupRun } from '@factory/domain';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { ArtifactStore, StoredContent } from './artifacts.js';
import { newId } from './ids.js';

const run = promisify(execFile);

/**
 * `sha256:` over the dependency files present in the Worktree's working tree,
 * each by name and content. Symbolic links are hashed by their target path,
 * never followed: the Worktree is agent-written.
 */
export function dependencyHashOf(worktree: string): string {
  const hash = createHash('sha256');
  for (const name of DEPENDENCY_FILES) {
    const path = join(worktree, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    hash.update(`${name}\0`);
    hash.update(stat.isFile() ? readFileSync(path) : `not a regular file (${String(stat.mode)})`);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The Worktree's disk usage in bytes (`du -sk`, so 1 KiB blocks), or `null` when `du` fails. */
export async function diskUsageBytes(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('du', ['-sk', path], { timeout: 60_000 });
    const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

/** A Worktree's setup runs, oldest first, as `setupNeeded` reads them. */
export function setupRunsOf(
  db: FactoryDb | Tx,
  worktreeId: string,
): { passed: boolean; dependencyHash: string }[] {
  return db
    .select({
      passed: schema.setupRuns.passed,
      dependencyHash: schema.setupRuns.dependencyHash,
    })
    .from(schema.setupRuns)
    .where(eq(schema.setupRuns.worktreeId, worktreeId))
    .orderBy(asc(schema.setupRuns.startedAt))
    .all();
}

export interface SetupRunRecord {
  jobId: string;
  taskId: string;
  attemptId: string;
  worktreeId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Why it did not pass; `undefined` when it passed. */
  failure: string | undefined;
  dependencyHash: string;
  headSha: string;
  baseSha: string;
  startedAt: string;
  durationMs: number;
  diskBytes: number | null;
  /** The redacted log (`SetupLogContent`), already stored. */
  content: StoredContent;
}

/** Records one setup run: its `log` Artifact, its row and its event. In the caller's transaction. */
export function recordSetupRun(
  tx: Tx,
  artifacts: ArtifactStore,
  input: SetupRunRecord,
  actor: string,
): string {
  const log = artifacts.record(
    tx,
    {
      jobId: input.jobId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      kind: 'log',
      content: input.content,
    },
    actor,
  );
  const id = newId('sr');
  const passed = input.failure === undefined;
  tx.insert(schema.setupRuns)
    .values({
      id,
      attemptId: input.attemptId,
      worktreeId: input.worktreeId,
      command: input.command,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      passed,
      failure: input.failure ?? null,
      dependencyHash: input.dependencyHash,
      headSha: input.headSha,
      baseSha: input.baseSha,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      diskBytes: input.diskBytes,
      outputArtifactId: log.id,
    })
    .run();
  appendEvent(tx, {
    entityKind: 'attempt',
    entityId: input.attemptId,
    jobId: input.jobId,
    type: 'setup_run.finished',
    actor,
    payload: {
      setupRunId: id,
      taskId: input.taskId,
      worktreeId: input.worktreeId,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      passed,
      failure: input.failure ?? null,
      durationMs: input.durationMs,
      diskBytes: input.diskBytes,
      dependencyHash: input.dependencyHash,
      headSha: input.headSha,
      baseSha: input.baseSha,
      outputArtifactId: log.id,
    },
  });
  return id;
}

/** The setup runs of these Attempts, as the API shows them, oldest first. */
export function setupRunsOfAttempts(db: FactoryDb | Tx, attemptIds: string[]): SetupRun[] {
  if (attemptIds.length === 0) return [];
  return db
    .select()
    .from(schema.setupRuns)
    .where(inArray(schema.setupRuns.attemptId, attemptIds))
    .orderBy(asc(schema.setupRuns.startedAt))
    .all()
    .map(toSetupRun);
}

/** A Worktree's latest setup run, or `undefined` when none ran (the Delivery Report's). */
export function latestSetupRun(db: FactoryDb | Tx, worktreeId: string): SetupRun | undefined {
  const row = db
    .select()
    .from(schema.setupRuns)
    .where(eq(schema.setupRuns.worktreeId, worktreeId))
    .orderBy(desc(schema.setupRuns.startedAt))
    .get();
  return row === undefined ? undefined : toSetupRun(row);
}

function toSetupRun(r: typeof schema.setupRuns.$inferSelect): SetupRun {
  return SetupRunSchema.parse({
    id: r.id,
    attemptId: r.attemptId,
    worktreeId: r.worktreeId,
    command: r.command,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    passed: r.passed,
    failure: r.failure,
    dependencyHash: r.dependencyHash,
    headSha: r.headSha,
    baseSha: r.baseSha,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    diskBytes: r.diskBytes,
    outputArtifactId: r.outputArtifactId,
  } satisfies Record<keyof SetupRun, unknown>);
}
