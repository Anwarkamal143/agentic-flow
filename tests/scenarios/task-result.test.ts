/**
 * The Harness's word is never enough (#10, ROADMAP exit tests A3 and A4). A
 * missing or invalid Task Result gets one re-prompt, in a new Session within
 * the same Attempt, that carries the violated rules; still invalid, the
 * Attempt fails `invalid_output` and its commits stay on the Task Branch. A
 * claim that an Acceptance Criterion is met counts for nothing: the factory's
 * own Evidence decides.
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
  skipPlanApproval,
} from '../support/api.js';
import { scriptWith, SUM_SOURCE, validTaskResponse } from '../support/scripts.js';

interface AttemptBody {
  id: string;
  n: number;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  headSha: string | null;
  commits: string[];
  worktreeId: string;
  cause: string;
  packet: { context: { priorFindings: { rule: string | null; attemptN: number }[] } };
  evidence: {
    kind: string;
    source: string;
    criterionCode: string | null;
    verdict: string;
    headSha: string;
  }[];
}

const settled = (job: JobBody) =>
  ['completed', 'failed', 'cancelled', 'waiting_human', 'blocked'].includes(job.status);

/** A runtime with the Fake Harness on `script` and a registered `tiny-ts`. */
async function runtimeWith(script: string) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; projectId: string; clonePath: string }]>(
    rt.request('/v1/repositories'),
  );
  await skipPlanApproval(rt, repo.projectId);
  return { rt, repo };
}

async function runJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Add sum() to math.ts' });
  expect(res.status).toBe(201);
  const created = (await res.json()) as JobBody;
  return waitForJob(rt, created.id, settled, 20_000);
}

/** The developer Harness Runs of an Attempt, as their `harness_run.started` events. */
async function developerRuns(rt: RunningRuntime, jobId: string, attemptId: string) {
  const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
  return events.filter(
    (e) =>
      e.type === 'harness_run.started' &&
      e.payload['role'] === 'developer' &&
      e.payload['attemptId'] === attemptId,
  );
}

/** A developer response that does the work but writes no Task Result. */
function workWithoutResult() {
  const response = validTaskResponse();
  delete (response as { result?: unknown }).result;
  return response;
}

/** A re-prompted developer response: the work is already committed, so it only writes the result. */
function resultOnly(result: unknown = validTaskResponse().result) {
  return { steps: [], result };
}

/** Wrong work (no sum()) whose Task Result still claims AC-01 is met. */
function falseClaim() {
  const response = validTaskResponse();
  response.steps = [
    { write: { path: 'src/math.ts', content: '// sum() is coming\n' } },
    { commit: 'Claim sum() without writing it' },
  ];
  expect(response.result['criteria']).toEqual([
    expect.objectContaining({ code: 'AC-01', claim: 'met' }),
  ]);
  return response;
}

describe('the Task Result is checked, re-prompted once, and never trusted', () => {
  it('a single invalid output followed by a valid one on the re-prompt succeeds within the same Attempt', async () => {
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {},
        { 'add-sum': [{ ...workWithoutResult(), resultRaw: '{"status": ' }, resultOnly()] },
      ),
    );

    const job = await runJob(rt, repo.id);

    expect(job.status).toBe('completed');
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ n: 1, state: 'passed', exitReason: 'completed' });
    const runs = await developerRuns(rt, job.id, attempt.id);
    expect(runs.map((r) => r.payload['reprompt'] === undefined)).toEqual([true, false]);
    const reprompt = runs[1]?.payload['reprompt'] as { issues: { rule: string }[] };
    expect(reprompt.issues.map((i) => i.rule)).toEqual(['json']);
    expect(runs[1]?.payload['sessionRef'], 'the re-prompt is a new Session').not.toBe(
      runs[0]?.payload['sessionRef'],
    );
  });

  it('A4 invalid output: no Task Result, one re-prompt, then the Attempt fails invalid_output with its commits kept on the Task Branch', async () => {
    const { rt, repo } = await runtimeWith(
      scriptWith({}, { 'add-sum': [workWithoutResult(), { steps: [] }] }),
    );

    const job = await runJob(rt, repo.id);

    // invalid_output is no verdict on the work, so no Rework follows (Retry is #13).
    expect(job.status).toBe('failed');
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ n: 1, state: 'failed', exitReason: 'invalid_output' });
    expect(attempt.exitDetail).toContain('[result.missing]');
    expect(attempt.exitDetail).toContain('after 1 re-prompt');
    const runs = await developerRuns(rt, job.id, attempt.id);
    expect(runs, 'the first Run and exactly one re-prompt').toHaveLength(2);
    expect(runs[1]?.payload['reprompt']).toMatchObject({
      issues: [{ rule: 'result.missing' }],
    });

    const [worktree] = await json<[{ branch: string; state: string }]>(
      rt.request(`/v1/jobs/${job.id}/worktrees`),
    );
    expect(worktree.state).toBe('preserved');
    const branchHead = git(repo.clonePath, ['rev-parse', worktree.branch]).trim();
    expect(branchHead).toBe(attempt.headSha);
    expect(attempt.commits).toHaveLength(1);
    expect(git(repo.clonePath, ['log', '--format=%s', worktree.branch, '-1']).trim()).toBe(
      'Add sum() to math.ts',
    );
    expect(git(repo.clonePath, ['show', `${worktree.branch}:src/math.ts`])).toContain(
      'export function sum',
    );
    // The Attempt's head is pinned too, whatever later happens to the branch.
    expect(git(repo.clonePath, ['rev-parse', `refs/factory/attempts/${attempt.id}`]).trim()).toBe(
      attempt.headSha,
    );
  });

  it.each([
    {
      name: 'malformed JSON',
      response: { resultRaw: '{"status": "done",' },
      rule: 'json',
      message: 'not JSON',
    },
    {
      name: 'an unknown status',
      response: { result: { ...validTaskResponse().result, status: 'finished' } },
      rule: 'schema',
      message: 'status:',
    },
    {
      name: 'missing required fields',
      response: { result: { status: 'done', commits: [] } },
      rule: 'schema',
      message: 'summary:',
    },
  ])(
    'rejects $name, naming the violated rule, on the first Run and on the re-prompt',
    async (c) => {
      const { rt, repo } = await runtimeWith(
        scriptWith(
          {},
          {
            'add-sum': [
              { ...workWithoutResult(), ...c.response },
              { steps: [], ...c.response },
            ],
          },
        ),
      );

      const job = await runJob(rt, repo.id);

      expect(job.status).toBe('failed');
      const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
      expect(attempt).toMatchObject({ state: 'failed', exitReason: 'invalid_output' });
      expect(attempt.exitDetail).toContain(`[${c.rule}] `);
      expect(attempt.exitDetail).toContain(c.message);
      const [, reprompt] = await developerRuns(rt, job.id, attempt.id);
      const issues = (
        reprompt?.payload['reprompt'] as { issues: { rule: string; message: string }[] }
      ).issues;
      expect(issues.map((i) => i.rule)).toContain(c.rule);
      expect(issues.some((i) => i.message.includes(c.message))).toBe(true);
    },
  );

  it('A3 false claim, then Rework: the ignored claim sends the Task to a Rework Attempt that fixes the work', async () => {
    const fixed = validTaskResponse();
    fixed.steps = [
      { write: { path: 'src/math.ts', content: SUM_SOURCE } },
      { commit: 'Add sum() for real' },
    ];
    const { rt, repo } = await runtimeWith(scriptWith({}, { 'add-sum': [falseClaim(), fixed] }));

    const job = await runJob(rt, repo.id);

    expect(job.status).toBe('completed');
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'initial', 'failed', 'gates_failed'],
      [2, 'rework', 'passed', 'completed'],
    ]);
    // The Rework Attempt is told what the factory found, not what the Harness claimed.
    const carried = attempts[1]?.packet.context.priorFindings.map((f) => [f.attemptN, f.rule]);
    expect(carried).toContainEqual([1, 'criteria']);
  });

  it("A3 false claim: the Task Result says AC-01 is met, the factory's test fails, so the claim is ignored and the Task is not approved", async () => {
    const { rt, repo } = await runtimeWith(scriptWith({}, { 'add-sum': [falseClaim()] }));
    await capAttempts(rt, repo.projectId, 1);

    const job = await runJob(rt, repo.id);

    await expectStoppedAtCap(rt, job);
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'gates_failed' });
    // The factory's Evidence for AC-01 is its own failed test run, at the Attempt's head.
    expect(
      attempt.evidence
        .filter((e) => e.kind === 'criterion')
        .map((e) => [e.criterionCode, e.source, e.verdict, e.headSha]),
    ).toEqual([['AC-01', 'commands', 'fail', attempt.headSha]]);
    const tasks = await json<{ state: string }[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.map((t) => t.state)).not.toContain('approved');
    // The claim is kept as the Harness's Artifact, and is evidence of nothing.
    const artifacts = await json<{ id: string; kind: string; attemptId: string | null }[]>(
      rt.request(`/v1/jobs/${job.id}/artifacts`),
    );
    const claim = artifacts.find((a) => a.kind === 'task_result' && a.attemptId === attempt.id);
    expect(claim).toBeDefined();
    const stored = await json<{ criteria: { code: string; claim: string }[] }>(
      rt.request(`/v1/artifacts/${String(claim?.id)}/content`),
    );
    expect(stored.criteria).toEqual([expect.objectContaining({ code: 'AC-01', claim: 'met' })]);
    // No reviewer ever runs on work that failed the factory's Gates.
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    expect(
      events.filter((e) => e.type === 'harness_run.started' && e.payload['role'] === 'reviewer'),
    ).toEqual([]);
    // No Delivery Report claims anything either.
    expect(artifacts.map((a) => a.kind)).not.toContain('report');
  });
});
