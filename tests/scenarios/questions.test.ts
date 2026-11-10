/**
 * Questions during execution (#42, ROADMAP exit test B3; ARCHITECTURE §7
 * Question rules, §8; ADR-0023). A developer that returns `needs_decision`
 * pauses durably: one Inbox Question batches its questions, the Task is
 * `blocked` (`awaiting_human`) and no process stays alive. The operator
 * answers from the CLI or the dashboard, and a fresh Attempt (`cause:
 * answer`) on the same Task Branch carries the answers. Contradictory results
 * get the one re-prompt; an answer never widens the scope.
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
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { startDashboard } from '../support/dashboard.js';
import { factoryGroups } from '../support/processes.js';
import { scriptWith, SUM_SOURCE, validTaskResponse } from '../support/scripts.js';

interface QuestionBody {
  id: string;
  source: string;
  text: string;
  options: string[];
  recommended: string | null;
  blocking: boolean;
  agentProposed: boolean;
  paths: string[];
}

interface ItemBody {
  id: string;
  jobId: string;
  taskId: string | null;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  question: string;
  questions: QuestionBody[] | null;
  why: string;
  options: { id: string }[];
  evidence: string[];
  state: string;
  requestedBy: string;
  decidedBy: string | null;
  decision: {
    option: string;
    answers?: { questionId: string; option?: string; text?: string }[];
  } | null;
  version: number;
}

interface AnsweredBody {
  attemptN: number;
  questionId: string;
  source: string;
  question: string;
  blocking: boolean;
  answer: string | null;
  answeredWith: string | null;
}

interface AttemptBody {
  id: string;
  n: number;
  cause: string;
  state: string;
  exitReason: string | null;
  headSha: string | null;
  worktreeId: string;
  questions: QuestionBody[];
  packet: {
    scope: { writable: string[]; forbidden: string[] };
    context: { answers: AnsweredBody[] };
    protocol: { mayAskQuestions: boolean };
  };
}

interface TaskBody {
  id: string;
  key: string;
  state: string;
  maxQuestions: number;
  blocker: { kind: string; reason: string; attemptId: string } | null;
}

/** A GitHub token pattern, which the redactor replaces wherever it is stored (ADR-0011). */
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

/** The developer's first Run: partial work committed, then two questions (one optional). */
function asks(extra: Record<string, unknown> = {}, content = '// sum() goes here\n') {
  return {
    steps: [{ write: { path: 'src/math.ts', content } }, { commit: 'Start on sum()' }],
    result: {
      status: 'needs_decision',
      summary: 'sum() could round or not.',
      commits: [],
      criteria: [],
      questions: [
        {
          text: `Should sum() round its result? (seen with ${TOKEN})`,
          options: ['round', 'exact'],
          recommended: 'exact',
          blocking: true,
        },
        { text: 'Also add a JSDoc comment?', blocking: false },
      ],
      ...extra,
    },
  };
}

const settled = (job: JobBody) => job.status !== 'active';

/** A runtime on `tasks`' developer responses, with `tiny-ts` and a Project config. */
async function runtimeWith(tasks: unknown[], config: Record<string, unknown> = {}) {
  const home = await initializedHome();
  useFakeHarness(home, scriptWith({}, { 'add-sum': tasks }));
  const rt = await startRuntime(home);
  const res = await rt.home.cli(['repo', 'add', tinyTsRepo(), '--project', 'demo', '--yes']);
  if (res.code !== 0) throw new Error(`repo add failed: ${res.stderr}`);
  const [repo] = await json<[{ id: string; projectId: string; clonePath: string }]>(
    rt.request('/v1/repositories'),
  );
  await skipPlanApproval(rt, repo.projectId, config);
  return { rt, repo };
}

async function startJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Add sum() to math.ts' });
  expect(res.status).toBe(201);
  const created = (await res.json()) as JobBody;
  return waitForJob(rt, created.id, settled, 30_000);
}

const attempts = (rt: RunningRuntime, jobId: string) =>
  json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
const tasks = (rt: RunningRuntime, jobId: string) =>
  json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
const inbox = (rt: RunningRuntime) => json<ItemBody[]>(rt.request('/v1/inbox'));
const item = (rt: RunningRuntime, id: string) => json<ItemBody>(rt.request(`/v1/inbox/${id}`));

/** The one open Inbox Item, a Question. */
async function onlyQuestion(rt: RunningRuntime): Promise<ItemBody> {
  const items = await inbox(rt);
  expect(items.map((i) => i.kind)).toEqual(['question']);
  return items[0] as ItemBody;
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

describe('a developer that asks pauses durably, and an answer continues the Task', () => {
  it('B3: needs_decision opens one Question, nothing runs while it waits (across a restart), and the CLI answer starts a fresh Attempt carrying it', async () => {
    const { rt, repo } = await runtimeWith([asks(), validTaskResponse()]);

    const job = await startJob(rt, repo.id);

    // Waiting on a human: the Job, its execution Stage, and its Task with an awaiting_human Blocker.
    expect(job.status).toBe('waiting_human');
    expect(job.stageRuns.find((s) => s.stageId === 'execution')?.state).toBe('waiting_human');
    const [first] = await attempts(rt, job.id);
    expect(first).toMatchObject({
      n: 1,
      cause: 'initial',
      state: 'needs_decision',
      exitReason: 'needs_decision',
      packet: { protocol: { mayAskQuestions: true } },
    });
    const [task] = await tasks(rt, job.id);
    expect(task).toMatchObject({
      state: 'blocked',
      maxQuestions: 3,
      blocker: { kind: 'human', reason: 'awaiting_human', attemptId: first?.id },
    });

    // One Inbox Question batching both questions: the optional one marked so, both the
    // agent's, its text redacted before it was stored.
    const question = await onlyQuestion(rt);
    expect(question).toMatchObject({
      jobId: job.id,
      taskId: task?.id,
      stageId: 'execution',
      subjectRef: first?.id,
      state: 'open',
      options: [{ id: 'answer' }],
      requestedBy: `agent:fake/${String(first?.id)}`,
    });
    expect(question.questions).toEqual([
      expect.objectContaining({
        id: 'q1',
        blocking: true,
        options: ['round', 'exact'],
        recommended: 'exact',
        agentProposed: true,
      }),
      expect.objectContaining({ id: 'q2', blocking: false, agentProposed: true }),
    ]);
    expect(question.questions?.[0]?.text).toContain('[REDACTED:github_token]');
    expect(JSON.stringify(question)).not.toContain(TOKEN);
    expect(question.why).toMatch(/proposed by an agent/);
    expect(first?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);

    // No process is alive while it waits: nothing runs, and no guarded process group is left.
    expect((await json<{ attempts: unknown[] }>(rt.request('/v1/activity'))).attempts).toEqual([]);
    expect(factoryGroups(rt.home.dir)).toEqual([]);
    const [worktree] = await json<[{ id: string; state: string; branch: string }]>(
      rt.request(`/v1/jobs/${job.id}/worktrees`),
    );
    expect(worktree).toMatchObject({ id: first?.worktreeId, state: 'preserved' });

    // The pause is durable: a restarted runtime still holds the open Question.
    expect(await rt.stop()).toBe(0);
    const again = await startRuntime(rt.home);
    const after = await json<JobBody>(again.request(`/v1/jobs/${job.id}`));
    expect(after.status).toBe('waiting_human');
    const shown = await again.home.cli(['inbox', 'show', question.id]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`version:    ${String(question.version)}`);
    expect(shown.stdout).toContain('q1');
    expect(shown.stdout).toContain('options: round | exact [recommended]');

    // A stale version is refused, and changes nothing.
    const stale = await again.home.cli([
      'inbox',
      'answer',
      question.id,
      '--answer',
      'exact',
      '--expect-version',
      String(question.version + 1),
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('version_conflict');
    // A blocking question left unanswered is refused.
    const partial = await again.home.cli([
      'inbox',
      'answer',
      question.id,
      '--answer',
      'q2=yes please',
    ]);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain('answer_missing');

    const answered = await again.home.cli([
      'inbox',
      'answer',
      question.id,
      '--answer',
      'exact',
      '--answer',
      'Yes, one line',
      '--expect-version',
      String(question.version),
    ]);
    expect(answered.code, answered.stderr).toBe(0);
    expect(await item(again, question.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: {
        option: 'answer',
        answers: [
          { questionId: 'q1', option: 'exact' },
          { questionId: 'q2', text: 'Yes, one line' },
        ],
      },
    });

    const done = await waitForJob(again, job.id, settled, 30_000);
    expect(done.status).toBe('completed');
    const [, second] = await attempts(again, job.id);
    expect(second).toMatchObject({
      n: 2,
      cause: 'answer',
      state: 'passed',
      worktreeId: first?.worktreeId,
    });
    // The answers are in the fresh Attempt's packet context; its scope is unchanged.
    expect(second?.packet.context.answers).toEqual([
      expect.objectContaining({
        attemptN: 1,
        questionId: 'q1',
        blocking: true,
        answer: 'exact',
        answeredWith: 'option',
      }),
      expect.objectContaining({
        attemptN: 1,
        questionId: 'q2',
        blocking: false,
        answer: 'Yes, one line',
        answeredWith: 'text',
      }),
    ]);
    expect(second?.packet.scope).toEqual(first?.packet.scope);
    // Same Task Branch: the first Attempt's commit stays beneath the second's.
    expect(
      git(repo.clonePath, ['log', '--format=%s', String(second?.headSha)]).split('\n'),
    ).toEqual(expect.arrayContaining(['Start on sum()', 'Add sum() to math.ts']));
    expect(git(repo.clonePath, ['show', `${String(second?.headSha)}:src/math.ts`])).toBe(
      SUM_SOURCE,
    );
    expect(await inbox(again)).toEqual([]);
  });

  it('a scope change request becomes the same kind of Question, answered with guidance; the globs never change', async () => {
    const scopeAsk = {
      steps: [],
      result: {
        status: 'needs_decision',
        summary: 'I need package.json.',
        commits: [],
        criteria: [],
        scopeChangeRequest: { paths: ['package.json'], reason: 'add a test script' },
      },
    };
    const { rt, repo } = await runtimeWith([scopeAsk, validTaskResponse()]);

    const job = await startJob(rt, repo.id);
    expect(job.status).toBe('waiting_human');
    const question = await onlyQuestion(rt);
    expect(question.questions).toEqual([
      expect.objectContaining({
        id: 'scope',
        source: 'scope_change_request',
        blocking: true,
        paths: ['package.json'],
        agentProposed: true,
      }),
    ]);

    const res = await post(rt, `/v1/inbox/${question.id}/answer`, {
      expectedVersion: question.version,
      subjectRef: question.subjectRef,
      answers: [{ questionId: 'scope', text: 'Leave package.json alone; use the grep check.' }],
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const done = await waitForJob(rt, job.id, settled, 30_000);
    expect(done.status).toBe('completed');
    const [first, second] = await attempts(rt, job.id);
    expect(second?.cause).toBe('answer');
    expect(second?.packet.scope).toEqual(first?.packet.scope);
    expect(second?.packet.scope.writable).not.toContain('package.json');
    expect(second?.packet.context.answers).toEqual([
      expect.objectContaining({
        questionId: 'scope',
        source: 'scope_change_request',
        answer: 'Leave package.json alone; use the grep check.',
      }),
    ]);
  });

  it('a question item is answered, never decided, and a refused answer changes nothing', async () => {
    const { rt, repo } = await runtimeWith([asks()]);
    const job = await startJob(rt, repo.id);
    expect(job.status).toBe('waiting_human');
    const question = await onlyQuestion(rt);

    const decided = await post(rt, `/v1/inbox/${question.id}/decide`, {
      expectedVersion: question.version,
      subjectRef: question.subjectRef,
      option: 'answer',
    });
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ error: 'answer_required' });

    const answer = (body: Record<string, unknown>) =>
      post(rt, `/v1/inbox/${question.id}/answer`, {
        expectedVersion: question.version,
        subjectRef: question.subjectRef,
        ...body,
      });
    for (const [answers, error] of [
      [[{ questionId: 'q1', option: 'sideways' }], 'invalid_answer'],
      [[{ questionId: 'q9', text: 'x' }], 'unknown_question'],
      [[{ questionId: 'q2', text: 'x' }], 'answer_missing'],
    ] as const) {
      const res = await answer({ answers });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    }
    const wrongSubject = await answer({
      subjectRef: 'att_other',
      answers: [{ questionId: 'q1', option: 'exact' }],
    });
    expect(wrongSubject.status).toBe(409);
    expect(await wrongSubject.json()).toMatchObject({ error: 'subject_mismatch' });

    expect(await item(rt, question.id)).toMatchObject({ state: 'open', version: question.version });
    expect((await tasks(rt, job.id))[0]?.state).toBe('blocked');
  });

  it('answer Attempts are capped by maxQuestions: asking again past the cap is a question_cap_reached Blocker with no new Question', async () => {
    const { rt, repo } = await runtimeWith([asks(), asks({}, '// sum() still goes here\n')], {
      maxQuestions: 1,
    });
    const job = await startJob(rt, repo.id);
    const question = await onlyQuestion(rt);

    const res = await post(rt, `/v1/inbox/${question.id}/answer`, {
      expectedVersion: question.version,
      subjectRef: question.subjectRef,
      answers: [{ questionId: 'q1', option: 'round' }],
    });
    expect(res.status).toBe(200);

    // The answer queued execution again in its own transaction, so the Job is active until the cap.
    const stopped = await waitForJob(rt, job.id, settled, 30_000);
    expect(stopped.status).toBe('waiting_human');
    const all = await attempts(rt, job.id);
    expect(all.map((a) => [a.n, a.cause, a.state])).toEqual([
      [1, 'initial', 'needs_decision'],
      [2, 'answer', 'needs_decision'],
    ]);
    const [task] = await tasks(rt, job.id);
    expect(task).toMatchObject({
      state: 'blocked',
      maxQuestions: 1,
      blocker: { kind: 'human', reason: 'question_cap_reached', attemptId: all[1]?.id },
    });
    expect(await inbox(rt)).toEqual([]);
    // The second Attempt's questions are kept on it, for whoever looks next.
    expect(all[1]?.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});

describe('the question protocol is enforced with the one re-prompt', () => {
  it('needs_decision with no blocking question is re-prompted; a valid result then completes', async () => {
    const response = asks();
    response.result.questions = [{ text: 'Also add a JSDoc comment?', blocking: false }];
    const valid = validTaskResponse();
    const { rt, repo } = await runtimeWith([response, valid]);

    const job = await startJob(rt, repo.id);

    expect(job.status).toBe('completed');
    const [attempt] = await attempts(rt, job.id);
    expect(attempt).toMatchObject({ n: 1, cause: 'initial', state: 'passed' });
    const runs = await developerRuns(rt, job.id, String(attempt?.id));
    expect(runs).toHaveLength(2);
    expect(runs[1]?.payload['reprompt']).toMatchObject({
      issues: [{ rule: 'questions.blocking_required' }],
    });
    expect(await inbox(rt)).toEqual([]);
  });

  it('done with a blocking question is re-prompted; still contradictory, the Attempt fails invalid_output', async () => {
    const done = validTaskResponse();
    done.result['questions'] = [{ text: 'Is rounding fine?', blocking: true }];
    const { rt, repo } = await runtimeWith([done, { steps: [], result: done.result }]);

    const job = await startJob(rt, repo.id);

    expect(job.status).toBe('failed');
    const [attempt] = await attempts(rt, job.id);
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'invalid_output' });
    const runs = await developerRuns(rt, job.id, String(attempt?.id));
    expect(runs[1]?.payload['reprompt']).toMatchObject({
      issues: [{ rule: 'questions.done_with_blocking' }],
    });
    expect(await inbox(rt)).toEqual([]);
  });

  it('non-blocking questions under done open no item: they are recorded on the Attempt and listed open in the Delivery Report', async () => {
    const done = validTaskResponse();
    done.result['questions'] = [
      { text: 'Should negative numbers get a test too?', blocking: false },
    ];
    const { rt, repo } = await runtimeWith([done]);

    const job = await startJob(rt, repo.id);

    expect(job.status).toBe('completed');
    expect(await json<ItemBody[]>(rt.request('/v1/inbox?all=true'))).toEqual([]);
    const [attempt] = await attempts(rt, job.id);
    expect(attempt?.questions).toEqual([
      expect.objectContaining({ id: 'q1', blocking: false, agentProposed: true }),
    ]);
    const artifacts = await json<{ id: string; kind: string }[]>(
      rt.request(`/v1/jobs/${job.id}/artifacts`),
    );
    const report = await json<{
      tasks: { openQuestions: { id: string; text: string }[] }[];
      knownLimitations: string[];
    }>(
      rt.request(`/v1/artifacts/${String(artifacts.find((a) => a.kind === 'report')?.id)}/content`),
    );
    expect(report.tasks[0]?.openQuestions).toEqual([
      { id: 'q1', text: 'Should negative numbers get a test too?' },
    ]);
    expect(report.knownLimitations.join('\n')).toContain(
      'open question from the developer (agent-proposed, not answered): Should negative numbers get a test too?',
    );
  });
});

describe('the dashboard answer form', () => {
  it('shows the agent-proposed questions and answers them as user:local; the Task continues', async () => {
    const { rt, repo } = await runtimeWith([asks(), validTaskResponse()]);
    const job = await startJob(rt, repo.id);
    const question = await onlyQuestion(rt);
    const dash = await startDashboard(rt.home);

    const html = await dash.html(`/inbox/${question.id}`);
    expect(html).toContain('proposed by an agent');
    expect(html).toContain('Should sum() round its result?');
    expect(html).not.toContain(TOKEN);
    const form = /<form\b[^>]*action="\/api\/inbox\/[^"]+\/answer"[\s\S]*?<\/form>/.exec(html)?.[0];
    expect(form).toBeDefined();
    expect(form).toContain(`name="expectedVersion" value="${String(question.version)}"`);
    expect(form).toContain(`name="subjectRef" value="${question.subjectRef}"`);
    expect(form).toContain('name="choice.q1" value="round"');
    expect(form).toContain('name="choice.q1" value="exact"');
    expect(form).toContain('name="text.q2"');
    expect(html).not.toContain(rt.home.token());

    // A stale version is refused with the runtime's message.
    const stale = await dash.postForm(`/api/inbox/${question.id}/answer`, {
      expectedVersion: String(question.version + 1),
      subjectRef: question.subjectRef,
      'choice.q1': 'exact',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toContain(`version ${String(question.version)}`);
    // A foreign Origin is refused before anything reaches the runtime.
    const foreign = await dash.postForm(
      `/api/inbox/${question.id}/answer`,
      { expectedVersion: String(question.version), subjectRef: question.subjectRef },
      { origin: 'http://evil.example' },
    );
    expect(foreign.status).toBe(403);

    const res = await dash.postForm(`/api/inbox/${question.id}/answer`, {
      expectedVersion: String(question.version),
      subjectRef: question.subjectRef,
      'choice.q1': '__text',
      'text.q1': 'Exact, no rounding',
      'text.q2': '',
    });
    expect(res.status, res.body).toBe(303);
    expect(await item(rt, question.id)).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { answers: [{ questionId: 'q1', text: 'Exact, no rounding' }] },
    });
    const done = await waitForJob(rt, job.id, settled, 30_000);
    expect(done.status).toBe('completed');
    const page = await dash.html(`/inbox/${question.id}`);
    expect(page).toContain('Exact, no rounding');
    expect(page).not.toMatch(/<form\b/);
  });
});
