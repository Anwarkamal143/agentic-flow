/**
 * The parallel DAG (#39, ROADMAP exit test B1, ADR-0020, ADR-0021):
 * independent Tasks run at once within the global (`config.json`),
 * per-Repository and per-Job limits (the Effective Configuration, overridable
 * by the Job at creation), and a dependent Task is claimed only once every
 * Task it depends on is `approved`, starting from its Dependency Base.
 * Asserted through the API, the CLI and git in the Factory Clone only.
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tempDir,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  json,
  jobSettled,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface TaskBody {
  id: string;
  key: string;
  state: string;
}
interface AttemptBody {
  id: string;
  taskId: string;
  n: number;
  baseSha: string;
  headSha: string | null;
}
interface WorktreeBody {
  taskId: string;
  baseSha: string;
  portBase: number | null;
}

/** One Task's claim and approval, as event seqs. */
type Span = { id: string; claimed: number; approved: number };

/** A Plan Task writing one file, `docs/<key>.md`. */
function docTask(key: string, dependsOn: string[] = [], verify = `test -f docs/${key}.md`) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Write docs/${key}.md`,
    scope: { writable: [`docs/${key}.md`], forbidden: [] },
    dependsOn,
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: verify, criteria: ['AC-01'] }],
  };
}

/** The developer's one response for `key`: optional `run` steps, then the file, committed. */
function docRun(key: string, opts: { before?: string[]; delayMs?: number } = {}) {
  return [
    {
      steps: [
        ...(opts.before ?? []).map((run) => ({ run })),
        { write: { path: `docs/${key}.md`, content: `# ${key}\n` } },
        { commit: `Write docs/${key}.md` },
      ],
      result: {
        status: 'done',
        summary: `Wrote docs/${key}.md.`,
        commits: [],
        criteria: [{ code: 'AC-01', claim: 'met', how: 'the file exists' }],
      },
      ...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
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

/**
 * A `run` step that is a barrier: writes `<dir>/<mine>`, then waits (at most
 * 20 s, else it fails the Harness Run) for `<dir>/<theirs>`. Both Tasks pass
 * it only if they run at the same time.
 */
function barrier(dir: string, mine: string, theirs: string): string {
  return (
    `touch '${dir}/${mine}'; i=0; while [ ! -f '${dir}/${theirs}' ]; do ` +
    `i=$((i+1)); if [ $i -gt 200 ]; then echo 'barrier timed out' >&2; exit 1; fi; sleep 0.1; done`
  );
}

async function runtimeWith(script: string, config: Record<string, unknown> = {}) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  patchFactoryConfig(home, config);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  return { rt, repo };
}

async function createJob(rt: RunningRuntime, repositoryId: string, extra = {}): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Write the docs', ...extra });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

/** Each Task's claim and approval, as event seqs. */
async function lifetimes(rt: RunningRuntime, jobId: string) {
  const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
  const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
  const seq = (taskId: string, type: string) =>
    events.find((e) => e.entityId === taskId && e.type === type)?.seq ?? Number.NaN;
  return {
    tasks,
    events,
    byKey: new Map(
      tasks.map((t) => [
        t.key,
        { id: t.id, claimed: seq(t.id, 'task.claimed'), approved: seq(t.id, 'task.approved') },
      ]),
    ),
  };
}

/** The most Tasks claimed and not yet approved at any one time. */
function maxInFlight(spans: Iterable<{ claimed: number; approved: number }>): number {
  const all = [...spans];
  return Math.max(
    ...all.map((s) => all.filter((o) => o.claimed <= s.claimed && s.claimed < o.approved).length),
  );
}

describe('B1: an A → {B, C} → D DAG', { timeout: 60_000 }, () => {
  it('runs B and C at once and claims D after both are approved, from its Dependency Base', async () => {
    const dir = tempDir('factory-barrier-');
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {
          planning: [
            {
              output: {
                tasks: [
                  docTask('a'),
                  docTask('b', ['a']),
                  docTask('c', ['a']),
                  docTask(
                    'd',
                    ['b', 'c'],
                    'test -f docs/a.md && test -f docs/b.md && test -f docs/c.md && test -f docs/d.md',
                  ),
                ],
              },
            },
          ],
        },
        {
          a: docRun('a'),
          b: docRun('b', { before: [barrier(dir, 'b', 'c')] }),
          c: docRun('c', { before: [barrier(dir, 'c', 'b')] }),
          d: docRun('d'),
        },
        { a: APPROVE, b: APPROVE, c: APPROVE, d: APPROVE },
      ),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled, 40_000);

    expect(job.status).toBe('completed');
    const { tasks, events, byKey } = await lifetimes(rt, job.id);
    expect(tasks.map((t) => [t.key, t.state])).toEqual([
      ['a', 'approved'],
      ['b', 'approved'],
      ['c', 'approved'],
      ['d', 'approved'],
    ]);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((k) => {
      const span = byKey.get(k);
      if (span === undefined) throw new Error(`no Task ${k}`);
      return span;
    }) as [Span, Span, Span, Span];

    // B and C overlap: each was claimed before the other was approved (the barrier proved it too).
    expect(b.claimed).toBeLessThan(c.approved);
    expect(c.claimed).toBeLessThan(b.approved);
    expect(b.claimed).toBeGreaterThan(a.approved);
    expect(c.claimed).toBeGreaterThan(a.approved);
    // D became ready, and was claimed, only after both B and C were approved.
    const dReady = events.find((e) => e.entityId === d.id && e.type === 'task.ready');
    expect(dReady?.seq).toBeGreaterThan(Math.max(b.approved, c.approved));
    expect(d.claimed).toBeGreaterThan(Math.max(b.approved, c.approved));
    // Limits respected: the per-Job default is 2.
    expect(maxInFlight(byKey.values())).toBe(2);

    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempts, 'one Attempt per Task').toHaveLength(4);
    const attemptOf = (span: Span) => {
      const found = attempts.find((x) => x.taskId === span.id);
      if (found?.headSha == null) throw new Error('no approved head');
      return { baseSha: found.baseSha, headSha: found.headSha };
    };
    const [repoRow] = await json<[{ clonePath: string; defaultBranch: string }]>(
      rt.request('/v1/repositories'),
    );
    const clone = repoRow.clonePath;
    // One dependency: B and C start from A's approved head.
    expect(attemptOf(b).baseSha).toBe(attemptOf(a).headSha);
    expect(attemptOf(c).baseSha).toBe(attemptOf(a).headSha);
    // Several: D starts from B's and C's heads merged in Plan order, a local commit in the clone.
    const dBase = attemptOf(d).baseSha;
    expect(git(clone, ['rev-list', '--parents', '-n', '1', dBase]).trim().split(' ')).toEqual([
      dBase,
      attemptOf(b).headSha,
      attemptOf(c).headSha,
    ]);
    expect(git(clone, ['ls-tree', '--name-only', dBase, 'docs/']).trim().split('\n')).toEqual([
      'docs/a.md',
      'docs/b.md',
      'docs/c.md',
    ]);
    // The Dependency Base is not the Integration Branch: no factory/<job-id> branch exists.
    expect(git(clone, ['branch', '--list', `factory/${job.id}`]).trim()).toBe('');
    const dWorktree = events.find(
      (e) => e.type === 'worktree.created' && e.payload['taskId'] === d.id,
    );
    expect(dWorktree?.payload['dependencyBase']).toEqual(['b', 'c']);

    // Each Attempt leased its own port block: B and C, running together, got different ones.
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${job.id}/worktrees`));
    const portOf = (span: Span) => worktrees.find((w) => w.taskId === span.id)?.portBase;
    expect(portOf(b)).not.toBe(portOf(c));
  });
});

describe('concurrency limits', { timeout: 60_000 }, () => {
  /** Three independent Tasks, each a 1.5 s developer Run. */
  const threeTasks = () =>
    scriptWith(
      { planning: [{ output: { tasks: [docTask('x'), docTask('y'), docTask('z')] } }] },
      {
        x: docRun('x', { delayMs: 1500 }),
        y: docRun('y', { delayMs: 1500 }),
        z: docRun('z', { delayMs: 1500 }),
      },
      { x: APPROVE, y: APPROVE, z: APPROVE },
    );

  async function inFlight(rt: RunningRuntime, job: JobBody) {
    const settled = await waitForJob(rt, job.id, jobSettled, 40_000);
    expect(settled.status).toBe('completed');
    return maxInFlight((await lifetimes(rt, job.id)).byKey.values());
  }

  it('runs at most perJob (default 2) Tasks of one Job at once', async () => {
    const { rt, repo } = await runtimeWith(threeTasks());
    const job = await createJob(rt, repo.id);
    expect(job.effectiveConfig).toMatchObject({
      concurrency: {
        perRepository: { value: 2, source: 'recipe' },
        perJob: { value: 2, source: 'recipe' },
      },
    });
    expect(await inFlight(rt, job)).toBe(2);
  });

  it('lets a Job raise its limits at creation (factory job create --per-repository --per-job)', async () => {
    const { rt } = await runtimeWith(threeTasks());
    const res = await rt.home.cli([
      'job',
      'create',
      '--repo',
      'tiny-ts',
      '--title',
      'Write the docs',
      '--per-repository',
      '3',
      '--per-job',
      '3',
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('concurrency.perRepository=3 (from job)');
    expect(res.stdout).toContain('concurrency.perJob=3 (from job)');
    const [job] = await json<JobBody[]>(rt.request('/v1/jobs'));
    if (job === undefined) throw new Error('no Job');
    expect(await inFlight(rt, job)).toBe(3);
  });

  it('keeps the per-Repository limit when only perJob is raised', async () => {
    const { rt, repo } = await runtimeWith(threeTasks());
    const job = await createJob(rt, repo.id, { concurrency: { perJob: 3 } });
    expect(await inFlight(rt, job)).toBe(2);
  });

  it('lets a Job lower its limit to run its Tasks one at a time', async () => {
    const { rt, repo } = await runtimeWith(threeTasks());
    const job = await createJob(rt, repo.id, { concurrency: { perJob: 1 } });
    expect(job.effectiveConfig).toMatchObject({
      concurrency: { perJob: { value: 1, source: 'job' } },
    });
    expect(await inFlight(rt, job)).toBe(1);
  });

  it('holds config.json concurrency.global over every Job limit', async () => {
    const { rt, repo } = await runtimeWith(threeTasks(), { concurrency: { global: 1 } });
    const job = await createJob(rt, repo.id, { concurrency: { perRepository: 3, perJob: 3 } });
    expect(await inFlight(rt, job)).toBe(1);
  });

  it('refuses a Job override outside 1–16', async () => {
    const { rt, repo } = await runtimeWith(threeTasks());
    const res = await post(rt, '/v1/jobs', {
      repositoryId: repo.id,
      title: 'Too wide',
      concurrency: { perJob: 0 },
    });
    expect(res.status).toBe(400);
  });
});
