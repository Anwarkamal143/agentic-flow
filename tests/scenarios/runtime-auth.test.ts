import { describe, expect, it } from 'vitest';
import { startRuntime } from '../support/factory.js';

describe('runtime API requires the factory token', () => {
  it('rejects a request that carries no token', async () => {
    const rt = await startRuntime();
    const res = await rt.request('/v1/status', { token: null });
    expect(res.status, 'request without Authorization must be 401').toBe(401);
  });

  it('rejects a request that carries the wrong token', async () => {
    const rt = await startRuntime();
    const res = await rt.request('/v1/status', { token: 'f'.repeat(64) });
    expect(res.status, 'request with a wrong bearer token must be 401').toBe(401);
  });

  it('accepts the token stored in the factory home', async () => {
    const rt = await startRuntime();
    const res = await rt.request('/v1/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; pid: number };
    expect(body.state).toBe('running');
    expect(body.pid).toBe(rt.pid);
  });
});
