/**
 * The dashboard listens on 127.0.0.1 only, and answers only requests
 * addressed to a loopback host. A page on another site that resolves its own
 * name to 127.0.0.1 (DNS rebinding) is refused, so it cannot read the
 * factory's state through the dashboard.
 */
import { NextResponse, type NextRequest } from 'next/server';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function proxy(request: NextRequest): NextResponse {
  const host = request.headers.get('host') ?? '';
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (name === undefined || !LOOPBACK.has(name)) {
    return NextResponse.json({ error: 'forbidden_host' }, { status: 403 });
  }
  return NextResponse.next();
}
