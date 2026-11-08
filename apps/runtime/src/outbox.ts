/**
 * The outbox publisher (ARCHITECTURE §4.1). State changes append events in
 * their own transaction; this loop releases them (sets `published_at`) and
 * wakes every SSE subscriber, which then reads released events past its own
 * cursor from the database.
 *
 * No gaps, no duplicates: the runtime is the single writer and its
 * transactions are synchronous, so events commit in `seq` order and the
 * released events are always a prefix of the log. A subscriber only ever
 * advances its cursor past what it has sent, so a reconnect with
 * `Last-Event-ID: n` resumes at exactly `n + 1`.
 */
import { schema, type FactoryDb } from '@factory/db';
import type { FactoryEvent } from '@factory/domain';
import { isNull, max } from 'drizzle-orm';
import { readEvents, type EventQuery } from './events.js';

const BATCH = 500;

export interface SubscribeOptions {
  /** Deliver events with `seq` greater than this. */
  after: number;
  jobId?: string;
  send(event: FactoryEvent): Promise<void>;
  /** Called once when the subscription ends: the client went away or the runtime stops. */
  onClose(): void;
}

export interface Subscription {
  close(): void;
}

export class Outbox {
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | undefined;
  private wakeScheduled = false;

  constructor(
    private readonly db: FactoryDb,
    private readonly pollMs = 250,
  ) {}

  /** Releases anything left from before (including a previous run) and starts polling. */
  start(): void {
    this.publish();
    this.timer = setInterval(() => {
      this.publish();
    }, this.pollMs);
  }

  /** Asks for a publish soon. Call after committing a state change. */
  notify(): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      this.publish();
    });
  }

  /** The committed events, published or not, in `seq` order. */
  list(q: EventQuery): FactoryEvent[] {
    return readEvents(this.db, q);
  }

  /** The highest `seq` committed so far (0 when there are no events). */
  head(): number {
    const row = this.db
      .select({ seq: max(schema.events.seq) })
      .from(schema.events)
      .get();
    return row?.seq ?? 0;
  }

  subscribe(opts: SubscribeOptions): Subscription {
    const sub = new Subscriber(this.db, opts, () => this.subscribers.delete(sub));
    this.subscribers.add(sub);
    sub.wake();
    return sub;
  }

  /** Stops publishing and ends every subscription. */
  close(): void {
    clearInterval(this.timer);
    for (const sub of [...this.subscribers]) sub.close();
  }

  private publish(): void {
    const released = this.db
      .update(schema.events)
      .set({ publishedAt: new Date().toISOString() })
      .where(isNull(schema.events.publishedAt))
      .run();
    if (released.changes > 0) for (const sub of this.subscribers) sub.wake();
  }
}

class Subscriber {
  private cursor: number;
  private pumping = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly db: FactoryDb,
    private readonly opts: SubscribeOptions,
    private readonly detach: () => void,
  ) {
    this.cursor = opts.after;
  }

  wake(): void {
    if (this.closed) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    void this.pump();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.opts.onClose();
  }

  // Methods, not field reads: `close()` and `wake()` run while `pump` awaits a write.
  private isOpen(): boolean {
    return !this.closed;
  }

  private wokenDuringPump(): boolean {
    return this.again;
  }

  private async pump(): Promise<void> {
    try {
      do {
        this.again = false;
        for (;;) {
          const batch = readEvents(this.db, {
            after: this.cursor,
            ...(this.opts.jobId === undefined ? {} : { jobId: this.opts.jobId }),
            publishedOnly: true,
            limit: BATCH,
          });
          for (const event of batch) {
            if (!this.isOpen()) return;
            await this.opts.send(event);
            this.cursor = event.seq;
          }
          if (batch.length < BATCH) break;
        }
      } while (this.wokenDuringPump() && this.isOpen());
    } catch {
      // The client went away mid-write.
      this.close();
    } finally {
      this.pumping = false;
    }
  }
}
