import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyHome, initializedHome } from '../support/factory.js';

describe('factory init', () => {
  it('creates the home and a private token, asking for the workspace root', async () => {
    const home = emptyHome();
    const res = await home.cli(['init'], { input: `${home.workspaceRoot}\n` });

    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('Workspace root');
    expect(statSync(home.dir).mode & 0o777).toBe(0o700);
    const tokenPath = join(home.dir, 'token');
    expect(statSync(tokenPath).mode & 0o777, 'token must be mode 0600').toBe(0o600);
    expect(home.token()).toMatch(/^[0-9a-f]{64}$/);
    expect(res.stdout, 'init must never print the token value').not.toContain(home.token());
    const config = JSON.parse(readFileSync(join(home.dir, 'config.json'), 'utf8')) as {
      workspaceRoot: string;
    };
    expect(config.workspaceRoot).toBe(home.workspaceRoot);
    expect(existsSync(home.workspaceRoot)).toBe(true);
  });

  it('defaults the workspace root when the answer is empty', async () => {
    const home = emptyHome();
    const res = await home.cli(['init'], { input: '\n' });
    expect(res.code, res.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(home.dir, 'config.json'), 'utf8')) as {
      workspaceRoot: string;
    };
    expect(config.workspaceRoot).toBe(join(home.dir, 'workspace'));
  });

  it('keeps the existing token when run again', async () => {
    const home = await initializedHome();
    const token = home.token();
    const res = await home.cli(['init', '--workspace-root', home.workspaceRoot]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('already initialized');
    expect(home.token()).toBe(token);
  });

  it('refuses to silently change the workspace root of an initialized home', async () => {
    const home = await initializedHome();
    const res = await home.cli(['init', '--workspace-root', '/somewhere/else']);
    expect(res.code, 'a different --workspace-root on re-init is an error').toBe(1);
    expect(res.stderr).toContain('refusing to change it');
    const config = JSON.parse(readFileSync(join(home.dir, 'config.json'), 'utf8')) as {
      workspaceRoot: string;
    };
    expect(config.workspaceRoot).toBe(home.workspaceRoot);
  });
});

describe('factory start / status / stop', () => {
  it('reports a background runtime started by the CLI, then stops it cleanly', async () => {
    const home = await initializedHome();
    try {
      const notYet = await home.cli(['status']);
      expect(notYet.code, 'status exits 3 when the runtime is not running').toBe(3);
      expect(notYet.stdout).toContain('not running');

      const started = await home.cli(['start']);
      expect(started.code, started.stderr).toBe(0);
      expect(started.stdout).toMatch(/Runtime started \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+/);

      const again = await home.cli(['start']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('already running');

      const running = await home.cli(['status']);
      expect(running.code, running.stderr).toBe(0);
      expect(running.stdout).toContain('Runtime: running');
      expect(running.stdout).toMatch(/url: +http:\/\/127\.0\.0\.1:\d+/);
      expect(running.stdout).toContain(home.workspaceRoot);

      const json = await home.cli(['status', '--json']);
      const body = JSON.parse(json.stdout) as { state: string; pid: number };
      expect(body.state).toBe('running');

      const stopped = await home.cli(['stop']);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain(`Runtime stopped (pid ${String(body.pid)})`);
      expect(existsSync(join(home.dir, 'runtime.json')), 'pidfile removed on stop').toBe(false);

      const after = await home.cli(['status']);
      expect(after.code).toBe(3);
    } finally {
      await home.cli(['stop']);
    }
  });

  it('refuses to start before init', async () => {
    const home = emptyHome();
    const res = await home.cli(['start']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('factory init');
  });
});
