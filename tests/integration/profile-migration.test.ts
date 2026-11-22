/**
 * Profiles from before Phase D (ADR-0051, ADR-0060). A Repository saved with a
 * v1 profile is read as v2 without detection: marked `not_detected`, its
 * commands named, the default Sensitive Paths applied. `factory doctor`
 * recommends `repo profile detect`, and re-detecting clears the warning.
 *
 * This tier is test-only: the test writes a v1 profile straight into the
 * database while the runtime is stopped, standing in for a database from
 * before this change. In production only the runtime writes the database.
 */
import { join } from 'node:path';
import { openDatabase, schema } from '@factory/db';
import { DEFAULT_SENSITIVE_PATHS } from '@factory/domain';
import { CLAUDE_CODE_FLAGS } from '@factory/harness';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createProject, json } from '../support/api.js';
import {
  fakeBin,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  versionTool,
} from '../support/factory.js';

/** Tools for `doctor` (as in the doctor scenario), so it never probes the real ones. */
const TOOLS = {
  node: versionTool('v22.14.0'),
  git: versionTool('git version 2.47.1'),
  gh: versionTool('gh version 2.63.2'),
  claude: versionTool(
    '2.1.4 (Claude Code)',
    `if [ "$1" = "--help" ]; then\n  printf '%s\\n' ${CLAUDE_CODE_FLAGS.map((f) => `'  ${f} <value>'`).join(' ')}\n  exit 0\nfi\nexit 1`,
  ),
};

interface RepositoryBody {
  id: string;
  profile: Record<string, unknown>;
}

interface DoctorBody {
  undetectedProfiles: { repositoryId: string; name: string; message: string }[];
}

describe('a v1 Repository Profile', () => {
  it('reads as v2 not detected with the default Sensitive Paths; doctor recommends re-detection', async () => {
    const home = await initializedHome();
    const first = await startRuntime(home);
    await createProject(first);
    const add = await home.cli(['repo', 'add', tinyTsRepo(), '--yes']);
    expect(add.code, add.stderr).toBe(0);
    const [repo] = await json<[RepositoryBody]>(first.request('/v1/repositories'));
    expect(await first.stop()).toBe(0);

    const v1 = {
      version: 1,
      packageManager: 'npm',
      commands: { test: 'npm test', typecheck: null },
      setup: 'npm ci',
      confirmedBy: 'user:local',
      confirmedAt: '2026-11-01T00:00:00.000Z',
    };
    const handle = openDatabase(join(home.dir, 'factory.db'));
    handle.db
      .update(schema.repositories)
      .set({ profileJson: JSON.stringify(v1) })
      .where(eq(schema.repositories.id, repo.id))
      .run();
    handle.close();

    const second = await startRuntime(home, { env: { PATH: fakeBin(TOOLS) } });
    const [upgraded] = await json<[RepositoryBody]>(second.request('/v1/repositories'));
    expect(upgraded.profile).toEqual({
      version: 2,
      detection: 'not_detected',
      packageManager: 'npm',
      commands: { test: { run: 'npm test', acceptsArgs: false } },
      ciFiles: [],
      instructionFiles: [],
      sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
      setup: 'npm ci',
      confirmedBy: 'user:local',
      confirmedAt: '2026-11-01T00:00:00.000Z',
    });

    const doctor = await home.cli(['doctor']);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain('Repository Profiles (never detected');
    expect(doctor.stdout).toContain('`factory repo profile detect tiny-ts`');
    const body = JSON.parse((await home.cli(['doctor', '--json'])).stdout) as DoctorBody;
    expect(body.undetectedProfiles.map((p) => p.repositoryId)).toEqual([repo.id]);
    expect(await second.stop()).toBe(0);

    // Re-detection needs the real git; afterwards the profile is detected and doctor is quiet.
    const third = await startRuntime(home);
    const detect = await home.cli(['repo', 'profile', 'detect', 'tiny-ts', '--yes']);
    expect(detect.code, detect.stderr).toBe(0);
    expect(detect.stdout).toContain('detection:\n    - not_detected\n    + detected');
    const [redetected] = await json<[RepositoryBody]>(third.request('/v1/repositories'));
    expect(redetected.profile).toMatchObject({
      detection: 'detected',
      commands: {
        test: { run: 'npm test', acceptsArgs: false },
        typecheck: { run: 'npm run typecheck', acceptsArgs: false },
      },
      setup: 'npm ci',
    });
    expect(await third.stop()).toBe(0);

    const fourth = await startRuntime(home, { env: { PATH: fakeBin(TOOLS) } });
    const quiet = JSON.parse((await home.cli(['doctor', '--json'])).stdout) as DoctorBody;
    expect(quiet.undetectedProfiles).toEqual([]);
    expect(await fourth.stop()).toBe(0);
  });
});
