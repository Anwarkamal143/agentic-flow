/**
 * The redacted tail of an Attempt's running process, for the live activity
 * page to poll every 5 s (ADR-0018, the tail-only exception to ADR-0014's
 * "nothing polls"). A pass-through of the runtime's `GET /v1/attempts/:id/tail`,
 * so the API token stays on the server. Read-only: GET is the only method.
 */
import { attemptTail, RuntimeApiError, RuntimeUnavailable } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!ID.test(id)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  try {
    return Response.json(await attemptTail(id), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (err instanceof RuntimeUnavailable) {
      return Response.json({ error: 'runtime_unavailable', message: err.message }, { status: 503 });
    }
    throw err;
  }
}
