/**
 * The browser's live event stream: a pass-through of the runtime's
 * `GET /v1/events/stream` (ADR-0005), so the API token stays on the server.
 * It resumes after `Last-Event-ID` (sent by `EventSource` on a reconnect) or
 * `?after=` (the last event a freshly loaded page shows); `?job=` limits it
 * to one Job. Read-only: GET is the only method.
 */
import { connect, RuntimeUnavailable } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SEQ = /^\d{1,15}$/;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const job = params.get('job');
  const after = params.get('after');
  const lastEventId = request.headers.get('last-event-id');
  if (
    (job !== null && !ID.test(job)) ||
    (after !== null && !SEQ.test(after)) ||
    (lastEventId !== null && !SEQ.test(lastEventId))
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  let upstream: Response;
  try {
    const rt = connect();
    const query = new URLSearchParams();
    if (job !== null) query.set('job', job);
    if (after !== null) query.set('after', after);
    const headers: Record<string, string> = {
      authorization: `Bearer ${rt.token}`,
      accept: 'text/event-stream',
    };
    if (lastEventId !== null) headers['last-event-id'] = lastEventId;
    upstream = await fetch(`${rt.url}/v1/events/stream?${query.toString()}`, {
      headers,
      cache: 'no-store',
      // Closing the browser's connection closes the runtime's.
      signal: request.signal,
    });
  } catch (err) {
    const message =
      err instanceof RuntimeUnavailable ? err.message : 'The factory runtime did not answer.';
    return Response.json({ error: 'runtime_unavailable', message }, { status: 503 });
  }
  if (!upstream.ok || upstream.body === null) {
    return Response.json(
      { error: 'upstream', status: upstream.status },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }
  // Next.js sends the response head with the first body chunk, so a stream with
  // nothing to replay would leave the browser waiting. A comment goes first.
  const opened = new TextEncoder().encode(': connected\n\n');
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(opened);
      },
    }),
  );
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
