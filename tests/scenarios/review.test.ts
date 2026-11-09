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
import {
  scriptWith,
  validOutput,
  validReviewResponse,
  validTaskResponse,
  VALID_SCRIPT,
} from '../support/scripts.js';

interface FindingBody {
  id: string;
  severity: string;
  faultOrigin: string;
  location: string;
  problem: string;
  why: string;
  recommendation: string;
  blocking: boolean;
}

interface ReviewBody {
  id: string;
  taskId: string;
  attemptId: string;
  reviewer: { harnessId: string; version: string | null };
  sessionRef: string | null;
  promptTemplate: { id: string; hash: string };
  headSha: string;
  baseSha: string;
  outcome: string;
  summary: string;
  artifactId: string;
  packet: Record<string, unknown> & {
    subject: { headSha: string; baseSha: string; attemptId: string };
    acceptanceCriteria: { code: string; mandatory: boolean }[];
    diff: { files: string[]; patch: string; truncated: boolean };
    evidence: { kind: string; key?: string; code?: string; verdict: string; headSha: string }[];
  };
  findings: FindingBody[];
}

interface AttemptBody {
  id: string;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  sessionRef: string | null;
  baseSha: string;
  headSha: string | null;
  evidence: { kind: string; source: string; criterionCode: string | null; verdict: string }[];
}

const done = (job: JobBody) =>
  ['completed', 'failed', 'cancelled', 'waiting_human'].includes(job.status);

/**
 * Runs one Job on `script`. `maxAttempts: 1` is for a scenario about one Attempt's
 * verdict: it ends at the Rework cap instead of starting a Rework it didn't script.
 */
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
  const job = await waitForJob(rt, ((await created.json()) as JobBody).id, done, 20_000);
  return { rt, repo, job };
}

const reviewsOf = (rt: RunningRuntime, jobId: string) =>
  json<ReviewBody[]>(rt.request(`/v1/jobs/${jobId}/reviews`));
const attemptsOf = (rt: RunningRuntime, jobId: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));

describe('The independent review Gate', () => {
  it('starts the reviewer in a new Session with only the spec, the ACs, the diff and the Evidence', async () => {
    const developer = validTaskResponse();
    developer.result['summary'] = 'IMPLEMENTER-CLAIM: trust me, it is all done.';
    // The reviewer fails unless the implementer's Task Result is out of its sight.
    const reviewer = { ...validReviewResponse(), steps: [{ run: 'test ! -e .factory' }] };
    const { rt, job } = await runWith(
      scriptWith({}, { 'add-sum': [developer] }, { 'add-sum': [reviewer] }),
    );

    expect(job.status).toBe('completed');
    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    const [review] = (await reviewsOf(rt, job.id)) as [ReviewBody];

    // A fresh Session: its own, never the implementer's.
    expect(review.sessionRef).toEqual(expect.any(String));
    expect(attempt.sessionRef).toEqual(expect.any(String));
    expect(review.sessionRef).not.toBe(attempt.sessionRef);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const runs = events.filter((e) => e.type === 'harness_run.started' && e.payload['taskId']);
    expect(runs.map((e) => [e.payload['role'], e.payload['sessionRef']])).toEqual([
      ['developer', attempt.sessionRef],
      ['reviewer', review.sessionRef],
    ]);

    // The recorded packet: the Specification, the ACs, the diff and the Evidence; nothing else.
    const { packet } = review;
    expect(Object.keys(packet).sort()).toEqual(
      [
        'acceptanceCriteria',
        'diff',
        'evidence',
        'packetVersion',
        'specification',
        'subject',
      ].sort(),
    );
    expect(packet['specification']).toEqual(validOutput('specification'));
    expect(packet.acceptanceCriteria.map((c) => [c.code, c.mandatory])).toEqual([['AC-01', true]]);
    expect(packet.diff.files).toEqual(['src/math.ts']);
    expect(packet.diff.patch).toContain('+export function sum(a: number, b: number): number {');
    expect(packet.diff.truncated).toBe(false);
    expect(packet.evidence.map((e) => [e.kind, e.key ?? e.code, e.verdict])).toEqual([
      ['verification', 'test', 'pass'],
      ['verification', 'typecheck', 'pass'],
      ['criterion', 'AC-01', 'pass'],
    ]);
    for (const e of packet.evidence) expect(e.headSha).toBe(attempt.headSha);
    expect(packet.subject).toMatchObject({
      attemptId: attempt.id,
      headSha: attempt.headSha,
      baseSha: attempt.baseSha,
    });
    expect(JSON.stringify(packet)).not.toContain('IMPLEMENTER-CLAIM');
    expect(review.promptTemplate.id).toBe('review-packet@1');
    expect(review.promptTemplate.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('makes the review and its Findings retrievable via the API, tied to the reviewed SHAs', async () => {
    const { rt, repo, job } = await runWith(VALID_SCRIPT);

    expect(job.status).toBe('completed');
    const [attempt] = (await attemptsOf(rt, job.id)) as [AttemptBody];
    const reviews = await reviewsOf(rt, job.id);
    expect(reviews).toHaveLength(1);
    const [review] = reviews as [ReviewBody];
    const [task] = await json<[{ id: string; key: string }]>(
      rt.request(`/v1/jobs/${job.id}/tasks`),
    );
    const branch = `factory/${job.id}/${task.id}-add-sum`;
    expect(review).toMatchObject({
      taskId: task.id,
      attemptId: attempt.id,
      reviewer: { harnessId: 'fake', version: '1' },
      outcome: 'approved',
      summary: 'sum() is correct and exported from src/math.ts.',
      headSha: git(repo.clonePath, ['rev-parse', branch]).trim(),
      baseSha: attempt.baseSha,
    });
    expect(review.findings).toEqual([
      {
        id: expect.any(String) as string,
        severity: 'low',
        faultOrigin: 'implementation',
        location: 'src/math.ts:6',
        problem: 'No test covers negative numbers.',
        why: 'The Specification lists negative numbers as an edge case.',
        recommendation: 'Add a test for sum(-2, -3).',
        blocking: false,
      },
    ]);

    // Stored as an Artifact: the validated proposal, as the reviewer gave it.
    const artifact = await json<{ kind: string; attemptId: string }>(
      rt.request(`/v1/artifacts/${review.artifactId}`),
    );
    expect(artifact).toMatchObject({ kind: 'review', attemptId: attempt.id });
    const content = await json<{ outcome: string; findings: unknown[] }>(
      rt.request(`/v1/artifacts/${review.artifactId}/content`),
    );
    expect(content).toEqual(validReviewResponse().output);

    // The review's criterion verdict is Evidence of its own, beside the commands'.
    expect(
      attempt.evidence
        .filter((e) => e.kind === 'criterion')
        .map((e) => [e.source, e.criterionCode, e.verdict]),
    ).toEqual([
      ['commands', 'AC-01', 'pass'],
      ['review', 'AC-01', 'pass'],
    ]);

    // And the CLI shows it.
    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toMatch(/review +approved/);
    expect(show.stdout).toMatch(/low +implementation +src\/math\.ts:6/);
  });

  it('treats a review recorded for an older head SHA as stale → one Attempt, then waiting_human at cap 1', async () => {
    // The reviewer commits during its Run, so the Task Branch moves past the reviewed head.
    const reviewer = {
      ...validReviewResponse(),
      steps: [
        { write: { path: 'src/extra.ts', content: 'export const x = 1;\n' } },
        { commit: 'A commit by the reviewer' },
      ],
    };
    const { rt, repo, job } = await runWith(scriptWith({}, {}, { 'add-sum': [reviewer] }), {
      maxAttempts: 1,
    });

    await expectStoppedAtCap(rt, job);
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    const [review] = (await reviewsOf(rt, job.id)) as [ReviewBody];
    const [task] = await json<[{ id: string; state: string }]>(
      rt.request(`/v1/jobs/${job.id}/tasks`),
    );
    const head = git(repo.clonePath, ['rev-parse', `factory/${job.id}/${task.id}-add-sum`]).trim();
    expect(review.outcome).toBe('approved');
    expect(review.headSha).toBe(attempt.headSha);
    expect(review.headSha, 'the Task Branch moved after the review').not.toBe(head);
    expect(task.state).toBe('blocked');
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'gates_failed' });
    expect(attempt.exitDetail).toMatch(/review .*stale/);
  });

  it('blocks approval when a mandatory AC has no passing Evidence → one Attempt, then waiting_human at cap 1', async () => {
    // No command verifies AC-01, and the reviewer could not test it either.
    const plan = validOutput('planning') as {
      tasks: { verification: { criteria?: string[] }[] }[];
    };
    for (const v of plan.tasks[0]?.verification ?? []) delete v.criteria;
    const reviewer = validReviewResponse();
    reviewer.output.criteria = [
      { code: 'AC-01', verdict: 'not_tested', detail: 'nothing in the diff exercises sum()' },
    ];
    const { rt, job } = await runWith(
      scriptWith({ planning: [{ output: plan }] }, {}, { 'add-sum': [reviewer] }),
      { maxAttempts: 1 },
    );

    await expectStoppedAtCap(rt, job);
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'gates_failed' });
    expect(attempt.exitDetail).toContain('mandatory AC-01 has Evidence not_tested, not pass');
    const [review] = (await reviewsOf(rt, job.id)) as [ReviewBody];
    expect(review.outcome, 'the review itself approved').toBe('approved');
  });

  it('does not approve a Task whose review requests changes → one Attempt, then waiting_human at cap 1', async () => {
    const reviewer = validReviewResponse();
    reviewer.output.outcome = 'changes_requested';
    reviewer.output.findings = [
      {
        severity: 'high',
        faultOrigin: 'implementation',
        location: 'src/math.ts:6',
        problem: 'sum() ignores its second argument.',
        why: 'AC-01 needs sum(2, 3) to be 5.',
        recommendation: 'Return a + b.',
        blocking: true,
      },
    ];
    const { rt, job } = await runWith(scriptWith({}, {}, { 'add-sum': [reviewer] }), {
      maxAttempts: 1,
    });

    await expectStoppedAtCap(rt, job);
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'changes_requested' });
    const [review] = (await reviewsOf(rt, job.id)) as [ReviewBody];
    expect(review.findings.map((f) => [f.severity, f.blocking])).toEqual([['high', true]]);
  });

  it('re-prompts an invalid review once, in a new Session, then fails with invalid_output', async () => {
    const valid = validReviewResponse();
    const reprompted = await runWith(
      scriptWith({}, {}, { 'add-sum': [{ raw: 'looks good to me' }, valid] }),
    );
    const twiceInvalid = await runWith(
      scriptWith({}, {}, { 'add-sum': [{ raw: 'looks good to me' }, { raw: '{}' }] }),
    );

    expect(reprompted.job.status).toBe('completed');
    const events = await json<EventBody[]>(
      reprompted.rt.request(`/v1/jobs/${reprompted.job.id}/events?limit=1000`),
    );
    const reviewerRuns = events.filter(
      (e) => e.type === 'harness_run.started' && e.payload['role'] === 'reviewer',
    );
    expect(reviewerRuns.map((e) => e.payload['n'])).toEqual([1, 2]);
    expect(reviewerRuns[1]?.payload['reprompt']).toMatchObject({ issues: [{ rule: 'json' }] });
    expect(new Set(reviewerRuns.map((e) => e.payload['sessionRef'])).size).toBe(2);

    // invalid_output is no verdict on the work, so no Rework follows: the Job fails on Attempt 1.
    expect(twiceInvalid.job.status).toBe('failed');
    const attempt = await onlyAttempt<AttemptBody>(twiceInvalid.rt, twiceInvalid.job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'invalid_output' });
    expect(attempt.exitDetail).toMatch(/review was invalid after 1 re-prompt/);
    expect(
      await reviewsOf(twiceInvalid.rt, twiceInvalid.job.id),
      'nothing invalid is stored',
    ).toEqual([]);
  });

  it('fails the Attempt with review_failed when the reviewer Harness Run crashes', async () => {
    const { rt, job } = await runWith(scriptWith({}, {}, { 'add-sum': [{ exitCode: 2 }] }));

    // review_failed is no verdict on the work, so no Rework follows: the Job fails on Attempt 1.
    expect(job.status).toBe('failed');
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'review_failed' });
    expect(attempt.exitDetail).toMatch(/reviewer Harness Run exited with code 2/);
    expect(await reviewsOf(rt, job.id)).toEqual([]);
  });
});
