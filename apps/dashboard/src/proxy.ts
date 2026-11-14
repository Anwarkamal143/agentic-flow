/**
 * The dashboard listens on 127.0.0.1 only, and answers only requests
 * addressed to a loopback host. A page on another site that resolves its own
 * name to 127.0.0.1 (DNS rebinding) is refused, so it cannot read the
 * factory's state through the dashboard. A write also checks its Origin, in
 * its route (ADR-0022).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isLoopbackHost } from '@/lib/loopback';

export function proxy(request: NextRequest): NextResponse {
  if (!isLoopbackHost(request.headers.get('host') ?? '')) {
    return NextResponse.json({ error: 'forbidden_host' }, { status: 403 });
  }
  return NextResponse.next();
}
