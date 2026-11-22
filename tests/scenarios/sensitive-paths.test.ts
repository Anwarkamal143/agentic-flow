/**
 * Sensitive Paths are forbidden for every Task (#101, ADR-0051). The Job's
 * frozen per-Repository Sensitive Paths are merged into each Task's
 * `forbidden` list, so a developer's change to one fails the path-scope Gate
 * even inside a writable glob (forbidden beats writable), and a Plan whose
 * `writable` lists one literally gets the one re-prompt.
 */
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, useFakeHarness } from '../support/factory.js';
import {
  capAttempts,
  createJob,
  expectStoppedAtCap,
  jobSettled,
  json,
  onlyAttempt,
  registeredRepo,
  waitForJob,
  type EventBody,
} from '../support/api.js';
import { scriptWith, validOutput, validTaskResponse } from '../support/scripts.js';

interface AttemptBody {
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  findings: { source: string; rule: string | null; paths: string[] }[];
  packet: { scope: { writable: string[]; forbidden: string[] } };
}

/** The valid Plan with its one Task's scope replaced. */
function planWithScope(scope: { writable: string[]; forbidden: string[] }) {
  const plan = structuredClone(validOutput('planning')) as {
    tasks: Record<string, unknown>[];
  };
  (plan.tasks[0] as Record<string, unknown>)['scope'] = scope;
  return plan;
}

async function runtimeWith(script: string, opts: { maxAttempts?: number } = {}) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  if (opts.maxAttempts !== undefined) await capAttempts(rt, repo.projectId, opts.maxAttempts);
  return { rt, repo };
}

describe('Sensitive Paths', () => {
  it('fails the path gate on a developer change to a Sensitive Path inside a writable glob', async () => {
    const developer = validTaskResponse();
    developer.steps.push(
      { write: { path: 'src/.env.local', content: 'TOKEN=placeholder\n' } },
      { commit: 'Add a local env file' },
    );
    const { rt, repo } = await runtimeWith(
      scriptWith(
        {
          planning: [{ output: planWithScope({ writable: ['src/**', 'test/**'], forbidden: [] }) }],
        },
        { 'add-sum': [developer] },
      ),
      { maxAttempts: 1 },
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled, 20_000);

    await expectStoppedAtCap(rt, job);
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    // The Task runs with the Repository's default Sensitive Paths in its forbidden list.
    expect(attempt.packet.scope).toMatchObject({
      writable: ['src/**', 'test/**'],
      forbidden: ['.env*', '**/.env*', '.github/workflows/**', 'infra/**', '**/*.pem', '**/*.key'],
    });
    expect(attempt).toMatchObject({ state: 'failed', exitReason: 'gates_failed' });
    expect(attempt.findings.map((f) => [f.source, f.rule, f.paths])).toEqual([
      ['gate', 'scope.forbidden', ['src/.env.local']],
    ]);
    expect(attempt.exitDetail).toContain('src/.env.local (added, matches forbidden **/.env*)');
  });

  it('re-prompts a Plan whose writable lists a Sensitive Path, with a clear message', async () => {
    const { rt, repo } = await runtimeWith(
      scriptWith({
        planning: [
          {
            output: planWithScope({
              writable: ['src/math.ts', 'test/**', '.github/workflows/**'],
              forbidden: [],
            }),
          },
          { output: validOutput('planning') },
        ],
      }),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled, 20_000);

    expect(job.status).toBe('completed');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const planRuns = events.filter(
      (e) => e.type.startsWith('harness_run.') && e.payload['stageId'] === 'planning',
    );
    expect(planRuns.map((e) => [e.type, e.payload['outcome']])).toEqual([
      ['harness_run.started', undefined],
      ['harness_run.finished', 'invalid'],
      ['harness_run.started', undefined],
      ['harness_run.finished', 'valid'],
    ]);
    const reprompt = planRuns[2]?.payload['reprompt'] as {
      issues: { rule: string; message: string }[];
    };
    expect(reprompt.issues).toEqual([
      {
        rule: 'plan.sensitive_writable',
        message:
          "Task add-sum: writable '.github/workflows/**' is a Sensitive Path of Repository tiny-ts; Sensitive Paths are forbidden for every Task (a human removes one from the Repository Profile to allow it)",
      },
    ]);
  });
});
