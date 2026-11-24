/**
 * A triage-chosen Repository set (#107, ADR-0052, ADR-0067, PRODUCT_SPEC
 * stories 52–54): `job create` naming no Repository of a Project with several
 * leaves the set to triage, which may choose only the Project's Repositories
 * (anything else is re-prompted). A set the operator named is never changed.
 * A triage-chosen set of more than one waits for a human at `plan_approval`
 * even under `planApproval: skip`; approving the Plan confirms it. Asserted
 * through the CLI and the API only.
 */
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createProject,
  declareCommands,
  json,
  jobSettled,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, SUM_SOURCE, validOutput } from '../support/scripts.js';

interface RepoBody {
  id: string;
  name: string;
  projectId: string;
}
interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  stageId: string | null;
  question: string;
  why: string;
  version: number;
}
type SetJob = JobBody & { repositorySetBy: 'operator' | 'triage' };

const triage = (repositories?: string[]) => ({
  output: { ...validOutput('triage'), ...(repositories === undefined ? {} : { repositories }) },
});

/** A Plan Task of `repository` writing `src/math.ts`, verified by the `has-sum` profile command. */
function planTask(key: string, repository: string) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `${key} in ${repository}`,
    repository,
    scope: { writable: ['src/math.ts'], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'has-sum', criteria: ['AC-01'] }],
  };
}

const DEVELOPER = [
  {
    steps: [{ write: { path: 'src/math.ts', content: SUM_SOURCE } }, { commit: 'Add sum()' }],
    result: {
      status: 'done',
      summary: 'Added sum() to src/math.ts.',
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the factory checks it' }],
    },
  },
];

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'The change is correct.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
  },
};

/** A Plan of one Task per named Repository, each run and approved. */
function scriptFor(triageRuns: unknown[], repositories: string[]): string {
  const keys = repositories.map((r) => `sum-${r}`);
  return scriptWith(
    {
      triage: triageRuns,
      planning: [{ output: { tasks: repositories.map((r, i) => planTask(keys[i] ?? r, r)) } }],
    },
    Object.fromEntries(keys.map((k) => [k, DEVELOPER])),
    {
      ...Object.fromEntries(keys.map((k) => [k, [APPROVE]])),
      integration: repositories.map(() => APPROVE),
    },
  );
}

/** A runtime with Project `demo` holding the `api` and `web` fixtures, plan approval skipped. */
async function twoRepoRuntime(
  script: string,
): Promise<{ rt: RunningRuntime; api: RepoBody; web: RepoBody }> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  await createProject(rt, 'demo');
  for (const name of ['api', 'web']) {
    const res = await rt.home.cli(['repo', 'add', tinyTsRepo(name), '--project', 'demo', '--yes']);
    if (res.code !== 0) throw new Error(`repo add ${name} failed: ${res.stderr}`);
  }
  const repos = await json<RepoBody[]>(rt.request('/v1/repositories'));
  const byName = (name: string) => {
    const repo = repos.find((r) => r.name === name);
    if (repo === undefined) throw new Error(`no Repository ${name}`);
    return repo;
  };
  const [api, web] = [byName('api'), byName('web')];
  for (const repo of [api, web]) await declareCommands(rt, repo.id);
  await skipPlanApproval(rt, api.projectId);
  return { rt, api, web };
}

async function createUnnamed(rt: RunningRuntime): Promise<string> {
  const created = await rt.home.cli(['job', 'create', '--title', 'Add sum()']);
  expect(created.code, created.stderr).toBe(0);
  expect(created.stdout).toContain("triage will choose its Repositories from the Project's");
  const jobId = /Created Job (job_\S+);/.exec(created.stdout)?.[1];
  if (jobId === undefined) throw new Error(`no Job id in: ${created.stdout}`);
  return jobId;
}

const triageRuns = (events: EventBody[]) =>
  events
    .filter((e) => e.type === 'harness_run.finished' && e.payload['stageId'] === 'triage')
    .map((e) => e.payload['outcome']);

describe('a triage-chosen Repository set (#107)', { timeout: 90_000 }, () => {
  it('waits for a human to confirm a set of two under planApproval: skip, then delivers both', async () => {
    const { rt, api, web } = await twoRepoRuntime(
      scriptFor([triage(['web', 'api'])], ['api', 'web']),
    );
    const jobId = await createUnnamed(rt);

    const waiting = (await waitForJob(rt, jobId, jobSettled, 60_000)) as SetJob;
    expect(waiting).toMatchObject({
      status: 'waiting_human',
      currentStage: 'plan_approval',
      repositorySetBy: 'triage',
    });
    expect(waiting.repositories.map((r) => r.name)).toEqual(['api', 'web']);
    expect(waiting.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe(
      'waiting_human',
    );
    // No Task runs before the set is confirmed.
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${jobId}/attempts`))).toEqual([]);

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
    const chosen = events.find((e) => e.type === 'job.repositories_chosen');
    expect(chosen?.payload).toMatchObject({
      repositoryIds: [api.id, web.id],
      names: ['api', 'web'],
    });

    const shown = await rt.home.cli(['job', 'show', jobId]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(
      `repositories: api (${api.id}), web (${web.id}), chosen by triage`,
    );
    const plan = await rt.home.cli(['plan', 'show', jobId]);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('Repositories: api, web (chosen by triage)');
    expect(plan.stdout).toContain('plan_approval (plan)');

    const items = await json<ItemBody[]>(rt.request('/v1/inbox'));
    expect(items).toHaveLength(1);
    const [item] = items as [ItemBody];
    expect(item).toMatchObject({ jobId, kind: 'plan', stageId: 'plan_approval' });
    expect(item.question).toBe('Approve this Plan and the Repositories triage chose (api, web)?');
    expect(item.why).toContain('even under planApproval: skip');

    const decided = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'approve',
      '--expect-version',
      String(item.version),
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    const done = await waitForJob(rt, jobId, jobSettled, 60_000);
    expect(done.status).toBe('completed');
  });

  it("re-prompts a set naming anything but the Project's Repositories, and skips plan approval for a set of one", async () => {
    const { rt, api } = await twoRepoRuntime(
      scriptFor([triage(['api', 'lib', 'api']), triage(['api'])], ['api']),
    );
    // `lib` is another Project's Repository: never a candidate.
    await createProject(rt, 'other');
    const added = await rt.home.cli([
      'repo',
      'add',
      tinyTsRepo('lib'),
      '--project',
      'other',
      '--yes',
    ]);
    expect(added.code, added.stderr).toBe(0);
    const res = await post(rt, '/v1/jobs', { project: 'demo', title: 'Add sum()' });
    expect(res.status).toBe(201);
    const jobId = ((await res.json()) as JobBody).id;

    const job = (await waitForJob(rt, jobId, jobSettled, 60_000)) as SetJob;
    expect(job.status).toBe('completed');
    expect(job.repositorySetBy).toBe('triage');
    expect(job.repositories.map((r) => r.id)).toEqual([api.id]);
    expect(job.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe('skipped');

    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
    expect(triageRuns(events)).toEqual(['invalid', 'valid']);
    const reprompts = events
      .filter((e) => e.type === 'harness_run.started' && e.payload['stageId'] === 'triage')
      .slice(1)
      .map((e) =>
        (e.payload['reprompt'] as { issues: { rule: string; message: string }[] }).issues.map(
          (i) => i.message,
        ),
      );
    expect(reprompts).toEqual([
      [
        'lib is not a Repository of the Project (its Repositories: api, web)',
        'api is listed more than once',
      ],
    ]);
    expect(
      events.filter((e) => e.type === 'job.repositories_chosen').map((e) => e.payload['names']),
    ).toEqual([['api']]);
  });

  it('never changes a set the operator named', async () => {
    const { rt, api } = await twoRepoRuntime(scriptFor([triage(['api', 'web'])], ['api']));

    const created = await rt.home.cli(['job', 'create', '--title', 'Add sum()', '--repo', 'api']);
    expect(created.code, created.stderr).toBe(0);
    const jobId = /Created Job (job_\S+) for api\n/.exec(created.stdout)?.[1];
    if (jobId === undefined) throw new Error(`no Job id in: ${created.stdout}`);

    const job = (await waitForJob(rt, jobId, jobSettled, 60_000)) as SetJob;
    expect(job.status).toBe('completed');
    expect(job.repositorySetBy).toBe('operator');
    expect(job.repositories.map((r) => r.id)).toEqual([api.id]);
    expect(job.stageRuns.find((s) => s.stageId === 'plan_approval')?.state).toBe('skipped');
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));
    expect(triageRuns(events)).toEqual(['valid']);
    expect(events.some((e) => e.type === 'job.repositories_chosen')).toBe(false);
  });
});
