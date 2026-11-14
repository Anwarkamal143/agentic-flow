/**
 * The dashboard is local-only (ADR-0014): it answers requests addressed to a
 * loopback host, and accepts a write only from its own loopback origin
 * (ADR-0022).
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a `Host` header (name and optional port) names a loopback host. */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name !== undefined && LOOPBACK.has(name);
}

/**
 * Why a write is refused, or `undefined` when it may go ahead: the `Host` must
 * be loopback, and the `Origin` must be the dashboard's own, the very origin
 * that `Host` names. A missing or `null` Origin is refused, so a page on
 * another site (or on another local port) can't post a decision through it.
 */
export function checkWriteOrigin(
  headers: Headers,
): 'forbidden_host' | 'forbidden_origin' | undefined {
  const host = headers.get('host') ?? '';
  if (!isLoopbackHost(host)) return 'forbidden_host';
  if (headers.get('origin') !== `http://${host}`) return 'forbidden_origin';
  return undefined;
}
