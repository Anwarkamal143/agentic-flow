import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, startRuntime, tinyTsRepo } from '../support/factory.js';

interface RepositoryBody {
  id: string;
  projectId: string;
  name: string;
  source: string;
  remoteUrl: string | null;
  clonePath: string;
  defaultBranch: string;
  profile: { commands: { test: string | null; typecheck: string | null } };
}

describe('factory repo add', () => {
  it('registers a Project and a Repository, with a Factory Clone made from the path', async () => {
    const rt = await startRuntime();
    const repo = tinyTsRepo();

    const res = await rt.home.cli(['repo', 'add', repo, '--project', 'demo'], { input: 'y\n' });

    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/test: +npm test/);
    expect(res.stdout).toMatch(/typecheck: +npm run typecheck/);

    const projects = (await (await rt.request('/v1/projects')).json()) as {
      id: string;
      name: string;
    }[];
    expect(projects.map((p) => p.name)).toEqual(['demo']);

    const repos = (await (await rt.request('/v1/repositories')).json()) as RepositoryBody[];
    expect(repos).toHaveLength(1);
    const [registered] = repos as [RepositoryBody];
    expect(registered).toMatchObject({
      projectId: projects[0]?.id,
      name: 'tiny-ts',
      source: repo,
      remoteUrl: null,
      defaultBranch: 'main',
      profile: { commands: { test: 'npm test', typecheck: 'npm run typecheck' } },
    });
    expect(registered.clonePath).toBe(join(rt.home.workspaceRoot, 'clones', registered.id));
    expect(git(registered.clonePath, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(res.stdout).toContain(registered.clonePath);
  });

  it('clones from origin, reusing local objects, and never writes to the source checkout', async () => {
    const rt = await startRuntime();
    const repo = tinyTsRepo();
    const instructions = {
      'CLAUDE.md': '# Rules\n\nKeep it small.\n',
      'AGENTS.md': 'agents: be careful\r\n',
    };
    for (const [file, text] of Object.entries(instructions)) writeFileSync(join(repo, file), text);
    git(repo, ['add', '--all']);
    git(repo, ['commit', '--quiet', '--no-gpg-sign', '-m', 'add instructions']);

    // origin is a bare copy that has lost one object the local checkout still has:
    // the clone can only succeed by borrowing it from the local objects.
    const origin = join(dirname(repo), 'origin.git');
    git(dirname(repo), ['clone', '--quiet', '--bare', repo, origin]);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['fetch', '--quiet', 'origin']);
    const blob = git(repo, ['rev-parse', 'HEAD:src/math.ts']).trim();
    const loose = join(origin, 'objects', blob.slice(0, 2), blob.slice(2));
    expect(existsSync(loose), 'test setup: the blob is a loose object in origin').toBe(true);
    rmSync(loose);

    // Work in progress the factory must not touch.
    writeFileSync(join(repo, 'src', 'math.ts'), '// uncommitted edit\n', { flag: 'a' });
    writeFileSync(join(repo, 'notes.txt'), 'untracked\n');
    const before = snapshot(repo);

    const res = await rt.home.cli(['repo', 'add', repo, '--yes']);

    expect(res.code, res.stderr).toBe(0);
    const [registered] = (await (await rt.request('/v1/repositories')).json()) as [RepositoryBody];
    expect(registered.remoteUrl).toBe(origin);
    expect(git(registered.clonePath, ['remote', 'get-url', 'origin']).trim()).toBe(origin);
    expect(git(registered.clonePath, ['rev-parse', 'HEAD']).trim()).toBe(
      git(repo, ['rev-parse', 'HEAD']).trim(),
    );
    expect(git(registered.clonePath, ['cat-file', '-t', blob]).trim()).toBe('blob');
    expect(
      existsSync(join(registered.clonePath, '.git', 'objects', 'info', 'alternates')),
      'the clone must not keep depending on the source checkout',
    ).toBe(false);

    const after = snapshot(repo);
    expect(after.workingTree, 'working tree').toEqual(before.workingTree);
    expect(after.branches, 'git branch -a').toBe(before.branches);
    expect(after.worktrees, 'git worktree list').toBe(before.worktrees);
    expect(after.config, '.git/config').toBe(before.config);
    expect(after.gitDir, 'nothing under .git changed').toEqual(before.gitDir);
    for (const [file, text] of Object.entries(instructions)) {
      expect(readFileSync(join(repo, file), 'utf8'), `${file} byte-identical`).toBe(text);
    }
  });

  it('refuses an origin URL with embedded credentials, never showing them', async () => {
    const rt = await startRuntime();
    const repo = tinyTsRepo();
    const token = 'ghp_DUMMY' + 'z'.repeat(30);
    git(repo, ['remote', 'add', 'origin', `https://${token}@example.invalid/acme/tiny-ts.git`]);

    const res = await rt.home.cli(['repo', 'add', repo, '--yes']);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('embedded credentials');
    expect(res.stdout + res.stderr).not.toContain(token);
    expect(await (await rt.request('/v1/repositories')).json()).toEqual([]);
    expect(rt.output()).not.toContain(token);
  });

  it('saves a relative origin as the absolute location it was cloned from', async () => {
    const rt = await startRuntime();
    const repo = tinyTsRepo();
    const origin = join(dirname(repo), 'upstream.git');
    git(dirname(repo), ['clone', '--quiet', '--bare', repo, origin]);
    git(repo, ['remote', 'add', 'origin', '../upstream.git']);

    const res = await rt.home.cli(['repo', 'add', repo, '--yes']);

    expect(res.code, res.stderr).toBe(0);
    const [registered] = (await (await rt.request('/v1/repositories')).json()) as [RepositoryBody];
    expect(registered.remoteUrl).toBe(origin);
    expect(git(registered.clonePath, ['remote', 'get-url', 'origin']).trim()).toBe(origin);
  });

  it('saves nothing when the detected commands are not confirmed', async () => {
    const rt = await startRuntime();
    const repo = tinyTsRepo();

    const res = await rt.home.cli(['repo', 'add', repo], { input: 'n\n' });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Nothing registered');
    expect(await (await rt.request('/v1/repositories')).json()).toEqual([]);
    expect(await (await rt.request('/v1/projects')).json()).toEqual([]);
    expect(existsSync(join(rt.home.workspaceRoot, 'clones'))).toBe(false);
  });

  it('saves operator-supplied commands in place of the detected ones', async () => {
    const rt = await startRuntime();
    const res = await rt.home.cli([
      'repo',
      'add',
      tinyTsRepo(),
      '--yes',
      '--typecheck-command',
      'npx tsc -p .',
      '--test-command',
      '',
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/typecheck: +npx tsc -p \. \(from --typecheck-command\)/);
    const [registered] = (await (await rt.request('/v1/repositories')).json()) as [RepositoryBody];
    expect(registered.profile.commands).toEqual({ test: null, typecheck: 'npx tsc -p .' });
  });

  it('refuses a path that is not a git repository, and a second registration', async () => {
    const rt = await startRuntime();
    const notRepo = await rt.home.cli(['repo', 'add', rt.home.workspaceRoot, '--yes']);
    expect(notRepo.code).toBe(1);
    expect(notRepo.stderr).toContain('is not inside a git working tree');

    const repo = tinyTsRepo();
    expect((await rt.home.cli(['repo', 'add', repo, '--yes'])).code).toBe(0);
    const again = await rt.home.cli(['repo', 'add', join(repo, 'src'), '--yes']);
    expect(again.code, 'a subdirectory resolves to the same Repository').toBe(1);
    expect(again.stderr).toContain('already registered');
    expect(await (await rt.request('/v1/repositories')).json()).toHaveLength(1);
    expect(readdirSync(join(rt.home.workspaceRoot, 'clones')), 'no stray clone left').toHaveLength(
      1,
    );
  });
});

/** Everything about a checkout that registration must leave untouched. */
function snapshot(repo: string) {
  const files = listFiles(repo);
  const digest = (paths: string[]) =>
    Object.fromEntries(
      paths.map((p) => [
        relative(repo, p),
        createHash('sha256').update(readFileSync(p)).digest('hex'),
      ]),
    );
  const gitDir = join(repo, '.git');
  return {
    workingTree: digest(files.filter((f) => !f.startsWith(gitDir + '/'))),
    gitDir: digest(files.filter((f) => f.startsWith(gitDir + '/'))),
    branches: git(repo, ['branch', '-a']),
    worktrees: git(repo, ['worktree', 'list']),
    config: readFileSync(join(gitDir, 'config'), 'utf8'),
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}
