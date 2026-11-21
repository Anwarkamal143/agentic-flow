/**
 * The Worktree setup step (spec issue 43, ADR-0047). A Repository registered
 * with `repo add --setup <cmd>` has the factory run that command in each
 * Worktree, under the Tier 0 guardrail with the shared cache and lifecycle
 * scripts off, before the developer's Harness Run and before verification.
 * It runs once per Worktree, again when the dependency files change, and is
 * recorded with its redacted log, the head and base it ran on and the
 * Worktree's disk usage. A failed setup is a human Blocker, never Rework.
 *
 * The Fake Harness's `run` steps fail its Harness Run when their command
 * fails, so `test -f node_modules/.setup` in a developer step shows what the
 * developer saw. No GitHub: the Jobs are delivered locally.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../support/processes.js';
import {
  initializedHome,
  startRuntime,
  tempDir,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
  createProject,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

/** The GitHub-token-shaped string the setup prints (built at run time, so the command text holds none): its log must show it redacted. */
const PRINTED_SECRET = `ghp_${'a1B2'.repeat(9)}`;

interface SetupRunBody {
  id: string;
  attemptId: string;
  worktreeId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  failure: string | null;
  dependencyHash: string;
  headSha: string;
  baseSha: string;
  durationMs: number;
  diskBytes: number | null;
  outputArtifactId: string;
}
interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  baseSha: string;
  worktreeId: string;
  setupRuns: SetupRunBody[];
}
interface TaskBody {
  id: string;
  key: string;
  kind: string;
  state: string;
  blocker: { kind: string; reason: string } | null;
}
interface ItemBody {
  id: string;
  kind: string;
  subjectRef: string;
  version: number;
  options: { id: string }[];
}

type Step = Record<string, unknown>;

/** One Plan Task `a` writing `writable`, verified by `verify`, with its developer responses. */
function script(opts: {
  writable: string[];
  verify: { key: string; command: string }[];
  runs: Step[][];
  reviews?: number;
}) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'a',
    title: 'Write src/a.ts',
    scope: { writable: opts.writable, forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: opts.verify.map((v) => ({ ...v, criteria: ['AC-01'] })),
  };
  const done = {
    status: 'done',
    summary: 'Done.',
    commits: [],
    criteria: [{ code: 'AC-01', claim: 'met', how: 'the command passes' }],
  };
  const approved = {
    output: {
      outcome: 'approved',
      summary: 'Looks right.',
      findings: [],
      criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
    },
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    { a: opts.runs.map((steps) => ({ steps, result: done })) },
    { a: Array.from({ length: opts.reviews ?? 1 }, () => approved) },
  );
}

async function setupRuntime(scriptText: string, setup: string) {
  const src = tinyTsRepo();
  const home = await initializedHome();
  useFakeHarness(home, scriptText);
  const rt = await startRuntime(home);
  await createProject(rt, 'demo');
  const added = await rt.home.cli([
    'repo',
    'add',
    src,
    '--project',
    'demo',
    '--yes',
    '--setup',
    setup,
  ]);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<{ id: string; projectId: string }[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await skipPlanApproval(rt, repo.projectId);
  return { rt, repo, added, home };
}

async function createJob(rt: RunningRuntime, repositoryId: string) {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Add a' });
  expect(res.status).toBe(201);
  return (await res.json()) as JobBody;
}

const attemptsOf = (rt: RunningRuntime, jobId: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));

const settled = (j: JobBody) => j.status !== 'active';

describe('the Worktree setup step', { timeout: 120_000 }, () => {
  it('runs the setup before the Harness and verification, once per Worktree, with the shared cache and scripts off, and records it', async () => {
    const setup = `mkdir -p node_modules && printf '%s\\n' "$npm_config_cache" "$npm_config_ignore_scripts" > node_modules/.setup && echo installed ghp_$(printf 'a1B2%.0s' 1 2 3 4 5 6 7 8 9)`;
    const { rt, repo, added, home } = await setupRuntime(
      script({
        writable: ['src/a.ts'],
        verify: [{ key: 'setup-seen', command: 'test -f node_modules/.setup' }],
        runs: [
          [
            // The setup ran first, with the factory home's npm cache and lifecycle scripts off.
            {
              run: "grep -q '/home/cache/npm$' node_modules/.setup && grep -qx true node_modules/.setup",
            },
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
        ],
      }),
      setup,
    );
    expect(added.stdout).toContain(`setup:     ${setup} (from --setup;`);

    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);
    expect(job.status, rt.output()).toBe('completed');
    expect((job.effectiveConfig as unknown as { setup: unknown }).setup).toEqual({
      value: setup,
      source: 'repository',
    });

    const attempts = await attemptsOf(rt, job.id);
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const planTask = tasks.find((t) => t.kind === 'plan');
    const developer = attempts.find((a) => a.taskId === planTask?.id);
    // Once in the Task's Worktree (before the Harness; verification found it current).
    expect(developer?.setupRuns).toHaveLength(1);
    const [run] = developer?.setupRuns ?? [];
    expect(run).toMatchObject({
      command: setup,
      exitCode: 0,
      timedOut: false,
      passed: true,
      failure: null,
      headSha: developer?.baseSha,
      baseSha: developer?.baseSha,
      worktreeId: developer?.worktreeId,
    });
    expect(run?.dependencyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run?.diskBytes).toBeGreaterThan(0);
    // The Integration Task's own Worktree is set up too, before its verification.
    const integration = attempts.find((a) => a.taskId !== planTask?.id);
    expect(integration?.setupRuns.map((r) => r.exitCode)).toEqual([0]);

    // The log is redacted; the shared cache is the factory's; lifecycle scripts are off.
    const log = await json<{ source: string; output: string; exitCode: number }>(
      rt.request(`/v1/artifacts/${String(run?.outputArtifactId)}/content`),
    );
    expect(log).toMatchObject({ source: 'setup', exitCode: 0 });
    expect(log.output).toContain('installed [REDACTED:github_token]');
    expect(log.output).not.toContain(PRINTED_SECRET);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    expect(events.filter((e) => e.type === 'setup_run.finished')).toHaveLength(2);

    const report = await json<{
      tasks: { key: string; setup: { command: string; exitCode: number } | null }[];
      knownLimitations: string[];
    }>(
      rt.request(
        `/v1/artifacts/${String(
          (
            await json<{ id: string; kind: string }[]>(rt.request(`/v1/jobs/${job.id}/artifacts`))
          ).find((a) => a.kind === 'report')?.id,
        )}/content`,
      ),
    );
    expect(report.tasks.find((t) => t.key === 'a')?.setup).toMatchObject({
      command: setup,
      exitCode: 0,
    });
    expect(report.knownLimitations.join('\n')).toMatch(
      /setup command .* ran in the Worktrees on this machine, with network access and lifecycle scripts off: the Tier 0 guardrail, not isolation/,
    );
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toMatch(/setup: {5}mkdir -p node_modules .* passed, /);
    // The cache the setup was pointed at is the factory home's, created for it.
    expect(existsSync(join(home.dir, 'cache'))).toBe(true);
    expect(home.dir.endsWith('/home')).toBe(true);
  });

  it('gives a failed setup the setup_failed Blocker, never Rework; a Retry runs it again first', async () => {
    const gate = join(tempDir('setup-gate-'), 'ready');
    const { rt, repo } = await setupRuntime(
      script({
        writable: ['src/a.ts'],
        verify: [{ key: 'test', command: 'test -f src/a.ts' }],
        runs: [
          [
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
        ],
      }),
      `test -f '${gate}' || { echo 'registry unreachable' >&2; exit 7; }`,
    );
    const created = await createJob(rt, repo.id);
    const blocked = await waitForJob(rt, created.id, settled, 60_000);
    expect(blocked.status, rt.output()).toBe('waiting_human');

    const [first] = await attemptsOf(rt, blocked.id);
    expect(first).toMatchObject({ n: 1, state: 'failed', exitReason: 'setup_failed' });
    expect(first?.exitDetail).toMatch(/exited 7$/);
    expect(first?.setupRuns.map((r) => r.exitCode)).toEqual([7]);
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${blocked.id}/tasks`));
    expect(tasks.find((t) => t.key === 'a')).toMatchObject({
      state: 'blocked',
      blocker: { kind: 'human', reason: 'setup_failed' },
    });
    // No Harness ran: the Fake's one developer response is still unused.
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${blocked.id}/events?limit=1000`));
    expect(
      events.filter((e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer'),
    ).toHaveLength(0);
    const log = await json<{ output: string }>(
      rt.request(`/v1/artifacts/${String(first?.setupRuns[0]?.outputArtifactId)}/content`),
    );
    expect(log.output).toContain('registry unreachable');

    const [item] = (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter(
      (i) => i.kind === 'blocker',
    );
    if (item === undefined) throw new Error('no Blocker Approval');
    expect(item.options.map((o) => o.id)).toEqual(['retry_now', 'cancel_job']);

    writeFileSync(gate, '');
    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'retry_now',
    });
    expect(decided.status).toBe(200);
    const done = await waitForJob(
      rt,
      blocked.id,
      (j) => j.status !== 'active' && j.status !== 'waiting_human',
      60_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const attempts = (await attemptsOf(rt, done.id)).filter((a) => a.taskId === first?.taskId);
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'initial', 'failed'],
      [2, 'retry', 'passed'],
    ]);
    expect(attempts[1]?.setupRuns.map((r) => r.exitCode)).toEqual([0]);
  });

  it('runs the setup again when the dependency files change, and not when they stay the same', async () => {
    const { rt, repo } = await setupRuntime(
      script({
        writable: ['src/a.ts', 'src/b.ts', 'package-lock.json'],
        verify: [{ key: 'b', command: 'test -f src/b.ts' }],
        runs: [
          // Attempt 1 changes the lockfile and fails its Gate (no src/b.ts): Rework.
          [
            { write: { path: 'package-lock.json', content: '{"lockfileVersion": 3}\n' } },
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Lock and write src/a.ts' },
          ],
          // Attempt 2 changes no dependency file.
          [
            { write: { path: 'src/b.ts', content: 'export const b = 2;\n' } },
            { commit: 'Write src/b.ts' },
          ],
        ],
      }),
      'mkdir -p node_modules && date > node_modules/.setup',
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);
    expect(job.status, rt.output()).toBe('completed');
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const planTask = tasks.find((t) => t.kind === 'plan');
    const attempts = (await attemptsOf(rt, job.id)).filter((a) => a.taskId === planTask?.id);
    expect(attempts.map((a) => [a.n, a.exitReason])).toEqual([
      [1, 'gates_failed'],
      [2, 'completed'],
    ]);
    // Attempt 1: before its Harness Run, then again before verification (the lockfile changed).
    const [before, after] = attempts[0]?.setupRuns ?? [];
    expect(attempts[0]?.setupRuns).toHaveLength(2);
    expect(after?.dependencyHash).not.toBe(before?.dependencyHash);
    expect(after?.headSha).not.toBe(before?.headSha);
    // Attempt 2, the same Worktree with the same dependency files: no setup runs.
    expect(attempts[1]?.setupRuns).toEqual([]);
  });

  it('sets up again after a crash during the setup, without spending a Retry', async () => {
    const mark = join(tempDir('setup-crash-'), 'started');
    const { rt, repo, home } = await setupRuntime(
      script({
        writable: ['src/a.ts'],
        verify: [{ key: 'setup-seen', command: 'test -f node_modules/.setup' }],
        runs: [
          [
            { run: 'test -f node_modules/.setup' },
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
        ],
      }),
      // The first run marks itself and hangs (the runtime is killed meanwhile); the next one installs.
      `if [ -f '${mark}' ]; then mkdir -p node_modules && touch node_modules/.setup; else touch '${mark}'; sleep 60; fi`,
    );
    const created = await createJob(rt, repo.id);
    await waitFor(() => existsSync(mark), 60_000, 'the setup to start');
    await rt.kill();

    const again = await startRuntime(home);
    const job = await waitForJob(again, created.id, settled, 90_000);
    expect(job.status, again.output()).toBe('completed');
    expect(again.output()).toMatch(/its setup was cut short; resume/);
    const tasks = await json<TaskBody[]>(again.request(`/v1/jobs/${job.id}/tasks`));
    const planTask = tasks.find((t) => t.kind === 'plan');
    const attempts = (await attemptsOf(again, job.id)).filter((a) => a.taskId === planTask?.id);
    // The same Attempt, set up again: the cut-short run was never recorded.
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([[1, 'initial', 'passed']]);
    expect(attempts[0]?.setupRuns.map((r) => r.passed)).toEqual([true]);
  });

  it("raises setup_failed in the Integration Task's Worktree, and its Retry verifies the same merge again", async () => {
    const gate = join(tempDir('setup-gate-'), 'ready');
    const { rt, repo } = await setupRuntime(
      script({
        writable: ['src/a.ts'],
        verify: [{ key: 'test', command: 'test -f src/a.ts' }],
        runs: [
          [
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
        ],
      }),
      // Fails only on the Integration Branch, until the gate exists.
      `case "$(git rev-parse --abbrev-ref HEAD)" in */integration) test -f '${gate}' || exit 9;; esac; mkdir -p node_modules`,
    );
    const created = await createJob(rt, repo.id);
    const blocked = await waitForJob(rt, created.id, settled, 90_000);
    expect(blocked.status, rt.output()).toBe('waiting_human');
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${blocked.id}/tasks`));
    const integration = tasks.find((t) => t.kind === 'integration');
    expect(integration).toMatchObject({
      state: 'blocked',
      blocker: { kind: 'human', reason: 'setup_failed' },
    });
    const head = (await attemptsOf(rt, blocked.id)).find((a) => a.taskId === integration?.id);
    expect(head).toMatchObject({ cause: 'merge', exitReason: 'setup_failed' });

    const [item] = (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter(
      (i) => i.kind === 'blocker',
    );
    if (item === undefined) throw new Error('no Blocker Approval');
    writeFileSync(gate, '');
    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'retry_now',
    });
    expect(decided.status).toBe(200);
    const done = await waitForJob(
      rt,
      blocked.id,
      (j) => j.status !== 'active' && j.status !== 'waiting_human',
      60_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const attempts = (await attemptsOf(rt, done.id)).filter((a) => a.taskId === integration?.id);
    // Verified again in the same Worktree, on the same merge: nothing was merged twice.
    expect(attempts.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'merge', 'failed'],
      [2, 'merge', 'passed'],
    ]);
    expect(attempts[1]?.worktreeId).toBe(attempts[0]?.worktreeId);
    expect(attempts[1]?.baseSha).toBe(attempts[0]?.baseSha);
  });
});
