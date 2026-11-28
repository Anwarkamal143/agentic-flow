/**
 * The Factory Level (#96, ADR-0049, ADR-0056): factory-wide configuration in the
 * database, one row with a version. `factory config show | set` read and change
 * it through the runtime API, each change audited. An existing `config.json`
 * `concurrency.global` is copied once, on the first start, audited as
 * `system:migration`; later edits to the key have no effect.
 */
import { describe, expect, it } from 'vitest';
import { json, post, type EventBody } from '../support/api.js';
import {
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  type RunningRuntime,
} from '../support/factory.js';

interface FactoryLevelBody {
  config: { concurrency?: { global?: number } };
  version: number;
  updatedAt: string;
}

interface AuditBody {
  actor: string;
  action: string;
  target: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

async function cliOk(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

async function factoryEvents(rt: RunningRuntime): Promise<EventBody[]> {
  const events = await json<EventBody[]>(rt.request('/v1/events?limit=1000'));
  return events.filter((e) => e.entityKind === 'factory');
}

describe('factory config', () => {
  it('shows and sets the Factory Level through the runtime, versioned and audited', async () => {
    const rt = await startRuntime();

    const fresh = await json<FactoryLevelBody>(rt.request('/v1/factory/config'));
    expect(fresh).toMatchObject({ config: {}, version: 1 });
    const show = await cliOk(rt, ['config', 'show']);
    expect(show).toContain('Factory Level (version 1)');
    expect(show).toMatch(/concurrency\.global +3 +\(default\)/);

    const set = await cliOk(rt, ['config', 'set', 'concurrency.global', '5']);
    expect(set).toContain('concurrency.global = 5');
    expect(set).toContain('version 2');
    const after = await json<FactoryLevelBody>(rt.request('/v1/factory/config'));
    expect(after).toMatchObject({ config: { concurrency: { global: 5 } }, version: 2 });
    expect(await cliOk(rt, ['config', 'show'])).toMatch(/concurrency\.global +5 +\(factory\)/);

    const stale = await rt.home.cli([
      'config',
      'set',
      'concurrency.global',
      '4',
      '--expect-version',
      '1',
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('version');
    const tooWide = await rt.home.cli(['config', 'set', 'concurrency.global', '0']);
    expect(tooWide.code).toBe(1);
    expect(tooWide.stderr).toContain('concurrency.global');
    const unknown = await rt.home.cli(['config', 'set', 'colour', 'red']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown Factory Level config key 'colour'");
    const res = await post(rt, '/v1/factory/config/set', {
      key: 'concurrency.global',
      value: 2,
      expectedVersion: 2,
    });
    expect(res.status).toBe(200);
    expect(await json<FactoryLevelBody>(rt.request('/v1/factory/config'))).toMatchObject({
      config: { concurrency: { global: 2 } },
      version: 3,
    });

    const audit = await json<AuditBody[]>(rt.request('/v1/factory/config/audit'));
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'user:local',
        action: 'factory_config.set',
        target: 'factory',
        before: {},
        after: { concurrency: { global: 5 } },
      }),
      expect.objectContaining({
        actor: 'user:local',
        before: { concurrency: { global: 5 } },
        after: { concurrency: { global: 2 } },
      }),
    ]);
    const events = await factoryEvents(rt);
    expect(events.map((e) => [e.type, e.actor, e.payload['key'], e.payload['version']])).toEqual([
      ['factory.config_updated', 'user:local', 'concurrency.global', 2],
      ['factory.config_updated', 'user:local', 'concurrency.global', 3],
    ]);
  });

  it('copies config.json concurrency.global once, as system:migration; later edits have no effect', async () => {
    const home = await initializedHome();
    patchFactoryConfig(home, { concurrency: { global: 1 } });
    const first = await startRuntime(home);

    expect(await json<FactoryLevelBody>(first.request('/v1/factory/config'))).toMatchObject({
      config: { concurrency: { global: 1 } },
      version: 1,
    });
    const audit = await json<AuditBody[]>(first.request('/v1/factory/config/audit'));
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'system:migration',
        action: 'factory_config.migrated',
        target: 'factory',
        before: {},
        after: { concurrency: { global: 1 } },
      }),
    ]);
    expect((await factoryEvents(first)).map((e) => [e.type, e.actor])).toEqual([
      ['factory.config_updated', 'system:migration'],
    ]);

    expect(await first.stop()).toBe(0);
    patchFactoryConfig(home, { concurrency: { global: 6 } });
    const again = await startRuntime(home);

    expect(await json<FactoryLevelBody>(again.request('/v1/factory/config'))).toMatchObject({
      config: { concurrency: { global: 1 } },
      version: 1,
    });
    expect(await json<AuditBody[]>(again.request('/v1/factory/config/audit'))).toHaveLength(1);
    expect(await factoryEvents(again)).toHaveLength(1);
  });

  it('starts without a copy when config.json sets no concurrency.global', async () => {
    const rt = await startRuntime();
    expect(await json<AuditBody[]>(rt.request('/v1/factory/config/audit'))).toEqual([]);
    expect(await factoryEvents(rt)).toEqual([]);
  });
});
