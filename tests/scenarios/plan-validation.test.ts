/**
 * The Plan validator's Phase B rules through the runtime (#36, ADR-0017): a
 * planner Plan with overlapping writable paths of parallel Tasks gets the one
 * re-prompt, naming the pair and the tracked paths at the planning base in
 * the Factory Clone; a Task's priority orders dispatch, and its
 * `maxAttempts` narrows the Effective Configuration.
 */
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, useFakeHarness } from '../support/factory.js';
import {
  createJob,
  jobSettled,
  json,
  registeredRepo,
  waitForJob,
  type EventBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface TaskBody {
  id: string;
  key: string;
  state: string;
  maxAttempts: number;
}

interface AttemptBody {
  taskId: string;
  n: number;
}

async function runtimeWith(script: string) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  return { rt, repo };
}

/** The valid Plan's only Task, as an object to change. */
function validTask(): Record<string, unknown> {
  const [task] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return structuredClone(task) as Record<string, unknown>;
}

describe('Plan validation in the planning Stage', () => {
  it('re-prompts a Plan whose parallel Tasks overlap, naming the pair and the tracked paths', async () => {
    const overlapping = {
      tasks: [
        validTask(),
        {
          ...validTask(),
          key: 'tidy-src',
          title: 'Tidy every source file',
          scope: { writable: ['src/**'], forbidden: [] },
          acceptance: [],
          verification: [{ key: 'ls', command: 'ls src' }],
        },
      ],
    };
    const { rt, repo } = await runtimeWith(
      scriptWith({
        planning: [{ output: overlapping }, { output: validOutput('planning') }],
      }),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled);

    expect(job.stageRuns.find((s) => s.stageId === 'planning')).toMatchObject({
      state: 'succeeded',
      failure: null,
    });
    expect(job.status).toBe('completed');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const planRuns = events.filter(
      (e) => e.type.startsWith('harness_run.') && e.payload['stageId'] === 'planning',
    );
    expect(planRuns.map((e) => [e.type, e.payload['n'], e.payload['outcome']])).toEqual([
      ['harness_run.started', 1, undefined],
      ['harness_run.finished', 1, 'invalid'],
      ['harness_run.started', 2, undefined],
      ['harness_run.finished', 2, 'valid'],
    ]);
    const reprompt = planRuns[2]?.payload['reprompt'] as {
      issues: { rule: string; message: string }[];
    };
    expect(reprompt.issues.map((i) => i.rule)).toEqual(['plan.no_overlapping_writes']);
    const [issue] = reprompt.issues;
    expect(issue?.message).toContain('Tasks add-sum and tidy-src');
    expect(issue?.message).toContain("'src/math.ts' and 'src/**'");
    // The path tracked at the planning base in the Factory Clone (tiny-ts has src/math.ts).
    expect(issue?.message).toContain('tracked files at the planning base both match: src/math.ts');

    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(
      tasks.map((t) => t.key),
      'only the valid Plan made Tasks',
    ).toEqual(['add-sum']);
  });

  it('dispatches a high-priority ready Task before an earlier-planned low one, with its narrowed maxAttempts', async () => {
    const docTask = (key: string, priority: string, extra: Record<string, unknown> = {}) => ({
      ...validTask(),
      key,
      title: `Write docs/${key}.md`,
      priority,
      scope: { writable: [`docs/${key}.md`], forbidden: [] },
      acceptance: ['AC-01'],
      verification: [{ key: 'test', command: `test -f docs/${key}.md`, criteria: ['AC-01'] }],
      ...extra,
    });
    const taskRun = (key: string) => [
      {
        steps: [{ write: { path: `docs/${key}.md`, content: `# ${key}\n` } }, { commit: key }],
        result: {
          status: 'done',
          summary: `Wrote docs/${key}.md.`,
          commits: [],
          criteria: [{ code: 'AC-01', claim: 'met', how: 'the file exists' }],
        },
      },
    ];
    const review = [
      {
        output: {
          outcome: 'approved',
          summary: 'The file is there.',
          findings: [],
          criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
        },
      },
    ];
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {
          planning: [
            {
              output: {
                tasks: [
                  docTask('low-first', 'low'),
                  docTask('high-later', 'high', { maxAttempts: 1 }),
                ],
              },
            },
          ],
        },
        { 'low-first': taskRun('low-first'), 'high-later': taskRun('high-later') },
        { 'low-first': review, 'high-later': review },
      ),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled, 20_000);

    expect(job.status).toBe('completed');
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.map((t) => [t.key, t.maxAttempts])).toEqual([
      ['low-first', 3],
      ['high-later', 1],
    ]);
    const keyOf = new Map(tasks.map((t) => [t.id, t.key]));
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempts.map((a) => keyOf.get(a.taskId))).toEqual(['high-later', 'low-first']);
  });
});
