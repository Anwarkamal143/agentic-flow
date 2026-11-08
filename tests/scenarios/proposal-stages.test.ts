import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, useFakeHarness } from '../support/factory.js';
import {
  createJob,
  json,
  post,
  jobSettled,
  registeredRepo,
  waitForJob,
  type EventBody,
} from '../support/api.js';
import { scriptWith, validOutput, validTaskResponse, VALID_SCRIPT } from '../support/scripts.js';

interface ArtifactBody {
  id: string;
  jobId: string;
  kind: string;
  stageRunId: string | null;
  contentHash: string;
}

interface CriterionBody {
  code: string;
  text: string;
  mandatory: boolean;
  verification: string;
}

interface TaskBody {
  id: string;
  key: string;
  title: string;
  repositoryId: string;
  state: string;
  scope: { writable: string[]; forbidden: string[] };
  dependsOn: string[];
  acceptance: string[];
  verification: { key: string; command: string; required: boolean }[];
  maxAttempts: number;
}

async function proposalRuntime(script: string) {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  const repo = await registeredRepo(rt);
  return { rt, repo };
}

describe('proposal Stages, driven by the Fake Harness', () => {
  it('takes a Job through triage, discovery, specification and planning to one Task, which then runs', async () => {
    const { rt, repo } = await proposalRuntime(VALID_SCRIPT);
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled);

    expect(job.stageRuns.map((s) => [s.stageId, s.state])).toEqual([
      ['intake', 'succeeded'],
      ['triage', 'succeeded'],
      ['discovery', 'succeeded'],
      ['specification', 'succeeded'],
      ['planning', 'succeeded'],
      ['execution', 'succeeded'],
      ['closure', 'succeeded'],
    ]);
    expect(job).toMatchObject({ status: 'completed', currentStage: 'closure' });

    const criteria = await json<CriterionBody[]>(
      rt.request(`/v1/jobs/${job.id}/acceptance-criteria`),
    );
    expect(criteria).toMatchObject([
      { code: 'AC-01', text: 'sum(2, 3) returns 5.', mandatory: true },
      { code: 'AC-02', mandatory: false },
    ]);

    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      key: 'add-sum',
      title: 'Add sum() to math.ts',
      repositoryId: repo.id,
      state: 'approved',
      scope: { writable: ['src/math.ts', 'test/**'], forbidden: ['package.json', '.github/**'] },
      dependsOn: [],
      acceptance: ['AC-01'],
      verification: [
        { key: 'test', command: "grep -q 'export function sum' src/math.ts", criteria: ['AC-01'] },
        { key: 'typecheck', command: 'test -f src/math.ts && echo typecheck ok', criteria: [] },
      ],
      maxAttempts: 3,
    });

    const artifacts = (
      await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`))
    ).filter((a) => a.stageRunId !== null);
    expect(artifacts.map((a) => a.kind)).toEqual(['triage', 'discovery', 'spec', 'plan']);
    for (const artifact of artifacts) {
      const res = await rt.request(`/v1/artifacts/${artifact.id}/content`);
      expect(res.status, artifact.kind).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      expect(hash, `${artifact.kind} Artifact is addressed by its content`).toBe(
        artifact.contentHash,
      );
    }
    const spec = await json<{ acceptanceCriteria: CriterionBody[] }>(
      rt.request(`/v1/artifacts/${artifacts[2]?.id ?? ''}/content`),
    );
    expect(spec.acceptanceCriteria.map((c) => c.code)).toEqual(criteria.map((c) => c.code));

    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/AC-01 mandatory sum\(2, 3\) returns 5\./);
    expect(show.stdout).toMatch(/add-sum +approved +Add sum\(\) to math\.ts/);
    expect(show.stdout).toContain('forbidden: package.json, .github/**');

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const runs = events.filter((e) => e.type === 'harness_run.started');
    expect(runs.map((e) => [e.payload['stageId'], e.payload['harnessId']])).toEqual([
      ['triage', 'fake'],
      ['discovery', 'fake'],
      ['specification', 'fake'],
      ['planning', 'fake'],
      ['execution', 'fake'],
    ]);
  });

  it('re-prompts once with the validation error, and accepts a valid second answer', async () => {
    const { rt, repo } = await proposalRuntime(
      scriptWith({
        specification: [
          { raw: 'Sure! Here is the spec you asked for.' },
          { output: validOutput('specification') },
        ],
      }),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled);

    expect(job.stageRuns.find((s) => s.stageId === 'specification')).toMatchObject({
      state: 'succeeded',
      failure: null,
    });
    expect(job.currentStage).toBe('closure');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    const specRuns = events.filter(
      (e) => e.type.startsWith('harness_run.') && e.payload['stageId'] === 'specification',
    );
    expect(specRuns.map((e) => [e.type, e.payload['n'], e.payload['outcome']])).toEqual([
      ['harness_run.started', 1, undefined],
      ['harness_run.finished', 1, 'invalid'],
      ['harness_run.started', 2, undefined],
      ['harness_run.finished', 2, 'valid'],
    ]);
    expect(specRuns[0]?.payload['reprompt'], 'the first Run is no re-prompt').toBeUndefined();
    expect(specRuns[2]?.payload['reprompt'], 'the re-prompt carries the validation error').toEqual({
      issues: [{ rule: 'json', message: expect.stringContaining('not a JSON object') as string }],
    });
  });

  it('fails the Stage visibly when the re-prompted output is invalid too', async () => {
    const allOptional = validOutput('specification');
    allOptional['acceptanceCriteria'] = [
      { code: 'AC-01', text: 'sum exists.', mandatory: false, verification: 'review' },
    ];
    const { rt, repo } = await proposalRuntime(
      scriptWith({ specification: [{ output: allOptional }, { output: allOptional }] }),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled);

    expect(job.status).toBe('failed');
    expect(job.currentStage).toBe('specification');
    const spec = job.stageRuns.find((s) => s.stageId === 'specification');
    expect(spec).toMatchObject({
      state: 'failed',
      failure: {
        reason: 'invalid_output',
        issues: [{ rule: 'spec.mandatory_criterion' }],
      },
    });
    expect(spec?.failure?.message).toContain('spec.mandatory_criterion');
    expect(job.stageRuns.find((s) => s.stageId === 'planning')?.state).toBe('pending');

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(
      events.filter(
        (e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'specification',
      ),
      'exactly one re-prompt',
    ).toHaveLength(2);
    expect(events.find((e) => e.type === 'stage_run.failed')?.payload).toMatchObject({
      stageId: 'specification',
      failure: { reason: 'invalid_output' },
    });
    const artifacts = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    expect(
      artifacts.map((a) => a.kind),
      'no Artifact for an invalid proposal',
    ).toEqual(['triage', 'discovery']);
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/acceptance-criteria`))).toEqual([]);
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/tasks`))).toEqual([]);

    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toMatch(/specification +failed: invalid_output/);
  });

  /** A two-Task plan derived from the valid one; `change` breaks one rule. */
  function brokenPlan(change: (tasks: Record<string, unknown>[]) => void): unknown {
    const plan = validOutput('planning') as { tasks: Record<string, unknown>[] };
    const [first] = plan.tasks as [Record<string, unknown>];
    plan.tasks.push({
      ...structuredClone(first),
      key: 'docs',
      acceptance: [],
      dependsOn: ['add-sum'],
      verification: (first['verification'] as Record<string, unknown>[]).map((v) => ({
        ...v,
        criteria: [],
      })),
    });
    change(plan.tasks);
    return plan;
  }

  it.each([
    {
      rule: 'plan.no_cycles',
      plan: brokenPlan((tasks) => {
        (tasks[0] as { dependsOn: string[] }).dependsOn = ['docs'];
      }),
      message: /add-sum → docs → add-sum|docs → add-sum → docs/,
    },
    {
      rule: 'plan.task_repository',
      plan: brokenPlan((tasks) => {
        (tasks[1] as { repository: string }).repository = 'other-repo';
      }),
      message: /Task docs: repository 'other-repo' is not a Repository of this Job/,
    },
    {
      rule: 'plan.valid_globs',
      plan: brokenPlan((tasks) => {
        (tasks[0] as { scope: { writable: string[] } }).scope.writable = ['src/[math.ts'];
        (tasks[1] as { scope: { forbidden: string[] } }).scope.forbidden = ['../outside/**'];
      }),
      message:
        /writable glob 'src\/\[math\.ts' is not a valid glob.*forbidden glob '\.\.\/outside\/\*\*' has an empty, \. or \.\. path segment/,
    },
    {
      rule: 'plan.verification_criteria',
      plan: brokenPlan((tasks) => {
        (tasks[0] as { verification: { criteria: string[] }[] }).verification[1] = {
          ...(tasks[0] as { verification: { criteria: string[] }[] }).verification[1],
          criteria: ['AC-02'],
        };
      }),
      message: /Task add-sum: verification typecheck verifies AC-02, which the Task does not cover/,
    },
  ])('the Plan validator rejects a plan that breaks $rule, naming the rule', async (c) => {
    const { rt, repo } = await proposalRuntime(
      scriptWith({ planning: [{ output: c.plan }, { output: c.plan }] }),
    );
    const created = await createJob(rt, repo.id);

    const job = await waitForJob(rt, created.id, jobSettled);

    const planning = job.stageRuns.find((s) => s.stageId === 'planning');
    expect(planning?.state, c.rule).toBe('failed');
    expect(planning?.failure?.reason).toBe('invalid_output');
    expect(
      planning?.failure?.issues.map((i) => i.rule),
      'only the broken rule',
    ).toEqual(planning?.failure?.issues.map(() => c.rule));
    expect(planning?.failure?.message).toContain(c.rule);
    expect(planning?.failure?.message).toMatch(c.message);
    expect(job.status).toBe('failed');
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/tasks`)), 'no Task').toEqual([]);
  });

  it('keeps Artifacts immutable: no way to change them, and a restart never regenerates them', async () => {
    const { rt, repo } = await proposalRuntime(VALID_SCRIPT);
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, jobSettled);
    const artifacts = await json<ArtifactBody[]>(rt.request(`/v1/jobs/${job.id}/artifacts`));
    const contents = await Promise.all(
      artifacts.map(async (a) => (await rt.request(`/v1/artifacts/${a.id}/content`)).text()),
    );
    for (const a of artifacts) {
      for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
        for (const path of [`/v1/artifacts/${a.id}`, `/v1/artifacts/${a.id}/content`]) {
          const res = await rt.request(path, { method, body: '{}' });
          expect(res.status, `${method} ${path}`).toBe(404);
        }
      }
    }
    const eventsBefore = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));

    expect(await rt.stop()).toBe(0);
    const again = await startRuntime(rt.home);
    await new Promise((r) => setTimeout(r, 1_500)); // past a scheduler poll

    expect(await json<ArtifactBody[]>(again.request(`/v1/jobs/${job.id}/artifacts`))).toEqual(
      artifacts,
    );
    for (const [i, a] of artifacts.entries()) {
      expect(await (await again.request(`/v1/artifacts/${a.id}/content`)).text()).toBe(contents[i]);
    }
    const eventsAfter = await json<EventBody[]>(again.request(`/v1/jobs/${job.id}/events`));
    expect(eventsAfter, 'no Harness Run and no state change after the restart').toEqual(
      eventsBefore,
    );
  });

  it('cancels the ready Task with its Job', async () => {
    // The first Job's Task holds the single execution slot, so the second Job's Task stays ready.
    const busy = { ...validTaskResponse(), delayMs: 60_000 };
    const { rt, repo } = await proposalRuntime(scriptWith({}, { 'add-sum': [busy, busy] }));
    const first = await createJob(rt, repo.id);
    await waitForJob(rt, first.id, (j) =>
      j.stageRuns.some((s) => s.stageId === 'execution' && s.state === 'running'),
    );
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, (j) =>
      j.stageRuns.some((s) => s.stageId === 'planning' && s.state === 'succeeded'),
    );
    const [ready] = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(ready?.state, 'waiting for the busy slot').toBe('ready');

    const res = await post(rt, `/v1/jobs/${job.id}/cancel`, { expectedVersion: job.version });

    expect(res.status).toBe(200);
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    expect(tasks.map((t) => [t.key, t.state])).toEqual([['add-sum', 'cancelled']]);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events`));
    expect(events.find((e) => e.type === 'task.cancelled')?.payload).toMatchObject({
      key: 'add-sum',
      from: 'ready',
      to: 'cancelled',
    });
    await new Promise((r) => setTimeout(r, 1_200)); // past a scheduler poll
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/attempts`)), 'never run').toEqual(
      [],
    );
  });
});

describe('Harness selection by runtime configuration', () => {
  it('reports the configured Harness; with none configured, a Job waits at triage', async () => {
    const plain = await startRuntime();
    expect((await json<{ harness: unknown }>(plain.request('/v1/status'))).harness).toBeNull();
    const repo = await registeredRepo(plain);
    const job = await createJob(plain, repo.id);
    await new Promise((r) => setTimeout(r, 1_200));
    const now = await json<{ stageRuns: { stageId: string; state: string }[] }>(
      plain.request(`/v1/jobs/${job.id}`),
    );
    expect(now.stageRuns.find((s) => s.stageId === 'triage')?.state).toBe('queued');

    const { rt } = await proposalRuntime(VALID_SCRIPT);
    expect((await json<{ harness: unknown }>(rt.request('/v1/status'))).harness).toEqual({
      id: 'fake',
      version: '1',
      installed: true,
    });
    const status = await rt.home.cli(['status']);
    expect(status.stdout).toMatch(/harness: +fake 1/);
  });

  it('refuses to start with an invalid Fake Harness script, naming the problem', async () => {
    const home = await initializedHome();
    useFakeHarness(home, 'version: 1\nstages:\n  triage:\n    - outptu: {}\n  plannning: []\n');

    await expect(startRuntime(home)).rejects.toThrow(
      /harness 'fake': .*fake-harness\.yaml: .*stages\.triage\.0.*outptu.*plannning/s,
    );
  });
});
