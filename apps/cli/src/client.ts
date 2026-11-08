import {
  isProcessAlive,
  readRuntimeRecord,
  readToken,
  removeRuntimeRecord,
  runtimeUrl,
  type FactoryHome,
  type RuntimeRecord,
} from '@factory/home';

/** Thin HTTP client for the runtime API. The CLI never touches the database. */
export class RuntimeClient {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  async request(method: 'GET' | 'POST', path: string, timeoutMs = 5_000): Promise<Response> {
    return fetch(this.url + path, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async json<T>(method: 'GET' | 'POST', path: string, timeoutMs?: number): Promise<T> {
    const res = await this.request(method, path, timeoutMs);
    if (!res.ok) throw new Error(`${method} ${path} failed: HTTP ${String(res.status)}`);
    return (await res.json()) as T;
  }
}

export type RuntimeLookup =
  { kind: 'not_running' } | { kind: 'running'; record: RuntimeRecord; client: RuntimeClient };

/**
 * Finds the runtime for this home from its runtime record. A record whose
 * process is gone is stale and is removed.
 */
export function findRuntime(home: FactoryHome): RuntimeLookup {
  const record = readRuntimeRecord(home);
  if (record === undefined) return { kind: 'not_running' };
  if (!isProcessAlive(record.pid)) {
    removeRuntimeRecord(home);
    return { kind: 'not_running' };
  }
  const token = readToken(home);
  if (token === undefined) throw new Error(`no token in ${home.tokenPath}. Run: factory init`);
  return { kind: 'running', record, client: new RuntimeClient(runtimeUrl(record), token) };
}
