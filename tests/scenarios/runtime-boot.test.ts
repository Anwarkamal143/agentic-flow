import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { emptyHome, startRuntime } from '../support/factory.js';

interface Status {
  state: string;
  host: string;
  workspaceRoot: string;
  database: { journalMode: string; migrations: number };
}

function nonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('runtime boot', () => {
  it('listens on 127.0.0.1 only', async () => {
    const rt = await startRuntime();
    expect(rt.host).toBe('127.0.0.1');
    expect(await canConnect('127.0.0.1', rt.port)).toBe(true);
    const external = nonLoopbackIPv4();
    if (external !== undefined) {
      expect(
        await canConnect(external, rt.port),
        `runtime must not accept connections on ${external}`,
      ).toBe(false);
    }
  });

  it('applies its migrations to a WAL-mode database on first boot', async () => {
    const rt = await startRuntime();
    const status = (await (await rt.request('/v1/status')).json()) as Status;
    expect(status.database.journalMode).toBe('wal');
    expect(status.database.migrations).toBeGreaterThanOrEqual(1);
    expect(status.workspaceRoot).toBe(rt.home.workspaceRoot);
  });

  it('restarts against the same home without re-applying migrations', async () => {
    const first = await startRuntime();
    const before = (await (await first.request('/v1/status')).json()) as Status;
    expect(await first.stop(), 'runtime exits 0 on SIGTERM').toBe(0);

    const second = await startRuntime(first.home);
    const after = (await (await second.request('/v1/status')).json()) as Status;
    expect(after.database.migrations).toBe(before.database.migrations);
  });

  it('refuses to start against a home that was never initialized', async () => {
    await expect(startRuntime(emptyHome())).rejects.toThrow(/not initialized/);
  });
});
