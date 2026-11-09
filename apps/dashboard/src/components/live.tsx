'use client';

/**
 * Live updates without polling. Each page subscribes to the event stream
 * (through the dashboard's `/api/events/stream`). A new event re-renders the
 * page's server components from the runtime API (`router.refresh()`), so what
 * is shown stays the persisted state; the event itself is only the signal.
 * The job timeline also appends the streamed events, merged by `seq` with the
 * ones the page was rendered with, so a reload or a reconnect shows each
 * event once and none is missed.
 */
import type { FactoryEvent } from '@factory/domain';
import { mergeEventLog } from '@factory/domain/event-log';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatTime, humanize } from '@/lib/format';

/**
 * `reconnecting`: EventSource is retrying by itself. `disconnected`: it gave
 * up (the dashboard answered with an error, e.g. while the runtime is down),
 * and a new one is opened after a backoff.
 */
type StreamState = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

/** Refreshes are coalesced: a burst of events re-renders the page once. */
const REFRESH_DELAY_MS = 250;
/** Backoff before opening a new stream after EventSource gave up: 1 s, doubling, at most 30 s. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function useEventStream(
  query: { job?: string; after?: number },
  onEvent: ((event: FactoryEvent) => void) | undefined,
): StreamState {
  const router = useRouter();
  const [state, setState] = useState<StreamState>('connecting');
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  // Where the first stream starts is fixed at mount. A stream EventSource
  // retries resumes after the last event it received (`Last-Event-ID`); a new
  // stream, after EventSource gave up, starts after the last event seen.
  const start = useRef(query);

  useEffect(() => {
    let source: EventSource | undefined;
    let lastSeq = start.current.after;
    let backoff = RECONNECT_MIN_MS;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        router.refresh();
      }, REFRESH_DELAY_MS);
    };
    const open = () => {
      const params = new URLSearchParams();
      if (start.current.job !== undefined) params.set('job', start.current.job);
      if (lastSeq !== undefined) params.set('after', String(lastSeq));
      const es = new EventSource(`/api/events/stream?${params.toString()}`);
      source = es;
      es.onopen = () => {
        backoff = RECONNECT_MIN_MS;
        setState('live');
        // Anything persisted between this page's render (or the last stream) and this one.
        refresh();
      };
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) {
          setState('reconnecting');
          return;
        }
        setState('disconnected');
        reconnectTimer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      };
      es.addEventListener('factory', (message) => {
        const event = JSON.parse(message.data as string) as FactoryEvent;
        lastSeq = event.seq;
        onEventRef.current?.(event);
        refresh();
      });
    };
    open();
    return () => {
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [router]);

  return state;
}

function StreamBadge({ state }: { state: StreamState }) {
  return (
    <Badge variant={state === 'live' ? 'success' : 'warning'} aria-live="polite">
      {state === 'live' ? 'live' : state}
    </Badge>
  );
}

/** Keeps a page in step with the event stream (every Job's events). */
export function LiveRefresh() {
  return <StreamBadge state={useEventStream({}, undefined)} />;
}

/** A Job's events, oldest first, kept live. */
export function JobTimeline({ jobId, events }: { jobId: string; events: FactoryEvent[] }) {
  const [streamed, setStreamed] = useState<readonly FactoryEvent[]>([]);
  const state = useEventStream({ job: jobId, after: events.at(-1)?.seq ?? 0 }, (event) => {
    setStreamed((prev) => mergeEventLog(prev, [event]));
  });
  const timeline = mergeEventLog(events, streamed);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <StreamBadge state={state} />
        <span>
          {timeline.length} event{timeline.length === 1 ? '' : 's'}
        </span>
      </div>
      {timeline.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events recorded yet.</p>
      ) : (
        <ol className="space-y-1 font-mono text-xs" data-testid="timeline">
          {timeline.map((e) => (
            <li key={e.seq} data-seq={e.seq} className="flex flex-wrap gap-x-3 border-b py-1">
              <span className="w-12 shrink-0 text-right text-muted-foreground">#{e.seq}</span>
              <time dateTime={e.ts} className="shrink-0 text-muted-foreground">
                {formatTime(e.ts)}
              </time>
              <span className="font-semibold">{e.type}</span>
              <span className="text-muted-foreground">{summary(e)}</span>
              <span className="ml-auto text-muted-foreground">{e.actor}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The parts of a payload that say what changed, when it has them. */
function summary(e: FactoryEvent): string {
  const p = e.payload;
  const parts = [`${e.entityKind} ${e.entityId}`];
  if (typeof p['from'] === 'string' && typeof p['to'] === 'string') {
    parts.push(`${humanize(p['from'])} → ${humanize(p['to'])}`);
  } else if (typeof p['to'] === 'string') {
    parts.push(`→ ${humanize(p['to'])}`);
  }
  for (const key of ['reason', 'exitReason', 'outcome'] as const) {
    const v = p[key];
    if (typeof v === 'string') parts.push(`${key}: ${humanize(v)}`);
  }
  return parts.join(' · ');
}
