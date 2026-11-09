import { DEFAULT_TOOL_POLICIES } from '@factory/domain';
import { describe, expect, it } from 'vitest';
import { startRuntime } from '../support/factory.js';
import {
  createJob,
  json,
  post,
  registeredRepo,
  PHASE_A_FEATURE_STAGES,
  type JobBody,
} from '../support/api.js';

describe('factory job create / job show', () => {
  it('creates a Job for a Repository, then lists and shows it', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);

    const res = await rt.home.cli([
      'job',
      'create',
      '--repo',
      'tiny-ts',
      '--title',
      'Add sum() to math.ts',
      '--description',
      'Export sum(a, b) from src/math.ts.',
    ]);

    expect(res.code, res.stderr).toBe(0);
    const jobs = await json<JobBody[]>(rt.request('/v1/jobs'));
    expect(jobs).toHaveLength(1);
    const [listed] = jobs as [JobBody];
    expect(res.stdout).toContain(listed.id);

    const job = await json<JobBody>(rt.request(`/v1/jobs/${listed.id}`));
    expect(job).toMatchObject({
      id: listed.id,
      projectId: repo.projectId,
      repositoryId: repo.id,
      title: 'Add sum() to math.ts',
      description: 'Export sum(a, b) from src/math.ts.',
      type: 'feature',
      createdBy: 'user:local',
      status: 'active',
      currentStage: 'triage',
    });
    expect(job.stageRuns.map((s) => [s.stageId, s.state])).toEqual([
      ['intake', 'succeeded'],
      ['triage', 'queued'],
      ['discovery', 'pending'],
      ['specification', 'pending'],
      ['planning', 'pending'],
      ['execution', 'pending'],
      ['closure', 'pending'],
    ]);

    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain('Add sum() to math.ts');
    expect(show.stdout).toMatch(/status: +active/);
    expect(show.stdout).toMatch(/triage +queued/);
    expect(show.stdout).toMatch(/intake +succeeded/);

    const list = await rt.home.cli(['job', 'list']);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(
      new RegExp(`${job.id} +active +triage +Add sum\\(\\) to math\\.ts`),
    );

    const asJson = await rt.home.cli(['job', 'show', job.id, '--json']);
    expect(JSON.parse(asJson.stdout)).toEqual(job);
  });

  it('refuses a Job for an unknown Repository, and an unknown Job id', async () => {
    const rt = await startRuntime();

    const res = await post(rt, '/v1/jobs', { repositoryId: 'repo_missing', title: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'repository_not_found' });
    expect(await json<unknown[]>(rt.request('/v1/jobs'))).toEqual([]);

    expect((await rt.request('/v1/jobs/job_missing')).status).toBe(404);
    const show = await rt.home.cli(['job', 'show', 'job_missing']);
    expect(show.code).toBe(1);
    expect(show.stderr).toContain('job_missing');

    const cli = await rt.home.cli(['job', 'create', '--repo', 'nope', '--title', 'x']);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain("no Repository 'nope'");
  });

  it('freezes the Workflow Snapshot and Effective Configuration onto the Job at creation', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);

    const first = await createJob(rt, repo.id, 'before any config edit');
    expect(first.workflowSnapshot).toEqual({
      recipeId: 'feature',
      recipeVersion: 1,
      stages: PHASE_A_FEATURE_STAGES.map((id) => ({ id })),
    });
    expect(first.effectiveConfig).toEqual({
      maxAttempts: { value: 3, source: 'recipe' },
      maxRetries: { value: 2, source: 'recipe' },
      toolPolicies: { value: DEFAULT_TOOL_POLICIES, source: 'recipe' },
    });

    const edit = await post(rt, `/v1/projects/${repo.projectId}/config`, { maxAttempts: 5 });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ id: repo.projectId, config: { maxAttempts: 5 } });
    const second = await createJob(rt, repo.id, 'after the first edit');
    expect(second.effectiveConfig).toEqual({
      maxAttempts: { value: 5, source: 'project' },
      maxRetries: { value: 2, source: 'recipe' },
      toolPolicies: { value: DEFAULT_TOOL_POLICIES, source: 'recipe' },
    });

    expect(
      (
        await post(rt, `/v1/projects/${repo.projectId}/config`, {
          maxAttempts: 1,
          maxRetries: 0,
        })
      ).status,
    ).toBe(200);

    const [firstNow, secondNow] = await Promise.all(
      [first.id, second.id].map((id) => json<JobBody>(rt.request(`/v1/jobs/${id}`))),
    );
    expect(firstNow?.effectiveConfig, 'job created before any edit').toEqual(first.effectiveConfig);
    expect(secondNow?.effectiveConfig, 'job created before the second edit').toEqual(
      second.effectiveConfig,
    );
    expect(firstNow?.workflowSnapshot).toEqual(first.workflowSnapshot);
    const third = await createJob(rt, repo.id, 'after the second edit');
    expect(third.effectiveConfig).toEqual({
      maxAttempts: { value: 1, source: 'project' },
      maxRetries: { value: 0, source: 'project' },
      toolPolicies: { value: DEFAULT_TOOL_POLICIES, source: 'recipe' },
    });
  });

  it('rejects a Project config the factory does not know or allow', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    for (const body of [{ maxAttempts: 0 }, { maxAttempts: 2.5 }, { mergePolicy: 'auto' }]) {
      const res = await post(rt, `/v1/projects/${repo.projectId}/config`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(rt, '/v1/projects/prj_missing/config', { maxAttempts: 2 })).status).toBe(
      404,
    );
    const [project] = await json<{ config: unknown }[]>(rt.request('/v1/projects'));
    expect(project?.config).toEqual({});
  });
});
