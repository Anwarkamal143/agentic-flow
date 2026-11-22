/**
 * The Integration Review (#56, C8, ARCHITECTURE §9, ADR-0035). Once the
 * Integration Branch passes its Gates, a fresh-session review judges the whole
 * combined change against the whole Specification, valid only for the
 * integration `(head_sha, base_sha)`. A blocking `implementation` Finding is
 * reworked on the Integration Branch inside `integration_review`, within the
 * union of the Plan Tasks' writable globs; a `plan` Finding replans and
 * cancels the Integration Task. A single-Task Job whose Integration Branch has
 * that Task's reviewed tree skips it, with the reason recorded. Asserted
 * through the API, the CLI and git in the Factory Clone only.
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
  createProject,
  declareCommands,
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput, validTaskResponse } from '../support/scripts.js';

interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
  key: string;
  state: string;
  cancelReason: string | null;
  scope: { writable: string[]; forbidden: string[] };
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
  findings: { source: string; rule?: string; problem: string; paths?: string[] }[];
  packet: {
    scope: { writable: string[] };
    context: { priorFindings: { problem: string; faultOrigin?: string }[] };
  };
}
interface ReviewBody {
  taskId: string;
  attemptId: string;
  promptTemplate: { id: string };
  headSha: string;
  baseSha: string;
  outcome: string;
  findings: { faultOrigin: string; blocking: boolean; problem: string }[];
}
interface WorktreeBody {
  taskId: string;
  branch: string;
  state: string;
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
  questions: { id: string; source: string; paths?: string[] }[] | null;
}
interface ReportBody {
  integration: { branch: string; state: string; headSha: string | null } | null;
}

const SHELL_GIT = `git -c user.name=Upstream -c user.email=upstream@example.invalid`;

/** A Plan Task writing `src/<key>.ts`, checked by its own command. */
function fileTask(key: string) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Write src/${key}.ts`,
    scope: { writable: [`src/${key}.ts`], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [
      { key: 'test', command: 'exists', args: [`src/${key}.ts`], criteria: ['AC-01'] },
    ],
  };
}

/** A developer response writing `path` with `content`, committed, done. */
function writes(path: string, content: string, summary = `Wrote ${path}.`) {
  return {
    steps: [{ write: { path, content } }, { commit: summary }],
    result: {
      status: 'done',
      summary,
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
    },
  };
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
  },
};

/** An Integration Review asking for changes with one blocking Finding of `faultOrigin`. */
function changesRequested(faultOrigin: string, problem: string) {
  return {
    output: {
      outcome: 'changes_requested',
      summary: 'The Tasks are inconsistent together.',
      findings: [
        {
          severity: 'high',
          faultOrigin,
          location: 'src/date-b.ts:1',
          problem,
          why: 'Two helpers with one name and different output will be used interchangeably.',
          recommendation: 'Keep one formatDate and re-export it.',
          blocking: true,
        },
      ],
      criteria: [{ code: 'AC-01', verdict: 'fail', detail: 'the dates disagree' }],
    },
  };
}

const DUPLICATED = 'src/date-a.ts and src/date-b.ts each define formatDate, with different output';

const FORMAT_A =
  'export function formatDate(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n';
const FORMAT_B =
  'export function formatDate(d: Date): string {\n  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;\n}\n';

async function runtimeOn(
  script: (src: string) => string,
  opts: { maxAttempts?: number } = {},
): Promise<{ rt: RunningRuntime; src: string; repo: RepoBody }> {
  const src = tinyTsRepo();
  const home = await initializedHome();
  useFakeHarness(home, script(src));
  const rt = await startRuntime(home);
  await createProject(rt, 'demo');
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes']);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await declareCommands(rt, repo.id);
  if (opts.maxAttempts === undefined) await skipPlanApproval(rt, repo.projectId);
  else await capAttempts(rt, repo.projectId, opts.maxAttempts);
  return { rt, src, repo };
}

async function createJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Format dates' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const settled = (job: JobBody) => job.status !== 'active';

async function read(rt: RunningRuntime, jobId: string) {
  const [tasks, attempts, reviews, worktrees, events] = await Promise.all([
    json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`)),
    json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`)),
    json<ReviewBody[]>(rt.request(`/v1/jobs/${jobId}/reviews`)),
    json<WorktreeBody[]>(rt.request(`/v1/jobs/${jobId}/worktrees`)),
    json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`)),
  ]);
  const integration = tasks.filter((t) => t.kind === 'integration');
  const ids = new Set(integration.map((t) => t.id));
  return {
    tasks,
    attempts,
    worktrees,
    events,
    integration,
    integrationAttempts: attempts.filter((a) => ids.has(a.taskId)),
    integrationReviews: reviews.filter((r) => ids.has(r.taskId)),
  };
}

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

describe('the Integration Review', { timeout: 120_000 }, () => {
  it('C8: catches two approved Tasks inconsistent together, reworks the Integration Branch, and delivers only once it approves the current integration SHA', async () => {
    const fix = writes(
      'src/date-b.ts',
      "export { formatDate } from './date-a.js';\n",
      'Re-export the one formatDate',
    );
    const { rt, src, repo } = await runtimeOn(() =>
      scriptWith(
        { planning: [{ output: { tasks: [fileTask('date-a'), fileTask('date-b')] } }] },
        {
          'date-a': [writes('src/date-a.ts', FORMAT_A)],
          'date-b': [writes('src/date-b.ts', FORMAT_B)],
          integration: [fix],
        },
        {
          // Each Task's own review approves it: alone, each is fine.
          'date-a': [APPROVE],
          'date-b': [APPROVE],
          integration: [changesRequested('implementation', DUPLICATED), APPROVE],
        },
      ),
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    expect(job.status, rt.output()).toBe('completed');
    expect(stagesOf(job, 'integration')).toEqual(['succeeded']);
    expect(stagesOf(job, 'integration_review')).toEqual(['succeeded']);
    const { tasks, integration, integrationAttempts, integrationReviews, events } = await read(
      rt,
      job.id,
    );
    expect(tasks.filter((t) => t.kind === 'plan').map((t) => t.state)).toEqual([
      'approved',
      'approved',
    ]);
    const [task] = integration;
    expect(task?.state).toBe('approved');

    // The merge Attempt passed its Gates, then the Integration Review asked for changes.
    expect(integrationAttempts.map((a) => [a.n, a.cause, a.state, a.exitReason])).toEqual([
      [1, 'merge', 'failed', 'changes_requested'],
      [2, 'rework', 'passed', 'completed'],
    ]);
    const [merge, rework] = integrationAttempts as [AttemptBody, AttemptBody];
    // The Rework is a developer Run on the Integration Branch, carrying the Findings,
    // limited to the union of the Plan Tasks' writable globs.
    expect(rework.packet.context.priorFindings.map((f) => f.problem)).toContain(DUPLICATED);
    expect(rework.packet.scope.writable).toEqual(['src/date-a.ts', 'src/date-b.ts']);
    expect(rework.baseSha).toBe(merge.baseSha);

    // Each Integration Review ran on the integration SHA of its Attempt, base..integration head.
    expect(
      integrationReviews.map((r) => [r.promptTemplate.id, r.outcome, r.headSha, r.baseSha]),
    ).toEqual([
      ['integration-review-packet@1', 'changes_requested', merge.headSha, merge.baseSha],
      ['integration-review-packet@1', 'approved', rework.headSha, merge.baseSha],
    ]);
    expect(integrationReviews[0]?.findings).toMatchObject([
      { faultOrigin: 'implementation', blocking: true, problem: DUPLICATED },
    ]);
    const branch = `factory/${job.id}/integration`;
    const head = git(repo.clonePath, ['rev-parse', branch]).trim();
    expect(rework.headSha).toBe(head);
    expect(git(repo.clonePath, ['show', `${branch}:src/date-b.ts`])).toContain(
      "export { formatDate } from './date-a.js'",
    );

    // Nothing goes out before the approval on the current SHA: closure (the Delivery Report)
    // is queued only after it, the report offers that head, and nothing reached upstream.
    const approvedAt = events.findIndex(
      (e) =>
        e.type === 'review.recorded' &&
        e.payload['outcome'] === 'approved' &&
        e.payload['taskId'] === task?.id,
    );
    const closureQueued = events.findIndex(
      (e) => e.type === 'stage_run.queued' && e.payload['stageId'] === 'closure',
    );
    expect(approvedAt).toBeGreaterThan(-1);
    expect(closureQueued).toBeGreaterThan(approvedAt);
    const artifacts = await json<{ id: string; kind: string }[]>(
      rt.request(`/v1/jobs/${job.id}/artifacts`),
    );
    const reportId = artifacts.find((a) => a.kind === 'report')?.id;
    const report = await json<ReportBody>(rt.request(`/v1/artifacts/${String(reportId)}/content`));
    expect(report.integration).toMatchObject({ branch, state: 'approved', headSha: head });
    expect(git(src, ['branch', '--list', 'factory/*']).trim()).toBe('');

    // job show names the Integration Review Stage.
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toMatch(/integration_review\s+succeeded/);
  });

  it('skips the Integration Review of a single-Task Job on an unchanged base, with the reason', async () => {
    const { rt, repo } = await runtimeOn(() => scriptWith({}));
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status, rt.output()).toBe('completed');
    expect(stagesOf(job, 'integration')).toEqual(['succeeded']);
    expect(stagesOf(job, 'integration_review')).toEqual(['skipped']);
    const { integrationAttempts, integrationReviews, events } = await read(rt, job.id);
    expect(integrationReviews).toEqual([]);
    expect(integrationAttempts.map((a) => [a.cause, a.state])).toEqual([['merge', 'passed']]);
    const skipped = events.find(
      (e) => e.type === 'stage_run.skipped' && e.payload['stageId'] === 'integration_review',
    );
    expect(skipped?.payload['reason']).toMatch(/one Plan Task/);
    expect(skipped?.payload['reason']).toMatch(/same tree/);
  });

  it("reviews a single-Task Job whose base moved: its Integration Branch tree is not the Task's reviewed one", async () => {
    const { rt, repo } = await runtimeOn((dir) => {
      const response = validTaskResponse();
      response.steps = [
        {
          run:
            `printf 'moved' > '${dir}/UPSTREAM.md' && ${SHELL_GIT} -C '${dir}' add UPSTREAM.md && ` +
            `${SHELL_GIT} -C '${dir}' commit --quiet -m 'upstream moves'`,
        },
        ...response.steps,
      ];
      return scriptWith({}, { 'add-sum': [response] });
    });
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 60_000);

    expect(job.status, rt.output()).toBe('completed');
    expect(stagesOf(job, 'integration_review')).toEqual(['succeeded']);
    const { integrationReviews } = await read(rt, job.id);
    expect(integrationReviews.map((r) => r.outcome)).toEqual(['approved']);
  });

  it('fails the path gate on a Rework outside the union of globs, and a scope_change_request becomes the existing Question', async () => {
    const outside = writes('src/outside.ts', 'export {};\n', 'Touch a file no Task may write');
    const asks = {
      steps: [],
      result: {
        status: 'needs_decision',
        summary: 'The fix needs src/shared.ts, which no Task may write.',
        commits: [],
        criteria: [],
        scopeChangeRequest: { paths: ['src/shared.ts'], reason: 'move formatDate there' },
      },
    };
    const { rt, repo } = await runtimeOn(
      () =>
        scriptWith(
          { planning: [{ output: { tasks: [fileTask('date-a'), fileTask('date-b')] } }] },
          {
            'date-a': [writes('src/date-a.ts', FORMAT_A)],
            'date-b': [writes('src/date-b.ts', FORMAT_B)],
            integration: [outside, asks],
          },
          {
            'date-a': [APPROVE],
            'date-b': [APPROVE],
            integration: [changesRequested('implementation', DUPLICATED)],
          },
        ),
      { maxAttempts: 3 },
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'integration_review')).toEqual(['waiting_human']);
    const { integration, integrationAttempts } = await read(rt, job.id);
    expect(integrationAttempts.map((a) => [a.n, a.cause, a.exitReason])).toEqual([
      [1, 'merge', 'changes_requested'],
      [2, 'rework', 'gates_failed'],
      [3, 'rework', 'needs_decision'],
    ]);
    const gated = integrationAttempts[1];
    expect(gated?.findings).toEqual([
      expect.objectContaining({
        source: 'gate',
        rule: 'scope.outside_writable',
        paths: ['src/outside.ts'],
      }),
    ]);
    const [task] = integration;
    expect(task?.state).toBe('blocked');
    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    const question = items.find((i) => i.taskId === task?.id && i.state === 'open');
    expect(question?.kind).toBe('question');
    expect(question?.questions).toEqual([
      expect.objectContaining({
        id: 'scope',
        source: 'scope_change_request',
        paths: ['src/shared.ts'],
      }),
    ]);
  });

  it('replans on a blocking plan Finding, cancelling the Integration Task with its Worktree preserved, and a new one rebuilds the branch', async () => {
    const planned = { output: { tasks: [fileTask('date-a'), fileTask('date-b')] } };
    const { rt, repo } = await runtimeOn(() =>
      scriptWith(
        { planning: [planned, planned] },
        {
          'date-a': [writes('src/date-a.ts', FORMAT_A)],
          'date-b': [writes('src/date-b.ts', FORMAT_B)],
        },
        {
          'date-a': [APPROVE],
          'date-b': [APPROVE],
          integration: [
            changesRequested('plan', 'the Plan splits one date helper across two Tasks'),
            APPROVE,
          ],
        },
      ),
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    expect(job.status, rt.output()).toBe('completed');
    expect(stagesOf(job, 'integration')).toEqual(['succeeded', 'succeeded']);
    expect(stagesOf(job, 'integration_review')).toEqual(['superseded', 'succeeded']);
    const { integration, worktrees, events } = await read(rt, job.id);
    expect(integration.map((t) => [t.state, t.cancelReason])).toEqual([
      ['cancelled', 'replan'],
      ['approved', null],
    ]);
    const [cancelled] = integration;
    expect(worktrees.find((w) => w.taskId === cancelled?.id)?.state).toBe('preserved');
    // The Finding is the Replan's feedback.
    const replanRun = events.find(
      (e) =>
        e.type === 'harness_run.started' &&
        e.payload['stageId'] === 'planning' &&
        e.payload['replan'] !== undefined,
    );
    const feedback = (replanRun?.payload['replan'] as { feedback: string } | undefined)?.feedback;
    expect(feedback).toContain('the Plan splits one date helper across two Tasks');
  });
});
