/**
 * `factory repo profile detect | set` (ADR-0051, ADR-0060): re-detection shows
 * a diff against the saved profile and saves only once confirmed; `set` edits
 * one field. Each change is audited with its event, and a Job already created
 * keeps the profile values it froze.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJob, createProject, json, post, type EventBody } from '../support/api.js';
import { git, startRuntime, tinyTsRepo, type RunningRuntime } from '../support/factory.js';

interface ProfileBody {
  detection: string;
  commands: Record<string, { run: string; acceptsArgs: boolean }>;
  ciFiles: { path: string; checks: string[] }[];
  instructionFiles: string[];
  sensitivePaths: string[];
  requiredChecks?: string[];
  setup?: string;
  confirmedAt: string;
}
interface RepositoryBody {
  id: string;
  name: string;
  profile: ProfileBody;
}

async function registered(rt: RunningRuntime): Promise<{ repo: string; body: RepositoryBody }> {
  await createProject(rt);
  const repo = tinyTsRepo();
  const res = await rt.home.cli(['repo', 'add', repo, '--yes', '--setup', 'npm ci']);
  expect(res.code, res.stderr).toBe(0);
  const [body] = await json<[RepositoryBody]>(rt.request('/v1/repositories'));
  return { repo, body };
}

async function profile(rt: RunningRuntime): Promise<ProfileBody> {
  const [body] = await json<[RepositoryBody]>(rt.request('/v1/repositories'));
  return body.profile;
}

async function profileEvents(rt: RunningRuntime): Promise<EventBody[]> {
  return (await json<EventBody[]>(rt.request('/v1/events?limit=200'))).filter(
    (e) => e.type === 'repository.profile_updated',
  );
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '--all']);
  git(repo, ['commit', '--quiet', '--no-gpg-sign', '-m', 'change']);
}

describe('factory repo profile detect', () => {
  it('shows the diff, saves nothing unless confirmed, then saves and keeps the setup command', async () => {
    const rt = await startRuntime();
    const { repo, body } = await registered(rt);
    commit(repo, {
      'CLAUDE.md': '# rules\n',
      '.github/workflows/ci.yml': 'jobs:\n  build:\n    runs-on: ubuntu-latest\n',
    });

    const declined = await rt.home.cli(['repo', 'profile', 'detect', 'tiny-ts'], { input: 'n\n' });

    expect(declined.code).toBe(1);
    expect(declined.stderr).toContain('Nothing changed');
    expect(declined.stdout).toContain('instructionFiles:\n    - []\n    + ["CLAUDE.md"]');
    expect(declined.stdout).toContain('ciFiles:');
    expect(await profile(rt)).toEqual(body.profile);
    expect(await profileEvents(rt)).toEqual([]);

    const saved = await rt.home.cli(['repo', 'profile', 'detect', body.id, '--yes']);

    expect(saved.code, saved.stderr).toBe(0);
    const after = await profile(rt);
    expect(after).toMatchObject({
      detection: 'detected',
      ciFiles: [{ path: '.github/workflows/ci.yml', checks: ['build'] }],
      instructionFiles: ['CLAUDE.md'],
      setup: 'npm ci',
    });
    expect(after.sensitivePaths).toContain('CLAUDE.md');
    const [event] = await profileEvents(rt);
    expect(event).toMatchObject({
      entityKind: 'repository',
      entityId: body.id,
      actor: 'user:local',
      payload: { via: 'detect' },
    });
    expect((event?.payload.changes as { field: string }[]).map((c) => c.field)).toEqual([
      'ciFiles',
      'instructionFiles',
      'sensitivePaths',
    ]);

    const again = await rt.home.cli(['repo', 'profile', 'detect', 'tiny-ts']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('already matches');
  });

  it('refuses a confirmation over a profile changed since it was shown', async () => {
    const rt = await startRuntime();
    const { body } = await registered(rt);
    const detection = await json<{ detected: unknown; current: ProfileBody }>(
      post(rt, `/v1/repositories/${body.id}/profile/detect`, {}),
    );
    expect(
      (await rt.home.cli(['repo', 'profile', 'set', 'tiny-ts', 'commands.lint', 'npm run lint']))
        .code,
    ).toBe(0);

    const res = await post(rt, `/v1/repositories/${body.id}/profile/apply`, {
      detected: detection.detected,
      basis: detection.current.confirmedAt,
    });

    expect(res.status).toBe(409);
    expect(await json<{ error: string }>(res)).toMatchObject({ error: 'profile_changed' });
    expect((await profile(rt)).commands).toHaveProperty('lint');
  });
});

describe('factory repo profile set', () => {
  it('edits one field at a time, audited, and a Job already created keeps what it froze', async () => {
    const rt = await startRuntime();
    const { body } = await registered(rt);
    const job = await createJob(rt, body.id);

    const set = async (key: string, value: string) => {
      const res = await rt.home.cli(['repo', 'profile', 'set', 'tiny-ts', key, value]);
      expect(res.code, res.stderr).toBe(0);
      return res;
    };
    const lint = await set('commands.lint', 'npm run lint');
    expect(lint.stdout).toContain('commands:');
    expect(lint.stdout).toContain('"lint":{"run":"npm run lint","acceptsArgs":false}');
    await set('commands.test.acceptsArgs', 'true');
    await set('sensitivePaths', '["secrets/**"]');
    await set('setup', '');

    expect(await profile(rt)).toMatchObject({
      commands: {
        lint: { run: 'npm run lint', acceptsArgs: false },
        test: { run: 'npm test', acceptsArgs: true },
      },
      sensitivePaths: ['secrets/**'],
    });
    expect((await profile(rt)).setup).toBeUndefined();
    expect((await profileEvents(rt)).map((e) => e.payload.via)).toEqual([
      'set',
      'set',
      'set',
      'set',
    ]);

    const frozen = await json<{
      effectiveConfig: {
        repositories: {
          repositoryId: string;
          setup: { value: string | null };
          sensitivePaths: { value: string[] };
          commands: { value: Record<string, unknown> };
        }[];
      };
    }>(rt.request(`/v1/jobs/${job.id}`));
    const section = frozen.effectiveConfig.repositories.find((r) => r.repositoryId === body.id);
    expect(section?.setup.value).toBe('npm ci');
    expect(section?.sensitivePaths.value).toEqual(body.profile.sensitivePaths);
    expect(section?.commands.value).not.toHaveProperty('lint');
  });

  it('refuses an unknown key and an invalid value, changing nothing', async () => {
    const rt = await startRuntime();
    const { body } = await registered(rt);

    const unknown = await rt.home.cli(['repo', 'profile', 'set', 'tiny-ts', 'detection', 'x']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("unknown profile key 'detection'");
    const invalid = await rt.home.cli([
      'repo',
      'profile',
      'set',
      'tiny-ts',
      'sensitivePaths',
      'infra/**',
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain('JSON array');
    const missing = await rt.home.cli(['repo', 'profile', 'set', 'nope', 'setup', 'x']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('no Repository nope');

    expect(await profile(rt)).toEqual(body.profile);
    expect(await profileEvents(rt)).toEqual([]);
  });
});
