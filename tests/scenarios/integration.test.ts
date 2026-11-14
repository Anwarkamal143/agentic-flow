/**
 * The Integration Task and the Integration Branch (#55, ARCHITECTURE §14,
 * ADR-0034). Once every Plan Task is approved, the factory (not the planner)
 * creates one Integration Task per Repository. Its merge Attempt merges the
 * approved Task Branches `--no-ff`, in dependency order (ties by key), onto the
 * freshly fetched default branch as `factory/<job-id>/integration`, then
 * re-runs the de-duplicated verification there. A conflict is the human
 * Blocker `base_merge_conflict`, whose replan carries the conflict as
 * feedback. A Job created at `feature` v2 runs as before. Asserted through the
 * API, the CLI and git in the Factory Clone only.
 *
 * The upstream default branch is moved by the scripted developer's own shell
 * steps (a stand-in for someone pushing upstream while the Job runs).
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  capAttempts,
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
  state: string;
  cancelReason: string | null;
  writable?: string[];
  scope: { writable: string[]; forbidden: string[] };
  verification: { key: string; command: string; required: boolean; criteria: string[] }[];
  blocker: { reason: string; detail: string } | null;
}
interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  baseSha: string;
  headSha: string | null;
  harness: { id: string };
  findings: { source: string; rule?: string; problem: string }[];
  verificationRuns: { key: string; command: string; headSha: string; baseSha: string }[];
  evidence: { kind: string; verdict: string; headSha: string; baseSha: string }[];
}
interface WorktreeBody {
  taskId: string;
  branch: string;
  baseSha: string;
}
interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  state: string;
  question: string;
  why: string;
  options: { id: string }[];
  version: number;
}
interface ReportBody {
  reportVersion: number;
  outcome: string;
  statement: string;
  branches: { key: string; fetchCommand: string | null }[];
  integration: {
    branch: string;
    state: string;
    baseSha: string | null;
    headSha: string | null;
    merged: { key: string; headSha: string }[];
    fetchCommand: string | null;
    verification: { key: string; verdict: string }[];
  } | null;
}

const SHELL_GIT = `git -c user.name=Upstream -c user.email=upstream@example.invalid`;

/** A shell step that commits `file` (with `content`) on the upstream checkout's default branch. */
function upstreamCommit(src: string, file: string, content: string): string {
  return (
    `mkdir -p "$(dirname '${src}/${file}')" && printf '%s' '${content}' > '${src}/${file}' && ` +
    `${SHELL_GIT} -C '${src}' add '${file}' && ` +
    `${SHELL_GIT} -C '${src}' commit --quiet -m 'upstream: ${file}'`
  );
}

/** A Plan Task writing one file, `docs/<key>.md`, with a shared `lint` check. */
function docTask(key: string, dependsOn: string[] = [], verify = `test -f docs/${key}.md`) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Write docs/${key}.md`,
    scope: { writable: [`docs/${key}.md`], forbidden: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [
      { key: 'test', command: verify, criteria: ['AC-01'] },
      { key: 'lint', command: 'test -d docs', criteria: [] },
    ],
  };
}

/** The developer's one response for `key`: optional `run` steps, then the file, committed. */
function docRun(key: string, before: string[] = []) {
  return [
    {
      steps: [
        ...before.map((run) => ({ run })),
        { write: { path: `docs/${key}.md`, content: `# ${key}\n` } },
        { commit: `Write docs/${key}.md` },
      ],
      result: {
        status: 'done',
        summary: `Wrote docs/${key}.md.`,
        commits: [],
        criteria: [{ code: 'AC-01', claim: 'met', how: 'the file exists' }],
      },
    },
  ];
}

const APPROVE = [
  {
    output: {
      outcome: 'approved',
      summary: 'The file is there.',
      findings: [],
      criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
    },
  },
];

/** A runtime on a fresh `tiny-ts` checkout (`src`) whose script is built from `src`. */
async function runtimeOn(
  script: (src: string) => string,
  opts: { env?: NodeJS.ProcessEnv; maxAttempts?: number } = {},
): Promise<{ rt: RunningRuntime; src: string; repo: RepoBody }> {
  const src = tinyTsRepo();
  const home = await initializedHome();
  useFakeHarness(home, script(src));
  const rt = await startRuntime(home, opts.env === undefined ? undefined : { env: opts.env });
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes']);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  if (opts.maxAttempts === undefined) await skipPlanApproval(rt, repo.projectId);
  else await capAttempts(rt, repo.projectId, opts.maxAttempts);
  return { rt, src, repo };
}

async function createJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Write the docs' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const settled = (job: JobBody) => job.status !== 'active';

async function read(rt: RunningRuntime, jobId: string) {
  const [tasks, attempts, worktrees] = await Promise.all([
    json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`)),
    json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`)),
    json<WorktreeBody[]>(rt.request(`/v1/jobs/${jobId}/worktrees`)),
  ]);
  const integration = tasks.filter((t) => t.kind === 'integration');
  return { tasks, attempts, worktrees, integration };
}

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const report = artifacts.find((a) => a.kind === 'report');
  if (report === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${report.id}/content`));
}

describe('the Integration Branch', { timeout: 90_000 }, () => {
  it('merges every approved Task Branch --no-ff in dependency order onto the freshly fetched base, and verifies it again', async () => {
    const { rt, src, repo } = await runtimeOn((dir) =>
      scriptWith(
        {
          // Plan order c, a, b; b depends on a. Merge order: a, b (after a), c (ties by key).
          planning: [{ output: { tasks: [docTask('c'), docTask('a'), docTask('b', ['a'])] } }],
        },
        {
          // While the Job runs, the upstream default branch moves.
          c: docRun('c', [upstreamCommit(dir, 'UPSTREAM.md', 'moved')]),
          a: docRun('a'),
          b: docRun('b'),
        },
        { a: APPROVE, b: APPROVE, c: APPROVE },
      ),
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status).toBe('completed');
    expect(job.stageRuns.map((s) => [s.stageId, s.state])).toContainEqual([
      'integration',
      'succeeded',
    ]);
    const { tasks, attempts, worktrees, integration } = await read(rt, job.id);
    expect(tasks.map((t) => [t.kind, t.key, t.state])).toEqual([
      ['plan', 'c', 'approved'],
      ['plan', 'a', 'approved'],
      ['plan', 'b', 'approved'],
      ['integration', 'integration', 'approved'],
    ]);
    const [task] = integration;
    if (task === undefined) throw new Error('no Integration Task');
    // Its definition is the union of the Plan Tasks' (ADR-0034); the shared lint runs once.
    expect(task.scope.writable).toEqual(['docs/c.md', 'docs/a.md', 'docs/b.md']);
    expect(task.verification.map((v) => [v.key, v.command])).toEqual([
      ['test', 'test -f docs/c.md'],
      ['lint', 'test -d docs'],
      ['test-2', 'test -f docs/a.md'],
      ['test-3', 'test -f docs/b.md'],
    ]);

    // The merge Attempt: no Harness ran; its base is the default branch as it is upstream now.
    const upstreamHead = git(src, ['rev-parse', 'HEAD']).trim();
    const merge = attempts.find((a) => a.taskId === task.id);
    if (merge === undefined) throw new Error('no merge Attempt');
    expect(merge).toMatchObject({
      cause: 'merge',
      state: 'passed',
      exitReason: 'completed',
      harness: { id: 'factory' },
      baseSha: upstreamHead,
    });
    const keyOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.key;
    const cAttempt = attempts.find((a) => keyOf(a.taskId) === 'c');
    expect(cAttempt?.baseSha, 'c started before upstream moved').not.toBe(upstreamHead);

    // The Integration Branch, in the Factory Clone: one merge commit per Task Branch, --no-ff,
    // in dependency order, the second parent each Task's approved head.
    const branch = `factory/${job.id}/integration`;
    expect(worktrees.find((w) => w.taskId === task.id)?.branch).toBe(branch);
    const head = git(repo.clonePath, ['rev-parse', branch]).trim();
    expect(merge.headSha).toBe(head);
    const merges = git(repo.clonePath, [
      'log',
      '--first-parent',
      '--reverse',
      '--format=%P|%s',
      `${upstreamHead}..${branch}`,
    ])
      .trim()
      .split('\n')
      .map((line) => {
        const [parents = '', subject = ''] = line.split('|');
        return { parents: parents.split(' '), subject };
      });
    const approvedHead = (key: string) =>
      attempts.find((a) => keyOf(a.taskId) === key && a.state === 'passed')?.headSha;
    expect(merges.map((m) => /\(Task (\w+)\)/.exec(m.subject)?.[1])).toEqual(['a', 'b', 'c']);
    expect(merges.map((m) => m.parents.length)).toEqual([2, 2, 2]);
    expect(merges.map((m) => m.parents[1])).toEqual(['a', 'b', 'c'].map(approvedHead));
    expect(merges[0]?.parents[0], 'the first merge starts from the fetched base').toBe(
      upstreamHead,
    );
    expect(git(repo.clonePath, ['show', `${branch}:UPSTREAM.md`])).toBe('moved');

    // Verification re-ran on the integration head; its Evidence names (head, base) of it.
    expect(merge.verificationRuns.map((r) => r.command)).toEqual([
      'test -f docs/c.md',
      'test -d docs',
      'test -f docs/a.md',
      'test -f docs/b.md',
    ]);
    for (const run of merge.verificationRuns) {
      expect([run.headSha, run.baseSha]).toEqual([head, upstreamHead]);
    }
    expect(merge.evidence.length).toBeGreaterThan(0);
    for (const e of merge.evidence) {
      expect([e.verdict, e.headSha, e.baseSha]).toEqual(['pass', head, upstreamHead]);
    }

    // The Delivery Report names the Integration Branch and offers it, not the Task Branches.
    const report = await reportOf(rt, job.id);
    expect(report.reportVersion).toBe(4);
    expect(report.integration).toMatchObject({
      branch,
      state: 'approved',
      baseSha: upstreamHead,
      headSha: head,
    });
    expect(report.integration?.merged.map((m) => m.key)).toEqual(['a', 'b', 'c']);
    expect(report.integration?.fetchCommand).toContain(`${branch}:${branch}`);
    expect(report.branches.map((b) => b.key)).toEqual(['c', 'a', 'b']);
    expect(report.branches.every((b) => b.fetchCommand === null)).toBe(true);
    expect(report.statement).toContain(branch);

    // Distinguishable in job show and in the plan view, which lists Plan Tasks only.
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toMatch(/integration\s+approved.*\[Integration Task, factory-created/);
    expect(shown.stdout).toContain('[merge: the factory merged, no Harness ran]');
    expect(shown.stdout).toContain(`Integration Branch ${branch}: approved`);
    expect(shown.stdout).toContain('merged --no-ff: a → b → c');
    const plan = await json<{
      tasks: { key: string }[];
      integrationTasks: { key: string; branch: string }[];
      parallel: string[][];
    }>(rt.request(`/v1/jobs/${job.id}/plan`));
    expect(plan.tasks.map((t) => t.key)).toEqual(['c', 'a', 'b']);
    expect(plan.integrationTasks).toMatchObject([{ key: 'integration', branch }]);
    expect(plan.parallel.flat()).not.toContain('integration');
    const planShown = await rt.home.cli(['plan', 'show', job.id]);
    expect(planShown.stdout).toContain('Integration Tasks (factory-created, not part of the Plan');
  });

  it("fails the integration Stage's gate on a failing command, like any failed Gate", async () => {
    // Each Task passes alone; together, a's check fails (b's file is there too).
    const { rt, repo } = await runtimeOn(
      () =>
        scriptWith(
          {
            planning: [
              {
                output: {
                  tasks: [
                    docTask('a', [], 'test -f docs/a.md && test ! -f docs/b.md'),
                    docTask('b'),
                  ],
                },
              },
            ],
          },
          { a: docRun('a'), b: docRun('b') },
          { a: APPROVE, b: APPROVE },
        ),
      { maxAttempts: 1 },
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status).toBe('waiting_human');
    const integrationRun = job.stageRuns.find((s) => s.stageId === 'integration');
    expect(integrationRun).toMatchObject({
      state: 'waiting_human',
      blocker: { reason: 'rework_cap_reached' },
    });
    const { attempts, integration } = await read(rt, job.id);
    const [task] = integration;
    expect(task).toMatchObject({ state: 'blocked', blocker: { reason: 'rework_cap_reached' } });
    const merge = attempts.find((a) => a.taskId === task?.id);
    expect(merge).toMatchObject({ cause: 'merge', state: 'failed', exitReason: 'gates_failed' });
    expect(merge?.findings.some((f) => f.source === 'gate' && f.rule === 'verification')).toBe(
      true,
    );
    const failed = merge?.evidence.find((e) => e.kind === 'verification' && e.verdict === 'fail');
    expect([failed?.headSha, failed?.baseSha]).toEqual([merge?.headSha, merge?.baseSha]);
    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    const item = items.find((i) => i.taskId === task?.id);
    expect(item?.options.map((o) => o.id)).toEqual(['grant', 'replan', 'cancel_job']);
  });

  it('raises base_merge_conflict when two Task Branches conflict, and a replan carries the conflict as feedback', async () => {
    let d1 = '';
    const { rt, src, repo } = await runtimeOn((dir) => {
      d1 = git(dir, ['rev-parse', 'HEAD']).trim();
      // a runs first (perJob 1) and moves upstream: X adds docs/a.md. b starts on that base
      // and resets upstream back, so b's branch carries X's docs/a.md while a adds its own.
      return scriptWith(
        {
          planning: [
            { output: { tasks: [docTask('a'), docTask('b')] } },
            { output: { tasks: [docTask('a'), docTask('b')] } },
          ],
        },
        {
          a: docRun('a', [upstreamCommit(dir, 'docs/a.md', 'upstream a')]),
          b: docRun('b', [`${SHELL_GIT} -C '${dir}' reset --quiet --hard ${d1}`]),
        },
        { a: APPROVE, b: APPROVE },
      );
    });
    const res = await post(rt, '/v1/jobs', {
      repositoryId: repo.id,
      title: 'Write the docs',
      concurrency: { perJob: 1 },
    });
    const created = (await res.json()) as JobBody;
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status).toBe('waiting_human');
    expect(git(src, ['rev-parse', 'HEAD']).trim()).toBe(d1);
    const first = await read(rt, job.id);
    const [task] = first.integration;
    expect(task).toMatchObject({ state: 'blocked', blocker: { reason: 'base_merge_conflict' } });
    expect(task?.blocker?.detail).toMatch(/Task b.*after a merged cleanly.*docs\/a\.md/);
    // No merge Attempt or Worktree is made for a conflict.
    expect(first.attempts.filter((a) => a.taskId === task?.id)).toEqual([]);
    expect(first.worktrees.filter((w) => w.taskId === task?.id)).toEqual([]);
    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    const item = items.find((i) => i.taskId === task?.id && i.state === 'open');
    if (item === undefined) throw new Error('no Blocker Approval');
    expect(item.question).toBe(
      "Integration Task can't build the Integration Branch: a Task Branch conflicts",
    );
    expect(item.options.map((o) => o.id)).toEqual(['replan', 'cancel_job']);

    const decided = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'replan',
      '--expect-version',
      String(item.version),
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    // The planner re-plans with the conflict as its feedback; the same Plan conflicts again.
    const again = await waitForJob(
      rt,
      job.id,
      (j) => settled(j) && j.stageRuns.filter((s) => s.stageId === 'integration').length === 2,
      60_000,
    );
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const replanRun = events.find(
      (e) =>
        e.type === 'harness_run.started' &&
        e.payload['stageId'] === 'planning' &&
        e.payload['replan'] !== undefined,
    );
    const feedback = (replanRun?.payload['replan'] as { feedback: string } | undefined)?.feedback;
    expect(feedback).toContain('docs/a.md');
    expect(feedback).toContain('Task b');
    expect(feedback).toContain('conflicts');

    // The old Integration Task is cancelled (replan), never carried over; a new one rebuilt.
    const second = await read(rt, job.id);
    expect(second.integration.map((t) => [t.state, t.cancelReason])).toEqual([
      ['cancelled', 'replan'],
      ['blocked', null],
    ]);
    expect(again.stageRuns.filter((s) => s.stageId === 'integration').map((s) => s.state)).toEqual([
      'superseded',
      'waiting_human',
    ]);
  });

  it('runs a Job created at feature v2 unchanged: no integration Stage, no Integration Task', async () => {
    const { rt, repo } = await runtimeOn(
      () =>
        scriptWith(
          { planning: [{ output: { tasks: [docTask('a'), docTask('b')] } }] },
          { a: docRun('a'), b: docRun('b') },
          { a: APPROVE, b: APPROVE },
        ),
      { env: { FACTORY_TEST_RECIPE_VERSION: '2' } },
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status).toBe('completed');
    expect(job.stageRuns.map((s) => s.stageId)).toEqual([
      'intake',
      'triage',
      'discovery',
      'specification',
      'planning',
      'plan_approval',
      'execution',
      'closure',
    ]);
    const { tasks } = await read(rt, job.id);
    expect(tasks.map((t) => t.kind)).toEqual(['plan', 'plan']);
    const report = await reportOf(rt, job.id);
    expect(report.integration).toBeNull();
    expect(report.branches.map((b) => b.fetchCommand !== null)).toEqual([true, true]);
  });
});
