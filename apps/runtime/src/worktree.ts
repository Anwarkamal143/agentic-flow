/**
 * Worktrees (ARCHITECTURE §10): where a Task's Worktree and Task Branch live
 * in the Factory Clone, the block of ports an Attempt leases, and the Task
 * Result file kept out of every commit.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { schema, type FactoryDb, type Tx } from '@factory/db';
import { RESULT_FILE } from '@factory/domain';
import { infoExcludePath } from '@factory/git';
import { and, eq } from 'drizzle-orm';
import { newId } from './ids.js';

const PORT_BLOCK_START = 42_000;
const PORT_BLOCK_SIZE = 10;
const PORT_BLOCKS = 1_000;

export type WorktreeRow = typeof schema.worktrees.$inferSelect;

/** A Task's Worktree path and Task Branch (ADR-0007). */
export function taskWorktree(input: {
  workspaceRoot: string;
  repositoryId: string;
  jobId: string;
  taskId: string;
  taskKey: string;
}): { path: string; branch: string } {
  return {
    path: join(input.workspaceRoot, input.repositoryId, input.jobId, input.taskKey),
    branch: `factory/${input.jobId}/${input.taskId}-${input.taskKey}`,
  };
}

export function requireWorktree(tx: FactoryDb | Tx, id: string): WorktreeRow {
  const row = tx.select().from(schema.worktrees).where(eq(schema.worktrees.id, id)).get();
  if (row === undefined) throw new Error(`no Worktree ${id}`);
  return row;
}

/**
 * Leases the lowest free block of ports for one Attempt (its Harness Runs and
 * verification commands). The Worktree records the base; the lease itself is
 * an Attempt token, released with the Task lease when the Attempt ends.
 */
export function allocatePortBlock(tx: Tx, lease: { holder: string; expiresAt: string }): number {
  const used = new Set(
    tx
      .select({ id: schema.leases.resourceId })
      .from(schema.leases)
      .where(eq(schema.leases.resourceKind, 'port_block'))
      .all()
      .map((l) => Number(l.id)),
  );
  for (let i = 0; i < PORT_BLOCKS; i++) {
    const base = PORT_BLOCK_START + i * PORT_BLOCK_SIZE;
    if (used.has(base)) continue;
    const now = new Date().toISOString();
    tx.insert(schema.leases)
      .values({
        resourceKind: 'port_block',
        resourceId: String(base),
        holder: lease.holder,
        leaseId: newId('lse'),
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: lease.expiresAt,
      })
      .run();
    return base;
  }
  throw new Error('no free port block');
}

/**
 * Releases an Attempt's tokens: its Task lease and, when it got one, its port
 * block (ARCHITECTURE §12 step 5). Call in the transaction that ends the Attempt.
 */
export function releaseAttemptTokens(tx: Tx, taskId: string, portBase: number | undefined): void {
  tx.delete(schema.leases)
    .where(and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, taskId)))
    .run();
  if (portBase !== undefined) {
    tx.delete(schema.leases)
      .where(
        and(
          eq(schema.leases.resourceKind, 'port_block'),
          eq(schema.leases.resourceId, String(portBase)),
        ),
      )
      .run();
  }
}

/** Keeps the Task Result file out of every commit, via the Factory Clone's `info/exclude`. */
export async function excludeResultFile(clone: string): Promise<void> {
  const exclude = await infoExcludePath(clone);
  const line = `/${dirname(RESULT_FILE)}/`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`);
}
