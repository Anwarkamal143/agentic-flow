import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tempDir,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import { json, post, waitForJob, type EventBody, type JobBody } from '../support/api.js';
import { scriptWith, SUM_SOURCE, validTaskResponse, VALID_SCRIPT } from '../support/scripts.js';

interface WorktreeBody {
  id: string;
  taskId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseSha: string;
  state: string;
  portBase: number | null;
}

interface EvidenceBody {
  id: string;
  kind: string;
  criterionCode: string | null;
  verificationKey: string | null;
  verdict: string;
  headSha: string;
  baseSha: string;
}

interface VerificationRunBody {
  id: string;
  key: string;
  command: string;
  exitCode: number | null;
  headSha: string;
  baseSha: string;
  outputArtifactId: string;
}

interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  state: string;
  exitReason: string | null;
  harness: { id: string; version: string | null };
  promptTemplate: { id: string; hash: string };
  baseSha: string;
  headSha: string | null;
  commits: string[];
  wipCommit: string | null;
  protocolViolations: { rule: string; message: string }[];
  usage: { tag: string } | null;
  worktreeId: string;
  verificationRuns: VerificationRunBody[];
  evidence: EvidenceBody[];
}

interface ArtifactBody {
  id: string;
  kind: string;
  taskId: string | null;
  attemptId: string | null;
}

interface DeliveryReport {
  job: { id: string; title: string };
  repository: { name: string; clonePath: string };
  tasks: {
    key: string;
    branch: string;
    baseSha: string;
    headSha: string;
    fetchCommand: string;
    commits: { sha: string; subject: string }[];
    changedFiles: string[];
    wipCommit: string | null;
    criteria: { code: string; mandatory: boolean; verdict: string }[];
  }[];
  knownLimitations: string[];
}

const done = (job: JobBody) => ['completed', 'failed', 'cancelled'].includes(job.status);

/** A runtime with the Fake Harness on `script`, a registered `tiny-ts`, and its source path. */
async function executionRuntime(script: string, env?: NodeJS.ProcessEnv) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home, env === undefined ? undefined : { env });
  const source = tinyTsRepo();
  const res = await rt.home.cli(['repo', 'add', source, '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; clonePath: string }]>(rt.request('/v1/repositories'));
  return { rt, repo, source };
}

async function runJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', {
    repositoryId,
    title: 'Add sum() to math.ts',
    description: 'Export sum(a, b) from src/math.ts.',
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as JobBody;
  return waitForJob(rt, created.id, done, 20_000);
}

async function attemptsOf(rt: RunningRuntime, jobId: string) {
  return json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
}

describe('Task execution in a Worktree, verified by the factory, delivered locally', () => {
  it('runs the ready Task, verifies it itself, and completes the Job with a Delivery Report', async () => {
    const { rt, repo, source } = await executionRuntime(VALID_SCRIPT);
    const before = snapshot(source);

    const job = await runJob(rt, repo.id);

    expect(job.stageRuns.map((s) => [s.stageId, s.state])).toEqual([
      ['intake', 'succeeded'],
      ['triage', 'succeeded'],
      ['discovery', 'succeeded'],
      ['specification', 'succeeded'],
      ['planning', 'succeeded'],
      ['execution', 'succeeded'],
      ['closure', 'succeeded'],
    ]);
    expect(job.status).toBe('completed');
    const [task] = await json<[{ id: string; key: string; state: string }]>(
      rt.request(`/v1/jobs/${job.id}/tasks`),
    );
    expect(task.state).toBe('approved');

    // The Worktree and Task Branch: in the Factory Clone only, with the expected name.
    const [worktree] = await json<[WorktreeBody]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(worktree.branch).toBe(`factory/${job.id}/${task.id}-add-sum`);
    expect(worktree.path.startsWith(rt.home.workspaceRoot + '/')).toBe(true);
    expect(git(repo.clonePath, ['branch', '--list', 'factory/*']).trim()).toBe(worktree.branch);
    expect(git(source, ['branch', '-a'])).not.toContain('factory/');

    // The Attempt: what ran, against which commits, at what cost.
    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    const head = git(repo.clonePath, ['rev-parse', worktree.branch]).trim();
    const base = git(repo.clonePath, ['rev-parse', 'main']).trim();
    expect(attempt).toMatchObject({
      n: 1,
      state: 'passed',
      exitReason: 'completed',
      harness: { id: 'fake', version: '1' },
      baseSha: base,
      headSha: head,
      wipCommit: null,
      usage: { tag: 'unknown' },
      worktreeId: worktree.id,
    });
    expect(attempt.promptTemplate.id).toBe('task-packet@1');
    expect(attempt.promptTemplate.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(git(repo.clonePath, ['show', `${head}:src/math.ts`])).toBe(SUM_SOURCE);

    // Evidence: the factory's own runs, with exit codes, tied to (head, base).
    expect(attempt.verificationRuns.map((v) => [v.key, v.exitCode])).toEqual([
      ['test', 0],
      ['typecheck', 0],
    ]);
    for (const e of attempt.evidence) expect([e.headSha, e.baseSha]).toEqual([head, base]);
    for (const v of attempt.verificationRuns) expect([v.headSha, v.baseSha]).toEqual([head, base]);
    expect(
      attempt.evidence.map((e) => [e.kind, e.verificationKey ?? e.criterionCode, e.verdict]),
    ).toEqual([
      ['verification', 'test', 'pass'],
      ['verification', 'typecheck', 'pass'],
      ['criterion', 'AC-01', 'pass'],
    ]);
    const typecheck = attempt.verificationRuns.find((v) => v.key === 'typecheck');
    const log = await json<{ output: string; exitCode: number }>(
      rt.request(`/v1/artifacts/${String(typecheck?.outputArtifactId)}/content`),
    );
    expect(log).toMatchObject({ exitCode: 0, output: 'typecheck ok\n' });

    // The Delivery Report: clone path, branch, and a fetch command that works from the source.
    const artifacts = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    const reportArtifact = artifacts.find((a) => a.kind === 'report');
    expect(artifacts.find((a) => a.kind === 'task_result')?.attemptId).toBe(attempt.id);
    const report = await json<DeliveryReport>(
      rt.request(`/v1/artifacts/${String(reportArtifact?.id)}/content`),
    );
    expect(report.repository).toMatchObject({ name: 'tiny-ts', clonePath: repo.clonePath });
    const [delivered] = report.tasks;
    expect(delivered).toMatchObject({
      key: 'add-sum',
      branch: worktree.branch,
      baseSha: base,
      headSha: head,
      changedFiles: ['src/math.ts'],
      commits: [{ sha: head, subject: 'Add sum() to math.ts' }],
      criteria: [{ code: 'AC-01', mandatory: true, verdict: 'pass' }],
    });
    expect(report.knownLimitations.join('\n')).toMatch(/not .*review/i);

    // The Worktree went active → preserved → removed, and was removed only after delivery.
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const seq = (type: string) => events.find((e) => e.type === type)?.seq ?? -1;
    const lifecycle = events
      .filter((e) => e.type.startsWith('worktree.'))
      .map((e) => [e.type, e.payload['to']]);
    expect(lifecycle).toEqual([
      ['worktree.created', 'active'],
      ['worktree.preserved', 'preserved'],
      ['worktree.removed', 'removed'],
    ]);
    const reportCreated = events.find(
      (e) => e.type === 'artifact.created' && e.payload['kind'] === 'report',
    );
    expect(seq('worktree.removed')).toBeGreaterThan(reportCreated?.seq ?? Infinity);
    expect(seq('job.status_changed')).toBeGreaterThan(0);
    expect(worktree.state).toBe('removed');
    expect(git(repo.clonePath, ['worktree', 'list'])).not.toContain(worktree.path);

    // The source repo is unchanged (the same checks as registration).
    const after = snapshot(source);
    expect(after.workingTree, 'working tree').toEqual(before.workingTree);
    expect(after.branches, 'git branch -a').toBe(before.branches);
    expect(after.worktrees, 'git worktree list').toBe(before.worktrees);
    expect(after.config, '.git/config').toBe(before.config);

    // Then the fetch command, run from the source repo, brings the result in.
    execFileSync('sh', ['-c', delivered?.fetchCommand ?? 'false'], { cwd: source, stdio: 'pipe' });
    expect(git(source, ['rev-parse', worktree.branch]).trim()).toBe(head);
  });

  it('discovers commits from git, never from the Task Result list', async () => {
    const response = validTaskResponse();
    response.steps.push(
      { write: { path: 'test/sum.test.ts', content: '// sum test\n' } },
      { commit: 'Test sum()' },
    );
    response.result['commits'] = ['0123456789abcdef0123456789abcdef01234567'];
    const { rt, repo } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }));

    const job = await runJob(rt, repo.id);

    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    const log = git(repo.clonePath, [
      'log',
      '--format=%H %s',
      `${attempt.baseSha}..${String(attempt.headSha)}`,
    ]);
    expect(attempt.commits).toEqual(
      log
        .trim()
        .split('\n')
        .map((l) => l.split(' ')[0]),
    );
    expect(log).toContain('Test sum()');
    expect(attempt.commits).toHaveLength(2);
    expect(attempt.protocolViolations).toEqual([
      {
        rule: 'result.commits_exist',
        message: expect.stringContaining('0123456789abcdef0123456789abcdef01234567') as string,
      },
    ]);
  });

  it('commits uncommitted leftovers as a flagged WIP commit; nothing is discarded', async () => {
    const response = validTaskResponse();
    response.steps.push(
      { write: { path: 'test/leftover.test.ts', content: '// not committed\n' } },
      { write: { path: 'src/math.ts', content: SUM_SOURCE + '// edited after the commit\n' } },
    );
    const { rt, repo } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }));

    const job = await runJob(rt, repo.id);

    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    expect(attempt.wipCommit).toBe(attempt.headSha);
    const head = String(attempt.headSha);
    expect(git(repo.clonePath, ['log', '-1', '--format=%s', head])).toMatch(/^wip: /);
    expect(git(repo.clonePath, ['show', `${head}:test/leftover.test.ts`])).toBe(
      '// not committed\n',
    );
    expect(git(repo.clonePath, ['show', `${head}:src/math.ts`])).toContain('edited after');
    expect(
      git(repo.clonePath, ['ls-tree', '-r', '--name-only', head]),
      'the result file is never committed',
    ).not.toContain('.factory/');
    const artifacts = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    const report = await json<DeliveryReport>(
      rt.request(`/v1/artifacts/${String(artifacts.find((a) => a.kind === 'report')?.id)}/content`),
    );
    expect(report.tasks[0]?.wipCommit).toBe(head);
    expect(report.knownLimitations.join('\n')).toMatch(/WIP commit/);
  });

  it('runs the Harness process with allowlisted env vars only and stdin closed', async () => {
    const probe = tempDir('factory-probe-');
    const response = validTaskResponse();
    response.steps.unshift({
      run: `env > '${probe}/env.txt'; if read -r line; then echo open; else echo closed; fi > '${probe}/stdin.txt'; pwd > '${probe}/cwd.txt'`,
    });
    const { rt, repo } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }), {
      GH_TOKEN: 'ghp_' + 'x'.repeat(36),
      ANTHROPIC_API_KEY: 'sk-ant-' + 'y'.repeat(30),
      FACTORY_TEST_UNLISTED: 'should not leak',
    });

    const job = await runJob(rt, repo.id);

    expect(job.status).toBe('completed');
    const [worktree] = await json<[WorktreeBody]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const [task] = await json<[{ id: string }]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const env = Object.fromEntries(
      readFileSync(join(probe, 'env.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    // The shell itself adds PWD, SHLVL and _; macOS adds __CF_USER_TEXT_ENCODING to every process.
    const shellAdded = ['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'];
    const allowed = [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TERM',
      'TMPDIR',
      'USER',
      'LOGNAME',
      'SHELL',
      'TZ',
      'FACTORY_JOB_ID',
      'FACTORY_TASK_ID',
      'FACTORY_ATTEMPT_ID',
      'FACTORY_PORT_BASE',
      'PORT',
      'CI',
    ];
    for (const key of Object.keys(env)) {
      if (!shellAdded.includes(key)) expect(allowed, `env var ${key}`).toContain(key);
    }
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('FACTORY_TEST_UNLISTED');
    expect(env).not.toHaveProperty('FACTORY_HOME');
    expect(env['FACTORY_TASK_ID']).toBe(task.id);
    expect(Number(env['FACTORY_PORT_BASE'])).toBe(worktree.portBase);
    expect(env['PORT']).toBe(env['FACTORY_PORT_BASE']);
    expect(readFileSync(join(probe, 'stdin.txt'), 'utf8').trim()).toBe('closed');
    expect(readFileSync(join(probe, 'cwd.txt'), 'utf8').trim()).toBe(worktree.path);
  });

  it('never reads a Task Result that is a symbolic link out of the Worktree', async () => {
    const outside = tempDir('factory-secret-');
    writeFileSync(join(outside, 'id_rsa'), 'TOP-SECRET-KEY-MATERIAL\n');
    const response = validTaskResponse();
    delete (response as { result?: unknown }).result;
    response.steps.push({
      run: `mkdir -p .factory && ln -s '${outside}/id_rsa' .factory/result.json`,
    });
    const { rt, repo } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }));

    const job = await runJob(rt, repo.id);

    expect(job.status).toBe('failed');
    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody & { exitDetail: string }];
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'invalid_output' });
    expect(attempt.exitDetail).toContain('result.regular_file');
    const artifacts = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    for (const a of artifacts) {
      const text = await (await rt.request(`/v1/artifacts/${a.id}/content`)).text();
      expect(text, `${a.kind} Artifact`).not.toContain('TOP-SECRET');
    }
    const events = await (await rt.request(`/v1/jobs/${job.id}/events?limit=1000`)).text();
    expect(events).not.toContain('TOP-SECRET');
  });

  it('runs no Harness-planted hook or fsmonitor when the factory commits leftovers', async () => {
    const probe = tempDir('factory-probe-');
    const response = validTaskResponse();
    response.steps.push(
      {
        run:
          `hooks="$(git rev-parse --git-common-dir)/planted"; mkdir -p "$hooks"; ` +
          `for h in pre-commit post-commit commit-msg post-checkout reference-transaction fsmonitor; do ` +
          `printf '#!/bin/sh\\nenv > %s/ran-%s\\n' '${probe}' "$h" > "$hooks/$h"; chmod +x "$hooks/$h"; done; ` +
          `git config core.hooksPath "$hooks"; git config core.fsmonitor "$hooks/fsmonitor"`,
      },
      { write: { path: 'test/leftover.test.ts', content: '// not committed\n' } },
    );
    const { rt, repo } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }), {
      GH_TOKEN: 'ghp_' + 'x'.repeat(36),
    });

    const job = await runJob(rt, repo.id);

    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    expect(attempt.wipCommit, 'the factory made a WIP commit').not.toBeNull();
    expect(readdirSync(probe), 'no planted hook or fsmonitor ran').toEqual([]);
  });

  it('keeps the Worktree active in the Factory Clone while the Harness runs', async () => {
    const response = { ...validTaskResponse(), delayMs: 3_000 };
    const { rt, repo, source } = await executionRuntime(scriptWith({}, { 'add-sum': [response] }));
    const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add sum()' });
    const created = (await res.json()) as JobBody;

    let active: WorktreeBody | undefined;
    const deadline = Date.now() + 15_000;
    while (active === undefined && Date.now() < deadline) {
      const list = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`));
      active = list.find((w) => w.state === 'active');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(active, 'an active Worktree').toBeDefined();
    const path = String(active?.path);
    expect(git(repo.clonePath, ['worktree', 'list'])).toContain(path);
    expect(git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(active?.branch);
    expect(git(source, ['worktree', 'list'])).not.toContain(path);
    const tasks = await json<{ state: string }[]>(rt.request(`/v1/jobs/${created.id}/tasks`));
    expect(tasks.map((t) => t.state)).toEqual(['running']);

    const job = await waitForJob(rt, created.id, done, 20_000);
    expect(job.status).toBe('completed');
  });

  it('shows the Attempt, its Evidence and the delivery in `factory job show`', async () => {
    const { rt, repo } = await executionRuntime(VALID_SCRIPT);
    const job = await runJob(rt, repo.id);
    const [worktree] = await json<[WorktreeBody]>(rt.request(`/v1/jobs/${job.id}/worktrees`));

    const show = await rt.home.cli(['job', 'show', job.id]);

    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/attempt 1 +passed/);
    expect(show.stdout).toMatch(/test +pass +exit 0/);
    expect(show.stdout).toContain(worktree.branch);
    expect(show.stdout).toContain(`git fetch '${repo.clonePath}'`);
  });
});

/** Everything about a checkout that the factory must leave untouched. */
function snapshot(repo: string) {
  const files = readdirSync(repo, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  const gitDir = join(repo, '.git');
  return {
    workingTree: Object.fromEntries(
      files
        .filter((f) => !f.startsWith(gitDir + '/'))
        .map((p) => [
          relative(repo, p),
          createHash('sha256').update(readFileSync(p)).digest('hex'),
        ]),
    ),
    branches: git(repo, ['branch', '-a']),
    worktrees: git(repo, ['worktree', 'list']),
    config: readFileSync(join(gitDir, 'config'), 'utf8'),
  };
}
