/**
 * `factory config export | import` (#113, ADR-0049, ADR-0073): the Factory
 * Level, Projects and Repositories as YAML keyed by name, with no token values.
 * An import prints its diff and changes nothing; `--apply --expect-version`
 * applies exactly that diff in one transaction, with one `config.imported`
 * event and one audit row holding the diff. It may create Projects, refuses
 * unregistered Repositories and a level wider than its parent, and flags a
 * widening at the level's own level.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createProject, json, type EventBody } from '../support/api.js';
import { startRuntime, tempDir, tinyTsRepo, type RunningRuntime } from '../support/factory.js';

interface ExportBody {
  configVersion: number;
  document: {
    format: string;
    factory: Record<string, unknown>;
    projects: Record<
      string,
      {
        config: Record<string, unknown>;
        repositories: Record<
          string,
          Record<string, unknown> & { profile: Record<string, unknown> }
        >;
      }
    >;
  };
}

interface AuditBody {
  actor: string;
  action: string;
  target: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const SECRET = 'deploy-secret-value-0123456789';

async function cliOk(rt: RunningRuntime, args: string[]): Promise<string> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

/** A Factory with Project `demo` and Repository `tiny-ts`, and a secret in the runtime's environment. */
async function factory(): Promise<RunningRuntime> {
  const rt = await startRuntime(undefined, { env: { DEPLOY_TOKEN: SECRET } });
  await createProject(rt);
  await cliOk(rt, ['repo', 'add', tinyTsRepo(), '--yes', '--setup', `npm ci --token ${SECRET}`]);
  await cliOk(rt, ['config', 'set', 'concurrency.global', '4']);
  await cliOk(rt, ['project', 'config', 'set', 'demo', 'maxAttempts', '2']);
  return rt;
}

async function exported(rt: RunningRuntime): Promise<{ yaml: string; file: string }> {
  const yaml = await cliOk(rt, ['config', 'export']);
  const file = join(tempDir('config-export-'), 'factory.yaml');
  writeFileSync(file, yaml);
  return { yaml, file };
}

function edit(file: string, change: (doc: ExportBody['document']) => void): string {
  const doc = YAML.parse(readFileSync(file, 'utf8')) as ExportBody['document'];
  change(doc);
  const out = join(tempDir('config-import-'), 'edited.yaml');
  writeFileSync(out, YAML.stringify(doc));
  return out;
}

async function importEvents(rt: RunningRuntime): Promise<EventBody[]> {
  const events = await json<EventBody[]>(rt.request('/v1/events?limit=1000'));
  return events.filter((e) => e.type === 'config.imported');
}

describe('factory config export', () => {
  it('writes YAML keyed by name with no token values, and round-trips to an empty diff', async () => {
    const rt = await factory();

    const { yaml, file } = await exported(rt);

    const doc = YAML.parse(yaml) as ExportBody['document'];
    expect(doc.format).toBe('factory-config@1');
    expect(doc.factory).toEqual({ concurrency: { global: 4 } });
    expect(doc.projects['demo']?.config).toEqual({ maxAttempts: 2 });
    expect(doc.projects['demo']?.repositories['tiny-ts']).toMatchObject({
      mergePolicy: 'never_auto',
      mergeMethod: 'merge',
      intakeLabel: null,
      profile: { sensitivePaths: expect.arrayContaining(['.env*']) as unknown },
    });
    expect(yaml).not.toContain(SECRET);
    expect(yaml).not.toContain(rt.home.token());
    expect(yaml).toContain('[REDACTED');

    const again = await cliOk(rt, ['config', 'import', file]);
    expect(again).toMatch(/^No changes: .* matches the configuration \(version \d+\)\.$/m);
    const applied = await cliOk(rt, [
      'config',
      'import',
      file,
      '--apply',
      '--expect-version',
      String((await json<ExportBody>(rt.request('/v1/config/export'))).configVersion),
    ]);
    expect(applied).toContain('No changes');
    expect(await importEvents(rt)).toEqual([]);
  });
});

describe('factory config import', () => {
  it('prints the diff only, then applies it atomically and audited; a stale version is refused', async () => {
    const rt = await factory();
    const { file } = await exported(rt);
    const before = await json<ExportBody>(rt.request('/v1/config/export'));
    const edited = edit(file, (doc) => {
      doc.factory = { concurrency: { global: 6 } };
      const demo = doc.projects['demo'];
      if (demo === undefined) throw new Error('no demo');
      demo.config = { maxAttempts: 3, planApproval: 'skip' };
      const repo = demo.repositories['tiny-ts'];
      if (repo === undefined) throw new Error('no tiny-ts');
      repo['mergeMethod'] = 'squash';
      repo.profile['requiredChecks'] = ['ci'];
      doc.projects['web'] = { config: { maxRetries: 1 }, repositories: {} };
    });

    const diff = await cliOk(rt, ['config', 'import', edited]);

    const v = String(before.configVersion);
    expect(diff).toContain(`7 change(s) against configuration version ${v}:`);
    expect(diff).toContain('  Factory Level: concurrency.global: 4 -> 6');
    expect(diff).toContain('  Project demo: maxAttempts: 2 -> 3');
    expect(diff).toContain(
      '  Project demo: planApproval: (unset) -> "skip"  [widens a permission value at its own level]',
    );
    expect(diff).toContain('  Repository demo/tiny-ts: mergeMethod: "merge" -> "squash"');
    expect(diff).toContain('  Repository demo/tiny-ts: profile.requiredChecks: (unset) -> ["ci"]');
    expect(diff).toContain('  + Project web (created)');
    expect(diff).toContain('  Project web: maxRetries: (unset) -> 1');
    expect(diff).toContain(`--apply --expect-version ${v}`);
    expect(await json<ExportBody>(rt.request('/v1/config/export'))).toEqual(before);

    const noVersion = await rt.home.cli(['config', 'import', edited, '--apply']);
    expect(noVersion.code).toBe(2);
    expect(noVersion.stderr).toContain('--expect-version');

    // A change after the diff was shown makes its version stale.
    await cliOk(rt, ['project', 'config', 'set', 'demo', 'maxQuestions', '1']);
    const stale = await rt.home.cli(['config', 'import', edited, '--apply', '--expect-version', v]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`not ${v}`);
    const current = await json<ExportBody>(rt.request('/v1/config/export'));
    expect(current.configVersion).toBe(before.configVersion + 1);
    expect(current.document.projects['web']).toBeUndefined();
    expect(current.document.factory).toEqual({ concurrency: { global: 4 } });

    const fresh = await cliOk(rt, ['config', 'import', edited]);
    expect(fresh).toContain('  Project demo: maxQuestions: 1 -> (unset)');
    const applied = await cliOk(rt, [
      'config',
      'import',
      edited,
      '--apply',
      '--expect-version',
      String(current.configVersion),
    ]);

    expect(applied).toContain(
      `Applied 8 change(s) in one transaction (configuration version ${String(current.configVersion + 1)}):`,
    );
    const after = await json<ExportBody>(rt.request('/v1/config/export'));
    expect(after.configVersion).toBe(current.configVersion + 1);
    expect(after.document.factory).toEqual({ concurrency: { global: 6 } });
    expect(after.document.projects['demo']?.config).toEqual({
      maxAttempts: 3,
      planApproval: 'skip',
    });
    expect(after.document.projects['demo']?.repositories['tiny-ts']?.['mergeMethod']).toBe(
      'squash',
    );
    expect(after.document.projects['demo']?.repositories['tiny-ts']?.profile).toMatchObject({
      requiredChecks: ['ci'],
      setup: expect.stringContaining('npm ci') as unknown,
    });
    expect(after.document.projects['web']).toEqual({ config: { maxRetries: 1 }, repositories: {} });
    expect(await cliOk(rt, ['project', 'list'])).toContain('web');
    expect(await cliOk(rt, ['config', 'show'])).toMatch(/concurrency\.global +6 +\(factory\)/);
    expect(await cliOk(rt, ['config', 'import', edited])).toContain('No changes');

    const events = await importEvents(rt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'user:local', entityKind: 'factory' });
    expect(events[0]?.payload['changes']).toHaveLength(8);
    const audit = await json<AuditBody[]>(rt.request('/v1/config/audit'));
    expect(audit).toEqual([
      expect.objectContaining({
        actor: 'user:local',
        action: 'config.imported',
        target: 'config',
        before: { configVersion: current.configVersion },
      }),
    ]);
    expect(audit[0]?.after['changes']).toEqual(events[0]?.payload['changes']);
    expect(audit[0]?.after['changes']).toContainEqual({
      kind: 'set',
      level: 'project',
      project: 'demo',
      repository: null,
      key: 'planApproval',
      from: null,
      to: 'skip',
      widens: true,
    });
  });

  it('refuses unregistered Repositories, widenings below the parent and invalid documents, changing nothing', async () => {
    const rt = await factory();
    const { file } = await exported(rt);
    const before = await json<ExportBody>(rt.request('/v1/config/export'));

    const unregistered = edit(file, (doc) => {
      const repo = doc.projects['demo']?.repositories['tiny-ts'];
      if (repo === undefined) throw new Error('no tiny-ts');
      doc.projects['web'] = { config: {}, repositories: { 'tiny-ts': repo } };
    });
    for (const args of [[], ['--apply', '--expect-version', String(before.configVersion)]]) {
      const res = await rt.home.cli(['config', 'import', unregistered, ...args]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain(
        "Repository 'tiny-ts' is not registered in Project 'web' (it is registered in Project 'demo')",
      );
    }

    const wider = edit(file, (doc) => {
      doc.factory['mergePolicy'] = 'never_auto';
      const repo = doc.projects['demo']?.repositories['tiny-ts'];
      if (repo === undefined) throw new Error('no tiny-ts');
      repo['mergePolicy'] = 'human_approval';
    });
    const widened = await rt.home.cli([
      'config',
      'import',
      wider,
      '--apply',
      '--expect-version',
      String(before.configVersion),
    ]);
    expect(widened.code).toBe(1);
    expect(widened.stderr).toContain(
      "Repository 'tiny-ts' sets mergePolicy human_approval, wider than its parent: the Factory Level sets never_auto",
    );

    const invalid = edit(file, (doc) => {
      doc.factory['colour'] = 'red';
    });
    const bad = await rt.home.cli(['config', 'import', invalid]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('factory');
    expect(bad.stderr).toContain('colour');

    const notYaml = join(tempDir('config-import-'), 'bad.yaml');
    writeFileSync(notYaml, 'factory: [unclosed\n');
    const unreadable = await rt.home.cli(['config', 'import', notYaml]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toContain('cannot read');

    expect(await json<ExportBody>(rt.request('/v1/config/export'))).toEqual(before);
    expect(await importEvents(rt)).toEqual([]);
    expect(await json<AuditBody[]>(rt.request('/v1/config/audit'))).toEqual([]);
  });
});
