/**
 * Live activity (#49, ADR-0018): the Attempts running now, and a redacted tail
 * of the process each one waits on. Read-only. The tail is read from the
 * process's spool (ADR-0012), which holds raw output, so every tail is
 * redacted here before it leaves the runtime (ADR-0011).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { schema, type FactoryDb } from '@factory/db';
import {
  SECURITY_TIER_LABELS,
  SecurityTierSchema,
  AttemptStateSchema,
  TAIL_LINES,
  tailLines,
  type Activity,
  type AttemptTail,
  type Heartbeat,
  type Redactor,
} from '@factory/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ApiFailure } from './errors.js';
import { parseProcess } from './execution.js';
import { PORT_BLOCK_SIZE } from './worktree.js';

/** The Attempt states in which work is running (a Harness Run or a verification command). */
const RUNNING_STATES = ['running', 'verifying', 'in_review'] as const;
/** How much of the end of a spool is read for a tail: enough for 200 long lines. */
const TAIL_BYTES = 256 * 1024;

export class ActivityService {
  constructor(
    private readonly db: FactoryDb,
    private readonly redact: Redactor,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every running Attempt, oldest first. */
  list(): Activity {
    const now = this.now();
    const rows = this.db
      .select({
        attemptId: schema.attempts.id,
        n: schema.attempts.n,
        state: schema.attempts.state,
        harnessId: schema.attempts.harnessId,
        harnessVersion: schema.attempts.harnessVersion,
        tier: schema.attempts.tier,
        startedAt: schema.attempts.startedAt,
        jobId: schema.jobs.id,
        jobTitle: schema.jobs.title,
        taskId: schema.tasks.id,
        taskKey: schema.tasks.key,
        taskTitle: schema.tasks.title,
        repositoryId: schema.repositories.id,
        repositoryName: schema.repositories.name,
        portBase: schema.worktrees.portBase,
        heartbeatAt: schema.leases.heartbeatAt,
      })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.tasks.jobId))
      .innerJoin(schema.worktrees, eq(schema.worktrees.id, schema.attempts.worktreeId))
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.worktrees.repositoryId))
      .leftJoin(
        schema.leases,
        and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, schema.tasks.id)),
      )
      .where(inArray(schema.attempts.state, [...RUNNING_STATES]))
      .orderBy(asc(schema.attempts.startedAt), asc(schema.attempts.id))
      .all();
    return {
      at: new Date(now).toISOString(),
      attempts: rows.map((r) => {
        const tier = SecurityTierSchema.parse(r.tier);
        return {
          attemptId: r.attemptId,
          n: r.n,
          state: AttemptStateSchema.parse(r.state),
          job: { id: r.jobId, title: r.jobTitle },
          task: { id: r.taskId, key: r.taskKey, title: r.taskTitle },
          harness: { id: r.harnessId, version: r.harnessVersion },
          // No Harness reports its model while it runs, and none is recorded (ADR-0018).
          model: null,
          repository: { id: r.repositoryId, name: r.repositoryName },
          tier,
          tierLabel: SECURITY_TIER_LABELS[tier].label,
          tierDetail: SECURITY_TIER_LABELS[tier].detail,
          startedAt: r.startedAt,
          heartbeat: heartbeat(r.heartbeatAt, now),
          ports: { base: r.portBase, size: PORT_BLOCK_SIZE },
        };
      }),
    };
  }

  /** The last {@link TAIL_LINES} lines of the process the Attempt waits on, redacted. */
  tail(attemptId: string): AttemptTail {
    const row = this.db
      .select({
        state: schema.attempts.state,
        processJson: schema.attempts.processJson,
        heartbeatAt: schema.leases.heartbeatAt,
      })
      .from(schema.attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.attempts.taskId))
      .leftJoin(
        schema.leases,
        and(eq(schema.leases.resourceKind, 'task'), eq(schema.leases.resourceId, schema.tasks.id)),
      )
      .where(eq(schema.attempts.id, attemptId))
      .get();
    if (row === undefined) throw new ApiFailure(404, 'not_found', `no Attempt ${attemptId}`);
    const running = (RUNNING_STATES as readonly string[]).includes(row.state);
    const none = { lines: [], truncated: false };
    if (!running || row.processJson === null) {
      return {
        attemptId,
        running,
        process: null,
        ...none,
        heartbeat: running ? heartbeat(row.heartbeatAt, this.now()) : null,
      };
    }
    const p = parseProcess(row.processJson);
    const chunk = readEnd(join(p.spool, 'output'), TAIL_BYTES);
    // Redacted whole, before it is cut into lines, so a secret is matched as written.
    const tail = tailLines(this.redact(chunk.text), {
      max: TAIL_LINES,
      fromStart: chunk.fromStart,
    });
    return {
      attemptId,
      running,
      process: { kind: p.kind, label: basename(p.spool) },
      ...tail,
      heartbeat: heartbeat(row.heartbeatAt, this.now()),
    };
  }
}

function heartbeat(at: string | null, now: number): Heartbeat {
  if (at === null) return null;
  return { at, ageMs: Math.max(0, now - Date.parse(at)) };
}

/** The last `max` bytes of a file; empty when it doesn't exist (yet). */
function readEnd(path: string, max: number): { text: string; fromStart: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { text: '', fromStart: true };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return { text: buf.toString('utf8'), fromStart: length === size };
  } finally {
    closeSync(fd);
  }
}
