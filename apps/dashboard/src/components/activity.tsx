'use client';

/**
 * The tail of a running Attempt's output, polled every 5 s (ADR-0018). This
 * is the one thing the dashboard polls: process output is not an event, so
 * the event stream can't carry it, and neither can it carry the heartbeat,
 * which comes with each tail. Everything else on the page is persisted state,
 * refreshed by SSE (ADR-0014). The tail was redacted by the runtime.
 */
import type { AttemptTail } from '@factory/domain';
import { useEffect, useState } from 'react';

/** How often the tail is read again. */
const TAIL_POLL_MS = 5_000;

type PollState = 'ok' | 'failed';

export function LiveTail({ attemptId, initial }: { attemptId: string; initial: AttemptTail }) {
  const [tail, setTail] = useState(initial);
  const [poll, setPoll] = useState<PollState>('ok');

  useEffect(() => {
    let stopped = false;
    const timer = setInterval(() => {
      void fetch(`/api/attempts/${encodeURIComponent(attemptId)}/tail`, { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
          const next = (await res.json()) as AttemptTail;
          if (!stopped) {
            setTail(next);
            setPoll('ok');
          }
        })
        .catch(() => {
          if (!stopped) setPoll('failed');
        });
    }, TAIL_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [attemptId]);

  const lineCount = `${String(tail.lines.length)} line${tail.lines.length === 1 ? '' : 's'}`;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {tail.heartbeat === null
          ? 'Heartbeat: none (no Task lease)'
          : `Heartbeat ${String(Math.round(tail.heartbeat.ageMs / 1000))} s ago`}
        {' · '}
        {tail.process === null
          ? tail.running
            ? 'no process running right now'
            : 'the Attempt ended; its output is in factory logs'
          : `${tail.process.label} output, last ${lineCount} (redacted${tail.truncated ? ', earlier output left out' : ''})`}
        {' · '}
        {poll === 'ok' ? 'tail refreshed every 5 s' : 'tail refresh failed; retrying'}
      </p>
      {tail.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No output yet.</p>
      ) : (
        <pre
          className="max-h-96 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs"
          data-testid="tail"
          tabIndex={0}
          aria-label={`Output of Attempt ${attemptId}`}
        >
          {tail.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
