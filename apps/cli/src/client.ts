import { ApiErrorSchema, type ApiError } from '@factory/domain';
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

  async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { timeoutMs?: number; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(this.url + path, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  }

  /** Sends a request and returns the JSON body; a non-2xx response throws {@link ApiRequestError}. */
  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { timeoutMs?: number; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.request(method, path, opts);
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => undefined));
      throw new ApiRequestError(method, path, res.status, parsed.success ? parsed.data : undefined);
    }
    return (await res.json()) as T;
  }
}

export class ApiRequestError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    readonly body: ApiError | undefined,
  ) {
    super(
      body?.message ??
        `${method} ${path} failed: HTTP ${String(status)}${body ? ` (${body.error})` : ''}`,
    );
    this.name = 'ApiRequestError';
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
