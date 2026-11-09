/**
 * The path-scope Gate and Rework (#9, ROADMAP exit test A2). A Task can't
 * change code outside its scope unnoticed, and a failed Gate or a blocking
 * review Finding starts a new Attempt that carries the Findings, up to the
 * Task's `max_attempts`. Hitting the cap, or a Finding that blames the Plan
 * or the Specification, stops with a human Blocker: the Job is
 * `waiting_human` and nothing loops.
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
  expectStoppedAtCap,
  json,
  onlyAttempt,
  post,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validReviewResponse, validTaskResponse } from '../support/scripts.js';

interface FindingBody {
  attemptId: string;
  attemptN: number;
  source: string;
  rule: string | null;
  reviewId: string | null;
  severity: string;
  faultOrigin: string;
  location: string;
  problem: string;
  blocking: boolean;
  paths: string[];
}

interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  baseSha: string;
  headSha: string | null;
  commits: string[];
  worktreeId: string;
  findings: FindingBody[];
  packet: { context: { priorFindings: FindingBody[] } };
  verificationRuns: { key: string; exitCode: number | null; headSha: string }[];
  evidence: { kind: string; verdict: string; headSha: string }[];
}

interface BlockerBody {
  kind: string;
  reason: string;
  detail: string;
  requiredAction: string;
  taskId: string;
  attemptId: string;
}

interface TaskBody {
  id: string;
  key: string;
  state: string;
  maxAttempts: number;
  blocker: BlockerBody | null;
}

const settled = (job: JobBody) =>
  ['completed', 'failed', 'cancelled', 'waiting_human', 'blocked'].includes(job.status);

async function runWith(script: string, opts: { maxAttempts?: number } = {}) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; projectId: string; clonePath: string }]>(
    rt.request('/v1/repositories'),
  );
  if (opts.maxAttempts !== undefined) await capAttempts(rt, repo.projectId, opts.maxAttempts);
  const created = await post(rt, '/v1/jobs', {
    repositoryId: repo.id,
    title: 'Add sum() to math.ts',
    description: 'Export sum(a, b) from src/math.ts.',
  });
  expect(created.status).toBe(201);
  const job = await waitForJob(rt, ((await created.json()) as JobBody).id, settled, 40_000);
  return { rt, repo, job };
}

const attemptsOf = (rt: RunningRuntime, jobId: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
const tasksOf = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
const eventsOf = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));

/** The valid developer response, plus a commit that changes the forbidden `package.json`. */
function touchingPackageJson(content = '{ "name": "tiny-ts", "scripts": {} }\n') {
  const response = validTaskResponse();
  response.steps.push(
    { write: { path: 'package.json', content } },
    { commit: 'Also change package.json' },
  );
  return response;
}

/** A developer response for a later Attempt that changes `package.json` again (and nothing else). */
function touchingOnlyPackageJson(content: string) {
  return {
    steps: [{ write: { path: 'package.json', content } }, { commit: 'Change package.json again' }],
    result: validTaskResponse().result,
  };
}

/** A developer response for a later Attempt: restores `package.json` from the base, keeps sum(). */
function restoringPackageJson(base = 'origin/main') {
  return {
    steps: [{ run: `git checkout ${base} -- package.json` }, { commit: 'Restore package.json' }],
    result: { ...validTaskResponse().result, summary: 'Restored package.json.' },
  };
}

function blockingReview(faultOrigin: string) {
  const review = validReviewResponse();
  review.output.outcome = 'changes_requested';
  review.output.findings = [
    {
      severity: 'high',
      faultOrigin,
      location: 'src/math.ts:6',
      problem: 'sum() has no test for negative numbers.',
      why: 'The Specification lists negative numbers as an edge case.',
      recommendation: 'Add a test for sum(-2, -3).',
      blocking: true,
    },
  ];
  return review;
}

describe('The path-scope Gate and Rework', () => {
  it('A2: a forbidden path fails the Gate, a Rework Attempt carries the Finding, complies, and is approved', async () => {
    const { rt, repo, job } = await runWith(
      scriptWith({}, { 'add-sum': [touchingPackageJson(), restoringPackageJson()] }),
    );

    expect(job.status).toBe('completed');
    const [task] = (await tasksOf(rt, job.id)) as [TaskBody];
    expect(task).toMatchObject({ state: 'approved', blocker: null });
    const attempts = await attemptsOf(rt, job.id);
    expect(attempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'failed', 'gates_failed'],
      [2, 'rework', 'passed', 'completed'],
    ]);
    const [first, second] = attempts as [AttemptBody, AttemptBody];

    // The Gate names the rule and the path; nothing after it ran on out-of-scope work.
    expect(first.exitDetail).toContain('[scope.forbidden]');
    expect(first.exitDetail).toContain('package.json (modified, matches forbidden package.json)');
    expect(first.findings).toEqual([
      expect.objectContaining({
        attemptId: first.id,
        attemptN: 1,
        source: 'gate',
        rule: 'scope.forbidden',
        reviewId: null,
        faultOrigin: 'implementation',
        blocking: true,
        paths: ['package.json'],
      }),
    ]);
    expect(first.verificationRuns).toEqual([]);

    // The Rework Attempt's packet carries the Finding; it works on the same Task Branch.
    expect(second.packet.context.priorFindings).toEqual(first.findings);
    expect(second.findings.map((f) => [f.source, f.severity, f.blocking])).toEqual([
      ['review', 'low', false],
    ]);
    expect(second.worktreeId).toBe(first.worktreeId);
    expect(second.baseSha).toBe(first.baseSha);
    const events = await eventsOf(rt, job.id);
    const started = events.filter((e) => e.type === 'attempt.started');
    expect(started.map((e) => [e.payload['n'], e.payload['cause']])).toEqual([
      [1, 'initial'],
      [2, 'rework'],
    ]);
    const taskSteps = events
      .filter((e) => e.entityKind === 'task')
      .map((e) => e.payload['to'] as string);
    expect(taskSteps).toContain('changes_requested');

    // The earlier Attempt stays retrievable: its commits, its pinned head and its record.
    expect(first.commits).toHaveLength(2);
    expect(git(repo.clonePath, ['rev-parse', `refs/factory/attempts/${first.id}`]).trim()).toBe(
      first.headSha,
    );
    expect(git(repo.clonePath, ['rev-parse', `refs/factory/attempts/${second.id}`]).trim()).toBe(
      second.headSha,
    );
    expect(second.commits).toEqual(expect.arrayContaining(first.commits));
    expect(second.verificationRuns.map((r) => [r.key, r.exitCode])).toEqual([
      ['test', 0],
      ['typecheck', 0],
    ]);
    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toMatch(/add-sum attempt 1 +failed/);
    expect(show.stdout).toMatch(/gate +scope\.forbidden +package\.json/);
    expect(show.stdout).toMatch(/add-sum attempt 2 +passed/);
    expect(show.stdout).toContain(
      'Attempt 1 committed changes to out-of-scope paths (package.json)',
    );
  });

  it('judges nested paths, renames, deletions and dotfiles, naming each rule and its paths (one Attempt at cap 1)', async () => {
    const developer = validTaskResponse();
    developer.steps.push(
      { write: { path: 'test/deep/nested/more.test.ts', content: 'export {};\n' } },
      { write: { path: '.github/workflows/ci.yml', content: 'on: push\n' } },
      { write: { path: '.env.local', content: 'X=1\n' } },
      { run: 'mkdir -p lib && git mv src/math.ts lib/math.ts' },
      { delete: 'package.json' },
      { commit: 'Move things around' },
    );
    const { rt, job } = await runWith(scriptWith({}, { 'add-sum': [developer] }), {
      maxAttempts: 1,
    });

    await expectStoppedAtCap(rt, job);
    const first = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(first).toMatchObject({ state: 'failed', exitReason: 'gates_failed' });
    expect(first.findings.map((f) => [f.rule, f.paths])).toEqual([
      ['scope.forbidden', ['.github/workflows/ci.yml', 'package.json']],
      ['scope.outside_writable', ['.env.local', 'lib/math.ts']],
    ]);
    expect(first.exitDetail).toContain(
      '.github/workflows/ci.yml (added, matches forbidden .github/**)',
    );
    expect(first.exitDetail).toContain('package.json (deleted, matches forbidden package.json)');
    expect(first.exitDetail).toContain(
      '[scope.outside_writable] the diff touches paths outside the writable scope (src/math.ts, test/**): .env.local (added), lib/math.ts (added)',
    );
  });

  it('reworks a blocking review Finding, and the next packet contains it', async () => {
    const second = {
      steps: [
        { write: { path: 'test/sum.test.ts', content: '// sum(-2, -3) === -5\n' } },
        { commit: 'Test negative numbers' },
      ],
      result: validTaskResponse().result,
    };
    const { rt, job } = await runWith(
      scriptWith(
        {},
        { 'add-sum': [validTaskResponse(), second] },
        { 'add-sum': [blockingReview('implementation'), validReviewResponse()] },
      ),
    );

    expect(job.status).toBe('completed');
    const attempts = await attemptsOf(rt, job.id);
    expect(attempts.map((a) => [a.n, a.state, a.exitReason])).toEqual([
      [1, 'failed', 'changes_requested'],
      [2, 'passed', 'completed'],
    ]);
    const [first, rework] = attempts as [AttemptBody, AttemptBody];
    const reviews = await json<{ id: string; attemptId: string; outcome: string }[]>(
      rt.request(`/v1/jobs/${job.id}/reviews`),
    );
    expect(reviews.map((r) => [r.attemptId, r.outcome])).toEqual([
      [first.id, 'changes_requested'],
      [rework.id, 'approved'],
    ]);
    expect(first.findings).toEqual([
      expect.objectContaining({
        attemptId: first.id,
        source: 'review',
        rule: null,
        reviewId: reviews[0]?.id,
        severity: 'high',
        faultOrigin: 'implementation',
        problem: 'sum() has no test for negative numbers.',
        blocking: true,
        paths: [],
      }),
    ]);
    expect(rework.packet.context.priorFindings).toEqual(first.findings);
    // The earlier Attempt keeps its Evidence, tied to its own head.
    expect(first.verificationRuns.map((r) => [r.key, r.exitCode, r.headSha])).toEqual([
      ['test', 0, first.headSha],
      ['typecheck', 0, first.headSha],
    ]);
    expect(first.evidence.map((e) => [e.kind, e.verdict])).toEqual([
      ['verification', 'pass'],
      ['verification', 'pass'],
      ['criterion', 'pass'],
      ['criterion', 'pass'],
    ]);
    for (const e of first.evidence) expect(e.headSha).toBe(first.headSha);
    expect(first.headSha).not.toBe(rework.headSha);
  });

  it('stops at the Rework cap with a human Blocker: waiting_human, and no further Attempt starts', async () => {
    const { rt, job } = await runWith(
      scriptWith(
        {},
        {
          'add-sum': [
            touchingPackageJson(),
            touchingOnlyPackageJson('{ "name": "two" }\n'),
            touchingOnlyPackageJson('{ "name": "three" }\n'),
            restoringPackageJson(),
          ],
        },
      ),
    );

    expect(job.status).toBe('waiting_human');
    const attempts = await attemptsOf(rt, job.id);
    expect(attempts.map((a) => [a.n, a.state, a.exitReason])).toEqual([
      [1, 'failed', 'gates_failed'],
      [2, 'failed', 'gates_failed'],
      [3, 'failed', 'gates_failed'],
    ]);
    const [task] = (await tasksOf(rt, job.id)) as [TaskBody];
    expect(task.maxAttempts).toBe(3);
    expect(task.state).toBe('blocked');
    expect(task.blocker).toMatchObject({
      kind: 'human',
      reason: 'rework_cap_reached',
      taskId: task.id,
      attemptId: attempts[2]?.id,
    });
    const execution = job.stageRuns.find((s) => s.stageId === 'execution');
    expect(execution).toMatchObject({ state: 'waiting_human', blocker: task.blocker });

    // Nothing loops: no fourth developer Run, however long we wait.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const events = await eventsOf(rt, job.id);
    const developerRuns = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer',
    );
    expect(developerRuns).toHaveLength(3);
    expect(await attemptsOf(rt, job.id)).toHaveLength(3);

    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toMatch(/blocker +human +rework_cap_reached/);

    // The operator can still cancel it.
    const cancelled = await post(rt, `/v1/jobs/${job.id}/cancel`, {
      expectedVersion: (await json<JobBody>(rt.request(`/v1/jobs/${job.id}`))).version,
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as JobBody).status).toBe('cancelled');
    expect((await tasksOf(rt, job.id))[0]?.state).toBe('cancelled');
  });

  it('routes a blocking Finding with Fault Origin plan or spec to a human', async () => {
    const [plan, spec] = await Promise.all([
      runWith(scriptWith({}, {}, { 'add-sum': [blockingReview('plan')] })),
      runWith(scriptWith({}, {}, { 'add-sum': [blockingReview('spec')] })),
    ]);

    for (const [{ rt, job }, reason] of [
      [plan, 'fault_origin_plan'],
      [spec, 'fault_origin_spec'],
    ] as const) {
      expect(job.status).toBe('waiting_human');
      const attempts = await attemptsOf(rt, job.id);
      expect(attempts.map((a) => [a.n, a.state, a.exitReason])).toEqual([
        [1, 'failed', 'changes_requested'],
      ]);
      const [task] = (await tasksOf(rt, job.id)) as [TaskBody];
      expect(task).toMatchObject({ state: 'blocked', blocker: { kind: 'human', reason } });
      expect(job.stageRuns.find((s) => s.stageId === 'execution')?.state).toBe('waiting_human');
    }
  });
});
