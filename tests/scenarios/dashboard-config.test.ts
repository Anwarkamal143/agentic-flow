/**
 * The effective-config page (#98, D3 in full). The built dashboard, read over
 * HTTP: a Job page shows the Effective Configuration the Job froze at creation,
 * each value with its source and, for a permission value, its chain of
 * narrowings; a Project page and a Repository page show what a new Job would
 * get now. After a config edit the previews change and the running Job's page
 * does not.
 */
import { describe, expect, it } from 'vitest';
import { createJob, json, registeredRepo, type JobBody } from '../support/api.js';
import { startDashboard } from '../support/dashboard.js';
import { startRuntime, type RunningRuntime } from '../support/factory.js';

/** The text a browser shows: tags removed, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The shown text of the config row `key` (`<repository>/<key>` in a Repository section). */
function row(html: string, key: string): string {
  const match = new RegExp(`<tr[^>]*data-config-key="${key}"[^>]*>([\\s\\S]*?)</tr>`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no config row ${key} in:\n${text(html)}`);
  return text(match[1]);
}

async function cliOk(rt: RunningRuntime, args: string[]): Promise<void> {
  const res = await rt.home.cli(args);
  expect(res.code, `${args.join(' ')}: ${res.stderr}`).toBe(0);
}

describe('the effective-config page', () => {
  it('D3: after a config edit the previews change and the running Job’s page does not', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt, { planApproval: 'required' });
    await cliOk(rt, ['config', 'set', 'mergePolicy', 'human_approval']);
    const job = await createJob(rt, repo.id, 'frozen before the edit');
    const dash = await startDashboard(rt.home);

    // The Job page: each value, its source, and the chain of a permission value.
    const before = await dash.html(`/jobs/${job.id}`);
    expect(text(before)).toContain('Configuration (frozen at creation)');
    expect(row(before, 'maxAttempts')).toBe('maxAttempts 3 recipe');
    expect(row(before, 'planApproval')).toBe('planApproval required recipe');
    expect(row(before, 'concurrency.perJob')).toBe('concurrency.perJob 2 recipe');
    expect(row(before, 'tiny-ts/mergePolicy')).toBe(
      'mergePolicy never_auto repository factory: human_approval → repository: never_auto',
    );
    expect(row(before, 'tiny-ts/mergeMethod')).toBe('mergeMethod merge repository');

    // The previews show the same now.
    const projectPath = `/projects/${repo.projectId}`;
    const repoPath = `/repositories/${repo.id}`;
    for (const path of [projectPath, repoPath]) {
      const html = await dash.html(path);
      expect(text(html), path).toContain('what a new Job would get now');
      expect(row(html, 'maxAttempts'), path).toBe('maxAttempts 3 recipe');
      expect(row(html, 'tiny-ts/mergePolicy'), path).toBe(
        'mergePolicy never_auto repository factory: human_approval → repository: never_auto',
      );
    }

    // Edit the Factory Level and the Project.
    await cliOk(rt, ['config', 'set', 'concurrency.perJob', '1']);
    await cliOk(rt, ['project', 'config', 'set', 'demo', 'maxAttempts', '5']);

    for (const path of [projectPath, repoPath]) {
      const html = await dash.html(path);
      expect(row(html, 'maxAttempts'), path).toBe('maxAttempts 5 project');
      expect(row(html, 'concurrency.perJob'), path).toBe('concurrency.perJob 1 factory');
    }

    // The running Job's page is unchanged, value for value.
    const running = await json<JobBody>(rt.request(`/v1/jobs/${job.id}`));
    expect(['completed', 'failed', 'cancelled']).not.toContain(running.status);
    const after = await dash.html(`/jobs/${job.id}`);
    for (const key of [
      'maxAttempts',
      'planApproval',
      'concurrency.perJob',
      'tiny-ts/mergePolicy',
      'tiny-ts/mergeMethod',
    ]) {
      expect(row(after, key), key).toBe(row(before, key));
    }

    // A new Job gets the new values, and its page says where they come from.
    const next = await createJob(rt, repo.id, 'after the edit');
    const nextPage = await dash.html(`/jobs/${next.id}`);
    expect(row(nextPage, 'maxAttempts')).toBe('maxAttempts 5 project');
    expect(row(nextPage, 'concurrency.perJob')).toBe('concurrency.perJob 1 factory');
  });

  it('lists the Projects and their Repositories, 404s an unknown one, and offers no write action', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const dash = await startDashboard(rt.home);

    const list = await dash.html('/projects');
    expect(list).toContain(`href="/projects/${repo.projectId}"`);
    expect(list).toContain(`href="/repositories/${repo.id}"`);
    expect(text(list)).toContain('demo');
    expect(text(list)).toContain('tiny-ts');

    // The Project's own config is what `project config set` stored; skip is set by the helper.
    const project = await dash.html(`/projects/${repo.projectId}`);
    expect(row(project, 'planApproval')).toBe('planApproval skip project');

    for (const path of ['/projects', `/projects/${repo.projectId}`, `/repositories/${repo.id}`]) {
      const html = await dash.html(path);
      expect(html, path).not.toMatch(/<(form|button|input|textarea|select)\b/);
      expect(html, path).not.toContain(rt.home.token());
    }
    await dash.html('/projects/prj_does_not_exist', 404);
    await dash.html('/repositories/repo_does_not_exist', 404);
  });

  it('serves the preview from the runtime API', async () => {
    const rt = await startRuntime();
    const repo = await registeredRepo(rt);
    const res = await rt.request(`/v1/projects/${repo.projectId}/effective-config`);
    expect(res.status).toBe(200);
    const body = await json<{
      projectId: string;
      repositoryId: string | null;
      config: { maxAttempts: unknown; repositories: { repositoryId: string }[] };
    }>(res);
    expect(body.projectId).toBe(repo.projectId);
    expect(body.repositoryId).toBeNull();
    expect(body.config.maxAttempts).toEqual({ value: 3, source: 'recipe' });
    expect(body.config.repositories.map((r) => r.repositoryId)).toEqual([repo.id]);

    const one = await json<{ repositoryId: string; config: { repositories: unknown[] } }>(
      rt.request(`/v1/repositories/${repo.id}/effective-config`),
    );
    expect(one.repositoryId).toBe(repo.id);
    expect(one.config.repositories).toHaveLength(1);

    expect((await rt.request('/v1/repositories/repo_nope/effective-config')).status).toBe(404);
    expect((await rt.request('/v1/projects/nope/effective-config')).status).toBe(404);
    // Reading the preview writes nothing: it is not a Job.
    expect(await json<unknown[]>(rt.request('/v1/jobs'))).toEqual([]);
  });
});
