/**
 * Keep going (#44, ARCHITECTURE §4.4, §10, ADR-0028): one blocked or failed
 * Task never stalls or hides the rest of the Job. Independent Tasks keep
 * dispatching; a failed Task's dependents are cancelled (`dependency_failed`);
 * a Dependency Base merge conflict is a `base_merge_conflict` Blocker
 * Approval; and the Delivery Report v3 says exactly what to fetch, also as
 * the partial results of a failed Job. Asserted through the API, the CLI and
 * git only.
 */
import { execFileSync } from 'node:child_process';
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
  json,
  jobSettled,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface TaskBody {
  id: string;
  key: string;
  state: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}
interface AttemptBody {
  id: string;
  taskId: string;
}
interface ItemBody {
  id: string;
  kind: string;
  taskId: string | null;
  subjectRef: string;
  question: string;
  why: string;
  options: { id: string }[];
  version: number;
}
interface BranchBody {
  key: string;
  state: string;
  cancelReason: string | null;
  branch: string | null;
  headSha: string | null;
  leaf: boolean;
  fetchCommand: string | null;
}
interface ReportBody {
  reportVersion: number;
  outcome: string;
  statement: string;
  repository: { clonePath: string };
  branches: BranchBody[];
  notes: string[];
  tasks: { key: string }[];
}

/** A Plan Task writing one file, `docs/<key>.md`, unless its scope is given. */
function docTask(key: string, dependsOn: string[] = [], writable = [`docs/${key}.md`]) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Task ${key}`,
    scope: { writable, forbidden: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'true', criteria: ['AC-01'] }],
  };
}

/** The developer's one response: `steps` (default: write `docs/<key>.md`), then a commit. */
function devRun(key: string, opts: { steps?: unknown[]; delayMs?: number } = {}) {
  return [
    {
      steps: [
        ...(opts.steps ?? [{ write: { path: `docs/${key}.md`, content: `# ${key}\n` } }]),
        { commit: `Task ${key}` },
      ],
      result: {
        status: 'done',
        summary: `Did ${key}.`,
        commits: [],
        criteria: [{ code: 'AC-01', claim: 'met', how: 'done' }],
      },
      ...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
    },
  ];
}

const review = (outcome: 'approved' | 'changes_requested') => [
  {
    output: {
      outcome,
      summary: outcome === 'approved' ? 'Fine.' : 'Not right.',
      findings:
        outcome === 'approved'
          ? []
          : [
              {
                severity: 'high',
                faultOrigin: 'implementation',
                location: 'docs',
                problem: 'wrong',
                why: 'because',
                recommendation: 'redo',
                blocking: true,
              },
            ],
      criteria: [
        { code: 'AC-01', verdict: outcome === 'approved' ? 'pass' : 'fail', detail: 'checked' },
      ],
    },
  },
];
const APPROVE = review('approved');
/** Invalid twice: `invalid_output` after its one re-prompt, a non-routable end (`failed`). */
const INVALID_REVIEW = [{ raw: 'looks fine to me' }, { raw: '{}' }];

async function runtimeWith(script: string, config: Record<string, unknown> = {}) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const source = tinyTsRepo();
  const res = await rt.home.cli(['repo', 'add', source, '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; projectId: string; clonePath: string }]>(
    rt.request('/v1/repositories'),
  );
  await skipPlanApproval(rt, repo.projectId, config);
  return { rt, repo, source };
}

async function runJob(rt: RunningRuntime, repositoryId: string, extra = {}): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Keep going', ...extra });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  return waitForJob(rt, created.id, jobSettled, 40_000);
}

const tasksOf = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
const eventsOf = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const report = artifacts.filter((a) => a.kind === 'report');
  expect(report, 'one Delivery Report').toHaveLength(1);
  return json<ReportBody>(rt.request(`/v1/artifacts/${String(report[0]?.id)}/content`));
}

function byKey(tasks: TaskBody[], key: string): TaskBody {
  const found = tasks.find((t) => t.key === key);
  if (found === undefined) throw new Error(`no Task ${key}`);
  return found;
}

describe(
  'a failed Task: dependency_failed, keep going, partial results',
  { timeout: 60_000 },
  () => {
    it("cancels the failed Task's dependents in its transaction, finishes the independent branch, then fails the Job with a Delivery Report of the partial results", async () => {
      const { rt, repo, source } = await runtimeWith(
        scriptWith(
          {
            planning: [
              {
                output: {
                  tasks: [docTask('a'), docTask('b', ['a']), docTask('c', ['b']), docTask('d')],
                },
              },
            ],
          },
          { a: devRun('a'), d: devRun('d', { delayMs: 2500 }) },
          { a: INVALID_REVIEW, d: APPROVE },
        ),
      );

      const job = await runJob(rt, repo.id);

      expect(job.status).toBe('failed');
      const tasks = await tasksOf(rt, job.id);
      expect(tasks.map((t) => [t.key, t.state])).toEqual([
        ['a', 'failed'],
        ['b', 'cancelled'],
        ['c', 'cancelled'],
        ['d', 'approved'],
      ]);
      const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
      expect(attempts.map((x) => tasks.find((t) => t.id === x.taskId)?.key).sort()).toEqual([
        'a',
        'd',
      ]);

      // One event per dependent, written right after the failure: the same transaction.
      const events = await eventsOf(rt, job.id);
      const failed = events.find((e) => e.type === 'task.failed');
      expect(failed?.entityId).toBe(byKey(tasks, 'a').id);
      const cancelled = events.filter((e) => e.type === 'task.cancelled');
      expect(
        cancelled.map((e) => [e.entityId, e.seq, e.payload['reason'], e.payload['from']]),
      ).toEqual([
        [byKey(tasks, 'b').id, (failed?.seq ?? 0) + 1, 'dependency_failed', 'pending'],
        [byKey(tasks, 'c').id, (failed?.seq ?? 0) + 2, 'dependency_failed', 'pending'],
      ]);
      expect(cancelled[0]?.payload['failedTask']).toBe('a');

      // Keep going: D was approved after A failed, and only then did the Job fail.
      const dApproved = events.find(
        (e) => e.type === 'task.approved' && e.entityId === byKey(tasks, 'd').id,
      );
      expect(dApproved?.seq).toBeGreaterThan(failed?.seq ?? Infinity);
      const jobFailed = events.find(
        (e) => e.type === 'job.status_changed' && e.payload['to'] === 'failed',
      );
      expect(jobFailed?.seq).toBeGreaterThan(dApproved?.seq ?? Infinity);
      const execution = job.stageRuns.find((s) => s.stageId === 'execution');
      expect(execution?.state).toBe('failed');
      expect(job.stageRuns.find((s) => s.stageId === 'closure')?.state).toBe('succeeded');

      // The Delivery Report v3: says plainly that the Job failed, lists every Task, offers D only.
      const report = await reportOf(rt, job.id);
      expect(report.reportVersion).toBe(3);
      expect(report.outcome).toBe('failed');
      expect(report.statement).toMatch(/The Job failed/);
      expect(report.statement).toMatch(/partial results/);
      expect(report.branches.map((b) => [b.key, b.state, b.cancelReason, b.leaf])).toEqual([
        ['a', 'failed', null, false],
        ['b', 'cancelled', 'dependency_failed', false],
        ['c', 'cancelled', 'dependency_failed', true],
        ['d', 'approved', null, true],
      ]);
      const branch = (key: string) => report.branches.find((b) => b.key === key);
      expect(branch('a')?.branch, "the failed Task's branch is listed").toMatch(/^factory\//);
      expect(branch('a')?.fetchCommand, 'never offered').toBeNull();
      expect(branch('b')?.branch, 'a cancelled Task never had one').toBeNull();
      expect(branch('c')?.fetchCommand).toBeNull();
      expect(branch('d')?.fetchCommand).toContain(repo.clonePath);
      expect(report.tasks.map((t) => t.key)).toEqual(['d']);
      expect(report.notes.join('\n')).toContain(repo.clonePath);

      // The offered fetch, run from the source checkout, brings D in.
      execFileSync('sh', ['-c', branch('d')?.fetchCommand ?? 'false'], {
        cwd: source,
        stdio: 'pipe',
      });
      expect(git(source, ['rev-parse', String(branch('d')?.branch)]).trim()).toBe(
        branch('d')?.headSha,
      );

      // The failed Task's Worktree holds unreviewed work: closure keeps it; D's is removed.
      const worktrees = await json<{ taskId: string; state: string }[]>(
        rt.request(`/v1/jobs/${job.id}/worktrees`),
      );
      expect(worktrees.find((w) => w.taskId === byKey(tasks, 'a').id)?.state).toBe('preserved');
      expect(worktrees.find((w) => w.taskId === byKey(tasks, 'd').id)?.state).toBe('removed');

      // The CLI shows the same: every branch, and the one fetch.
      const shown = await rt.home.cli(['job', 'show', job.id]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(shown.stdout).toContain('The Job failed');
      expect(shown.stdout).toMatch(/b: cancelled \(dependency_failed\)/);
      expect(shown.stdout).toContain(String(branch('d')?.fetchCommand));
    });
  },
);

describe('a blocked Task: keep going', { timeout: 60_000 }, () => {
  it('dispatches an independent Task after one is blocked; only its dependent waits', async () => {
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {
          planning: [{ output: { tasks: [docTask('x'), docTask('y', ['x']), docTask('z')] } }],
        },
        { x: devRun('x'), z: devRun('z') },
        { x: review('changes_requested'), z: APPROVE },
      ),
      { maxAttempts: 1 },
    );

    // One Task at a time, so Z can only start once X has stopped.
    const job = await runJob(rt, repo.id, { concurrency: { perJob: 1 } });

    expect(job.status).toBe('waiting_human');
    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.key, t.state, t.blocker?.reason ?? null])).toEqual([
      ['x', 'blocked', 'rework_cap_reached'],
      ['y', 'pending', null],
      ['z', 'approved', null],
    ]);
    const events = await eventsOf(rt, job.id);
    const seq = (key: string, type: string) =>
      events.find((e) => e.entityId === byKey(tasks, key).id && e.type === type)?.seq ?? NaN;
    expect(seq('z', 'task.claimed')).toBeGreaterThan(seq('x', 'task.blocked'));
    const execution = job.stageRuns.find((s) => s.stageId === 'execution') as
      { state: string; blocker: { reason: string } | null } | undefined;
    expect([execution?.state, execution?.blocker?.reason]).toEqual([
      'waiting_human',
      'rework_cap_reached',
    ]);
  });
});

describe('base_merge_conflict', { timeout: 60_000 }, () => {
  it('blocks the Task whose Dependency Base conflicts, with a Blocker Approval to replan or cancel the Job', async () => {
    // B moves test/ to spec/ (every file of the directory); C adds test/extra.md. Their scopes
    // don't overlap, but git's directory-rename detection makes the merge conflict.
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {
          planning: [
            {
              output: {
                tasks: [
                  docTask('b', [], ['test/math.test.ts', 'spec/math.test.ts']),
                  docTask('c', [], ['test/extra.md']),
                  docTask('d', ['b', 'c']),
                ],
              },
            },
          ],
        },
        {
          b: devRun('b', { steps: [{ run: 'mkdir -p spec && mv test/math.test.ts spec/' }] }),
          c: devRun('c', { steps: [{ write: { path: 'test/extra.md', content: 'extra\n' } }] }),
        },
        { b: APPROVE, c: APPROVE },
      ),
    );

    const job = await runJob(rt, repo.id);

    expect(job.status).toBe('waiting_human');
    const tasks = await tasksOf(rt, job.id);
    expect(tasks.map((t) => [t.key, t.state])).toEqual([
      ['b', 'approved'],
      ['c', 'approved'],
      ['d', 'blocked'],
    ]);
    const d = byKey(tasks, 'd');
    expect(d.blocker).toMatchObject({ kind: 'human', reason: 'base_merge_conflict' });
    expect(d.blocker?.detail).toContain('b, c');
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(
      attempts.filter((x) => x.taskId === d.id),
      'no Attempt started',
    ).toEqual([]);
    const worktrees = await json<{ taskId: string }[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    expect(
      worktrees.filter((w) => w.taskId === d.id),
      'no Worktree made',
    ).toEqual([]);

    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    expect(items.map((i) => [i.kind, i.taskId])).toEqual([['blocker', d.id]]);
    const [item] = items as [ItemBody];
    expect(item.options.map((o) => o.id)).toEqual(['replan', 'cancel_job']);
    expect(item.question).toContain('Dependency Base');

    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'cancel_job',
    });
    expect(decided.status, await decided.clone().text()).toBe(200);
    const after = await waitForJob(rt, job.id, (j) => j.status === 'cancelled');
    expect(after.status).toBe('cancelled');
  });

  it('replans from the Blocker Approval: b and c carry over approved, d is re-planned as a new Task (#45)', async () => {
    const conflicting = [
      docTask('b', [], ['test/math.test.ts', 'spec/math.test.ts']),
      docTask('c', [], ['test/extra.md']),
      docTask('d', ['b', 'c']),
    ];
    // The new Plan keeps b and c as they are; d now depends on b only.
    const replanned = [conflicting[0], conflicting[1], docTask('d', ['b'])];
    const { rt, repo } = await runtimeWith(
      scriptWith(
        { planning: [{ output: { tasks: conflicting } }, { output: { tasks: replanned } }] },
        {
          b: devRun('b', { steps: [{ run: 'mkdir -p spec && mv test/math.test.ts spec/' }] }),
          c: devRun('c', { steps: [{ write: { path: 'test/extra.md', content: 'extra\n' } }] }),
          d: devRun('d'),
        },
        { b: APPROVE, c: APPROVE, d: APPROVE },
      ),
    );
    const job = await runJob(rt, repo.id);
    expect(job.status).toBe('waiting_human');
    const before = await tasksOf(rt, job.id);
    const [item] = await json<ItemBody[]>(rt.request('/v1/inbox'));
    if (item === undefined) throw new Error('no base_merge_conflict Approval');

    const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
      expectedVersion: item.version,
      subjectRef: item.subjectRef,
      option: 'replan',
      comment: 'Let d build on b only.',
    });
    expect(decided.status, await decided.clone().text()).toBe(200);

    const done = await waitForJob(
      rt,
      job.id,
      (j) => j.status === 'completed' || j.status === 'failed',
      30_000,
    );
    expect(done.status, rt.output()).toBe('completed');
    const tasks = await tasksOf(rt, job.id);
    const ids = (key: string) => tasks.filter((t) => t.key === key).map((t) => t.id);
    expect(ids('b')).toEqual([byKey(before, 'b').id]);
    expect(ids('c')).toEqual([byKey(before, 'c').id]);
    const [oldD, newD] = tasks.filter((t) => t.key === 'd');
    expect(oldD?.id).toBe(byKey(before, 'd').id);
    expect(oldD?.state).toBe('cancelled');
    expect(newD?.state).toBe('approved');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(
      events.find((e) => e.type === 'task.cancelled' && e.entityId === oldD?.id)?.payload,
    ).toMatchObject({ cancelReason: 'replan', why: 'definition_changed' });
  });
});
