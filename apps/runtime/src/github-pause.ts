/**
 * The GitHub-wide pause (#66, ADR-0045; Q23). A rate limit is capacity, not
 * failure, like a Harness usage window (ARCHITECTURE §13): the first
 * rate-limit response sets `paused_until` to GitHub's reset in the
 * `github_state` row with `github.paused`; a later reset extends it with
 * `github.pause_extended`. Until then the GitHub port sends nothing (it is the
 * port's {@link RateLimitGate}), so every caller gets `rate_limited` at once
 * and waits as it already does. At the reset a timer clears the pause with
 * `github.resumed` and wakes the callers. No Stage Run changes and no Blocker
 * is raised.
 *
 * The row is persisted, so a runtime started during a pause keeps it, and
 * one started after the reset ends it at once.
 */
import { appendEvent, schema, type FactoryDb } from '@factory/db';
import type { GitHubPause } from '@factory/domain';
import type { RateLimitGate } from '@factory/github';
import { eq } from 'drizzle-orm';

const ID = 'github';
const ACTOR = 'system:github';
/** setTimeout's longest delay; a later reset is checked again then. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface GitHubPauseDeps {
  db: FactoryDb;
  /** After the pause started, moved or ended (committed). */
  onChange: () => void;
  log: (message: string) => void;
}

export class GitHubPauseGate implements RateLimitGate {
  /** The committed row's pause: read on every GitHub request, so kept in memory (one writer). */
  private pause: GitHubPause | null;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly deps: GitHubPauseDeps) {
    const row = deps.db
      .select()
      .from(schema.githubState)
      .where(eq(schema.githubState.id, ID))
      .get();
    if (row?.pausedUntil == null) {
      this.pause = null;
    } else if (row.pausedAt === null || row.pauseStatus === null) {
      // The three are always written together: a half-set row is not guessed at.
      throw new Error('github_state holds paused_until without paused_at and pause_status');
    } else {
      this.pause = {
        pausedUntil: row.pausedUntil,
        pausedAt: row.pausedAt,
        status: row.pauseStatus,
      };
    }
  }

  /** Ends a pause left past its reset, or waits for it. Call once the runtime runs. */
  start(): void {
    this.schedule();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** The pause in force (for `status` and the dashboard), or null. */
  state(): GitHubPause | null {
    return this.pause;
  }

  current(): { until: string; status: number } | null {
    return this.pause === null
      ? null
      : { until: this.pause.pausedUntil, status: this.pause.status };
  }

  limited(limit: { status: number; resetAt: string }): void {
    if (this.closed) return;
    const reset = Date.parse(limit.resetAt);
    if (!Number.isFinite(reset) || reset <= Date.now()) return; // already over: nothing to wait for
    const before = this.pause;
    if (before !== null && reset <= Date.parse(before.pausedUntil)) return; // within the pause in force
    const now = new Date().toISOString();
    const next: GitHubPause = {
      pausedUntil: new Date(reset).toISOString(),
      pausedAt: before?.pausedAt ?? now,
      status: limit.status,
    };
    this.deps.db.transaction((tx) => {
      tx.insert(schema.githubState)
        .values({
          id: ID,
          pausedUntil: next.pausedUntil,
          pausedAt: next.pausedAt,
          pauseStatus: next.status,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.githubState.id,
          set: {
            pausedUntil: next.pausedUntil,
            pausedAt: next.pausedAt,
            pauseStatus: next.status,
            updatedAt: now,
          },
        })
        .run();
      appendEvent(tx, {
        entityKind: 'github',
        entityId: ID,
        type: before === null ? 'github.paused' : 'github.pause_extended',
        actor: ACTOR,
        payload: {
          pausedUntil: next.pausedUntil,
          status: next.status,
          ...(before === null ? {} : { previousUntil: before.pausedUntil }),
        },
      });
    });
    this.pause = next;
    this.deps.log(
      `github: rate limited (HTTP ${String(next.status)}); every GitHub call is paused until ${next.pausedUntil}`,
    );
    this.schedule();
    this.deps.onChange();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.closed || this.pause === null) return;
    const wait = Date.parse(this.pause.pausedUntil) - Date.now();
    if (wait <= 0) {
      this.resume();
      return;
    }
    this.timer = setTimeout(
      () => {
        this.schedule();
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  private resume(): void {
    const ended = this.pause;
    if (ended === null) return;
    const now = new Date().toISOString();
    this.deps.db.transaction((tx) => {
      tx.update(schema.githubState)
        .set({ pausedUntil: null, pausedAt: null, pauseStatus: null, updatedAt: now })
        .where(eq(schema.githubState.id, ID))
        .run();
      appendEvent(tx, {
        entityKind: 'github',
        entityId: ID,
        type: 'github.resumed',
        actor: ACTOR,
        payload: { pausedAt: ended.pausedAt, pausedUntil: ended.pausedUntil },
      });
    });
    this.pause = null;
    this.deps.log(`github: the rate limit reset at ${ended.pausedUntil}; GitHub calls resume`);
    this.deps.onChange();
  }
}
