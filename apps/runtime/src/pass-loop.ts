/**
 * The scheduling loop shared by the Stage and the Task scheduler: it runs one
 * pass at a time, when woken and on a poll timer. Another pass starts at once
 * only after a pass that did work, or when a wake arrived during the pass; an
 * empty pass waits for the timer, so an idle runtime never busy-loops.
 */
export class PassLoop {
  private timer: NodeJS.Timeout | undefined;
  private wakeScheduled = false;
  /** A wake arrived during a pass: run another one after it. */
  private wokenWhileBusy = false;
  private busy: Promise<void> | undefined;
  private halted = false;

  /** `pass` runs at most one unit of work and says whether it did any. */
  constructor(
    private readonly pass: () => Promise<boolean>,
    private readonly pollMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.wake();
    }, this.pollMs);
    this.wake();
  }

  /** Asks for a pass soon. Call after committing a state change. */
  wake(): void {
    if (this.wakeScheduled || this.halted) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      if (this.busy !== undefined) {
        this.wokenWhileBusy = true;
        return;
      }
      if (this.halted) return;
      this.wokenWhileBusy = false;
      let worked = false;
      this.busy = this.pass()
        .then((w) => {
          worked = w;
        })
        .finally(() => {
          this.busy = undefined;
          if (worked || this.wokenWhileBusy) this.wake();
        });
    });
  }

  /** Starts no further pass. The one in flight (see {@link idle}) runs on. */
  halt(): void {
    this.halted = true;
    clearInterval(this.timer);
  }

  /** Settles when no pass is running. */
  async idle(): Promise<void> {
    await this.busy;
  }
}
