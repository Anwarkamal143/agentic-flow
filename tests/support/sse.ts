/**
 * A minimal Server-Sent Events client over fetch, for scenarios. It speaks the
 * wire format only (`id:`, `event:`, `data:` fields; blank line ends a message).
 */
import { onTestFinished } from 'vitest';
import type { RunningRuntime } from './factory.js';

export interface SseMessage {
  id: string | undefined;
  event: string;
  data: string;
}

export interface SseStream {
  readonly status: number;
  /** The next message; rejects after `timeoutMs`. */
  next(timeoutMs?: number): Promise<SseMessage>;
  /** Reads messages until `done` returns true for one; returns all read, including it. */
  until(done: (m: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage[]>;
  /** Disconnects, as a client would. */
  close(): void;
}

export async function openStream(
  rt: RunningRuntime,
  path: string,
  opts: { lastEventId?: string } = {},
): Promise<SseStream> {
  const abort = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = opts.lastEventId;
  const res = await rt.request(path, { headers, signal: abort.signal });
  const queue: SseMessage[] = [];
  const waiters: (() => void)[] = [];
  let ended: Error | undefined;

  const wakeAll = () => {
    for (const w of waiters.splice(0)) w();
  };

  if (res.body !== null && res.ok) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const message = parse(block);
            if (message !== undefined) queue.push(message);
          }
          wakeAll();
        }
        ended = new Error('stream ended');
      } catch (err) {
        ended = err instanceof Error ? err : new Error(String(err));
      }
      wakeAll();
    })();
  }

  const close = () => {
    abort.abort();
  };
  onTestFinished(close);

  const next = async (timeoutMs = 5_000): Promise<SseMessage> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = queue.shift();
      if (message !== undefined) return message;
      if (ended !== undefined) throw ended;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no SSE message within ${String(timeoutMs)}ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return {
    status: res.status,
    next,
    until: async (done, timeoutMs = 5_000) => {
      const read: SseMessage[] = [];
      for (;;) {
        const m = await next(timeoutMs);
        read.push(m);
        if (done(m)) return read;
      }
    },
    close,
  };
}

function parse(block: string): SseMessage | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && id === undefined) return undefined; // comment or keep-alive only
  return { id, event, data: data.join('\n') };
}
