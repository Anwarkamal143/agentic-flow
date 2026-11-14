import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_FLAGS } from '@factory/harness';
import { describe, expect, it } from 'vitest';
import {
  fakeBin,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tempDir,
  versionTool,
} from '../support/factory.js';

/** Real-world `--version` outputs, one per tool (gh prints two lines). */
const TOOLS = {
  node: versionTool('v22.14.0'),
  git: versionTool('git version 2.47.1'),
  gh: versionTool(
    'gh version 2.63.2 (2024-12-05)\nhttps://github.com/cli/cli/releases/tag/v2.63.2',
  ),
  // Lists every flag the Claude Code adapter passes, so it counts as usable (ADR-0013); no login.
  claude: versionTool(
    '2.1.4 (Claude Code)',
    `if [ "$1" = "--help" ]; then\n  printf '%s\\n' ${CLAUDE_CODE_FLAGS.map((f) => `'  ${f} <value>'`).join(' ')}\n  exit 0\nfi\nexit 1`,
  ),
};

describe('factory doctor', () => {
  it('lists Node, git, gh and Claude Code with their detected versions', async () => {
    const home = await initializedHome();
    await startRuntime(home, { env: { PATH: fakeBin(TOOLS) } });

    const res = await home.cli(['doctor']);

    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Node\.js +22\.14\.0/);
    expect(res.stdout).toMatch(/git +2\.47\.1/);
    expect(res.stdout).toMatch(/GitHub CLI +2\.63\.2/);
    expect(res.stdout).toMatch(/Claude Code +2\.1\.4/);
  });

  it('reports a tool missing from PATH and still exits cleanly', async () => {
    const home = await initializedHome();
    const withoutGh: Record<string, string> = { ...TOOLS };
    delete withoutGh['gh'];
    await startRuntime(home, { env: { PATH: fakeBin(withoutGh) } });

    const res = await home.cli(['doctor']);

    expect(res.code, 'missing tools are findings, not a failure of doctor').toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toMatch(/missing +GitHub CLI +not found/);
    expect(res.stdout).toContain('https://cli.github.com');
    expect(res.stdout).toMatch(/git +2\.47\.1/);

    const json = await home.cli(['doctor', '--json']);
    const body = JSON.parse(json.stdout) as { tools: { id: string; status: string }[] };
    expect(body.tools.find((t) => t.id === 'gh')?.status).toBe('missing');
    expect(body.tools.find((t) => t.id === 'claude')?.status).toBe('ok');
  });

  it('reports credential presence without ever revealing a value', async () => {
    const secret = 'sk-ant-DUMMY-' + 'x'.repeat(24) + '-do-not-leak';
    const ghSecret = 'ghp_DUMMY' + 'y'.repeat(30);
    const probeEnv = join(tempDir(), 'gh-probe-env');
    const bin = fakeBin({
      ...TOOLS,
      // A stored gh login, reported via `gh auth status`; records the env it was given.
      gh: versionTool(
        'gh version 2.63.2',
        `export -p > '${probeEnv}'\n[ "$1" = auth ] && exit 0\nexit 1`,
      ),
    });
    const home = await initializedHome();
    const rt = await startRuntime(home, {
      env: { PATH: bin, ANTHROPIC_API_KEY: secret, GH_TOKEN: ghSecret },
    });

    const res = await home.cli(['doctor']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/present +Claude API key \(ANTHROPIC_API_KEY\)/);
    expect(res.stdout).toMatch(/absent +Claude subscription token \(CLAUDE_CODE_OAUTH_TOKEN\)/);
    // Claude Code's stored login, by `claude auth status`'s exit code (this fake has none).
    expect(res.stdout).toMatch(/absent +Claude Code login \(claude auth status\)/);
    expect(res.stdout).toMatch(/present +GitHub token \(GH_TOKEN\)/);
    expect(res.stdout).toMatch(/absent +GitHub token \(GITHUB_TOKEN\)/);
    expect(res.stdout).toMatch(/present +GitHub CLI login \(gh auth status\)/);

    const api = await (await rt.request('/v1/doctor')).text();
    const json = await home.cli(['doctor', '--json']);
    const body = JSON.parse(json.stdout) as { credentials: { id: string; present: boolean }[] };
    expect(body.credentials.find((c) => c.id === 'anthropic_api_key')?.present).toBe(true);

    expect(readFileSync(probeEnv, 'utf8'), 'probes get no credentials').not.toContain(ghSecret);
    expect(await rt.stop()).toBe(0);
    const everything = [res.stdout, res.stderr, api, json.stdout, json.stderr, rt.output()];
    everything.push(...filesUnder(home.dir).map((f) => readFileSync(f, 'latin1')));
    for (const value of [secret, ghSecret]) {
      for (const text of everything) expect(text).not.toContain(value);
    }
  });

  it('reports whether an env: token reference resolves, never the token', async () => {
    const token = `fake-gh-access-${'z'.repeat(24)}`;
    const home = await initializedHome();
    patchFactoryConfig(home, { github: { token: 'env:GH_ACCESS' } });
    const rt = await startRuntime(home, { env: { PATH: fakeBin(TOOLS), GH_ACCESS: token } });

    const res = await home.cli(['doctor']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/GitHub \(https:\/\/api\.github\.com\):/);
    expect(res.stdout).toMatch(/resolves +token reference env:GH_ACCESS/);

    const json = await home.cli(['doctor', '--json']);
    const body = JSON.parse(json.stdout) as { github: unknown };
    expect(body.github).toEqual({
      tokenReference: 'env:GH_ACCESS',
      apiBaseUrl: 'https://api.github.com',
      resolves: true,
    });

    expect(await rt.stop()).toBe(0);
    const everything = [res.stdout, res.stderr, json.stdout, rt.output()];
    everything.push(...filesUnder(home.dir).map((f) => readFileSync(f, 'latin1')));
    for (const text of everything) expect(text).not.toContain(token);
  });

  it('says why a token reference does not resolve', async () => {
    const home = await initializedHome();
    patchFactoryConfig(home, {
      github: { token: 'env:GH_ACCESS', apiBaseUrl: 'http://127.0.0.1:9/api/v3' },
    });
    await startRuntime(home, { env: { PATH: fakeBin(TOOLS) } });

    const res = await home.cli(['doctor']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/GitHub \(http:\/\/127\.0\.0\.1:9\/api\/v3\):/);
    expect(res.stdout).toMatch(
      /does not resolve +token reference env:GH_ACCESS: GH_ACCESS is not set/,
    );
  });

  it('resolves the default gh reference with `gh auth token`, never showing it', async () => {
    const token = `gho_${'q'.repeat(36)}`;
    const bin = fakeBin({
      ...TOOLS,
      gh: versionTool(
        'gh version 2.63.2',
        `[ "$1 $2" = "auth token" ] && { printf '%s\\n' '${token}'; exit 0; }\nexit 1`,
      ),
    });
    const home = await initializedHome();
    const rt = await startRuntime(home, { env: { PATH: bin } });

    const res = await home.cli(['doctor']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/resolves +token reference gh/);
    expect(await rt.stop()).toBe(0);
    for (const text of [res.stdout, res.stderr, rt.output()]) expect(text).not.toContain(token);
  });

  it('asks for the runtime when it is not running', async () => {
    const home = await initializedHome();
    const res = await home.cli(['doctor']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('factory start');
  });
});

/** Every file under `dir`: the database, its WAL, logs, config. Read as bytes, not opened. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}
