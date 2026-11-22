/**
 * The pull request (#57, C1, ADR-0036). Once the Integration Review approves
 * the Integration Branch, the factory pushes it (its first push of anything)
 * and opens a PR from `factory/<job-id>/integration` to the default branch,
 * with a body rendered from persisted state and the Job's hidden marker. The
 * PR is recorded in `pull_requests` and shown by `job show`, the dashboard and
 * the Delivery Report v5. A Repository without GitHub coordinates skips
 * `pull_request` ("no GitHub remote") and is delivered locally. A crash after
 * GitHub created the PR, before the factory recorded it, adopts that PR on
 * recovery and never opens a second one.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub (that is C7, `[real]`).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubPort } from '@factory/github';
import { describe, expect, it } from 'vitest';
import { startDashboard } from '../support/dashboard.js';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  tempDir,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
  type TestHome,
} from '../support/factory.js';
import { fakeGitHub, type FakeGitHub } from '../support/github.js';
import { emptyDeliveryNote } from '@factory/domain';
import {
  createProject,
  declareCommands,
  json,
  post,
  skipPlanApproval,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { scriptWith, validOutput } from '../support/scripts.js';

const FULL_NAME = 'acme/tiny-ts';
const GH_ACCESS = 'fake-gh-access-0123456789';

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
  defaultBranch: string;
}
interface ReviewBody {
  taskId: string;
  outcome: string;
  headSha: string;
  baseSha: string;
  promptTemplate: { id: string };
}
interface TaskBody {
  id: string;
  kind: 'plan' | 'integration';
}
interface PullRequestBody {
  id: string;
  number: number;
  url: string;
  state: string;
  owner: string;
  name: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  pushedSha: string;
  adopted: boolean;
  changedFiles: number | null;
}
interface ReportBody {
  reportVersion: number;
  outcome: string;
  statement: string;
  notes: string[];
  knownLimitations: string[];
  integration: { headSha: string | null; fetchCommand: string | null } | null;
  pullRequests: {
    repository: string;
    number: number;
    url: string;
    headSha: string;
    mergeSha: string | null;
    ci: { status: string; reason: string } | null;
  }[];
}

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

function writes(path: string, before: string[] = []) {
  return {
    steps: [
      ...before.map((run) => ({ run })),
      { write: { path, content: 'export const x = 1;\n' } },
      { commit: `Write ${path}` },
    ],
    result: {
      status: 'done',
      summary: `Wrote ${path}.`,
      commits: [],
      criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
    },
  };
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [
      {
        severity: 'low',
        faultOrigin: 'implementation',
        location: 'src/a.ts:1',
        problem: 'The constant could use a clearer name.',
        why: 'x says nothing.',
        recommendation: 'Rename it.',
        blocking: false,
      },
    ],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
  },
};

/** A shell loop that waits until `file` exists (30 s at most). */
const waitFor = (file: string) =>
  `i=0; while [ ! -f '${file}' ]; do i=$((i+1)); if [ $i -gt 300 ]; then exit 1; fi; sleep 0.1; done`;

/** Two Plan Tasks, so the Integration Review runs on the Integration Branch. `gate`: b waits for it. */
function twoTaskScript(rollback?: string, gate?: string) {
  const plan: Record<string, unknown> = { tasks: [fileTask('a'), fileTask('b')] };
  if (rollback !== undefined) plan['rollback'] = rollback;
  return scriptWith(
    { planning: [{ output: plan }] },
    {
      a: [writes('src/a.ts')],
      b: [writes('src/b.ts', gate === undefined ? [] : [waitFor(gate)])],
    },
    { a: [APPROVE], b: [APPROVE], integration: [APPROVE] },
  );
}

/** One Plan Task whose developer changes nothing: the delivery is empty (C7 run 5). */
function emptyScript() {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'noop',
    title: 'Check src/math.ts already has it',
    scope: { writable: ['src/math.ts'], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'exists', args: ['src/math.ts'], criteria: ['AC-01'] }],
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    {
      noop: [
        {
          steps: [],
          result: {
            status: 'done',
            summary: 'Already there; nothing to change.',
            commits: [],
            criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
          },
        },
      ],
    },
    { noop: [APPROVE] },
  );
}

/** A home whose `tiny-ts` origin is the fake GitHub's `acme/tiny-ts`, its API pointed there. */
async function githubHome(
  script: string,
): Promise<{ home: TestHome; gh: FakeGitHub; src: string }> {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, script);
  patchFactoryConfig(home, { github: { token: 'env:GH_ACCESS', apiBaseUrl: gh.url } });
  return { home, gh, src };
}

const runtimeEnv = (gh: FakeGitHub, extra: Record<string, string> = {}) => ({
  ...gh.gitEnv(),
  GH_ACCESS,
  ...extra,
});

async function register(rt: RunningRuntime, src: string): Promise<RepoBody> {
  await createProject(rt, 'demo');
  const added = await rt.home.cli(['repo', 'add', src, '--project', 'demo', '--yes']);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await declareCommands(rt, repo.id);
  await skipPlanApproval(rt, repo.projectId);
  return repo;
}

async function createJob(rt: RunningRuntime, repositoryId: string): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Add a and b' });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const settled = (job: JobBody) => job.status !== 'active';
const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

async function reportOf(rt: RunningRuntime, jobId: string): Promise<ReportBody> {
  const artifacts = await json<{ id: string; kind: string }[]>(
    rt.request(`/v1/jobs/${jobId}/artifacts`),
  );
  const id = artifacts.find((a) => a.kind === 'report')?.id;
  if (id === undefined) throw new Error('no Delivery Report');
  return json<ReportBody>(rt.request(`/v1/artifacts/${id}/content`));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('the pull request', { timeout: 120_000 }, () => {
  it('C1: opens a PR from the Integration Branch to the default branch, its head the SHA the Integration Review approved', async () => {
    const { home, gh, src } = await githubHome(
      twoTaskScript('Revert the merge commit; nothing to migrate.'),
    );
    const rt = await startRuntime(home, { env: runtimeEnv(gh) });
    const repo = await register(rt, src);
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    // Open, it waits for a human merge on GitHub (merge_approval, ADR-0037).
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'integration_review')).toEqual(['succeeded']);
    expect(stagesOf(job, 'pull_request')).toEqual(['succeeded']);
    expect(stagesOf(job, 'merge_approval')).toEqual(['waiting_human']);

    // The head the Integration Review approved, on the integration (head, base).
    const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
    const integrationTask = tasks.find((t) => t.kind === 'integration');
    const reviews = await json<ReviewBody[]>(rt.request(`/v1/jobs/${job.id}/reviews`));
    const approval = reviews.find(
      (r) => r.taskId === integrationTask?.id && r.outcome === 'approved',
    );
    expect(approval?.promptTemplate.id).toBe('integration-review-packet@2');
    const branch = `factory/${job.id}/integration`;

    // On the fake GitHub: one PR, correct base, head and body; its head SHA is the approved one.
    const prs = gh.pullRequests(FULL_NAME);
    expect(prs).toHaveLength(1);
    const [pr] = prs;
    expect(pr).toMatchObject({ state: 'open', head: branch, base: repo.defaultBranch });
    expect(pr?.title).toBe('Add a and b');
    expect(gh.branchHead(FULL_NAME, branch)).toBe(approval?.headSha);
    expect(git(repo.clonePath, ['rev-parse', branch]).trim()).toBe(approval?.headSha);
    // The default branch on GitHub is untouched: only the Integration Branch was pushed.
    expect(gh.branchHead(FULL_NAME, repo.defaultBranch)).toBe(approval?.baseSha);
    const body = pr?.body ?? '';
    expect(body).toContain(`<!-- factory:${job.id}:pull_request -->`);
    expect(body).toContain('## Summary');
    expect(body).toContain('There is no way to sum two numbers.');
    expect(body).toMatch(/\*\*AC-01\*\* \(mandatory\): \*\*pass\*\*/);
    expect(body).toContain('## Commands run on the integration head');
    expect(body).toContain(String(approval?.headSha));
    expect(body).toContain("test -f 'src/a.ts'");
    expect(body).toContain('## Risks');
    expect(body).toContain('The constant could use a clearer name.');
    expect(body).toContain('## Rollback');
    expect(body).toContain('Revert the merge commit; nothing to migrate.');
    expect(body, 'the GitHub access value never reaches GitHub').not.toContain(GH_ACCESS);
    expect(body, 'a PR that changes files is not flagged').not.toContain('## No changes');

    // Recorded in pull_requests, with its event, through the API.
    const recorded = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`));
    expect(recorded).toEqual([
      expect.objectContaining({
        number: pr?.number,
        state: 'open',
        owner: 'acme',
        name: 'tiny-ts',
        headBranch: branch,
        baseBranch: repo.defaultBranch,
        headSha: approval?.headSha,
        pushedSha: approval?.headSha,
        adopted: false,
        changedFiles: 2,
      }),
    ]);
    const [row] = recorded as [PullRequestBody];
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const opened = events.findIndex((e) => e.type === 'pull_request.opened');
    expect(events[opened]?.payload).toMatchObject({
      number: row.number,
      headSha: approval?.headSha,
    });
    const approvedAt = events.findIndex(
      (e) =>
        e.type === 'review.recorded' &&
        e.payload['outcome'] === 'approved' &&
        e.payload['taskId'] === integrationTask?.id,
    );
    expect(opened).toBeGreaterThan(approvedAt);

    // Once a human merges it on GitHub, the Job completes; the Delivery Report v6 carries it.
    const mergeSha = gh.mergePullRequest(FULL_NAME, row.number);
    const completed = await waitForJob(rt, job.id, (j) => j.status === 'completed', 30_000);
    expect(stagesOf(completed, 'merge')).toEqual(['succeeded']);
    const report = await reportOf(rt, job.id);
    expect(report.reportVersion).toBe(7);
    expect(report.outcome).toBe('completed');
    expect(report.pullRequests).toEqual([
      {
        repository: FULL_NAME,
        number: row.number,
        url: row.url,
        state: 'merged',
        headBranch: branch,
        baseBranch: repo.defaultBranch,
        headSha: approval?.headSha,
        mergeSha,
        adopted: false,
        ci: report.pullRequests[0]?.ci ?? null,
        mergedBefore: [],
      },
    ]);
    expect(report.pullRequests[0]?.ci).not.toBeNull();
    expect(report.statement).toContain(row.url);
    expect(report.notes.join('\n')).not.toMatch(/not atomic/);
    expect(report.knownLimitations).not.toContain(
      'Delivery is a local branch in the Factory Clone; nothing was pushed.',
    );

    // job show and the dashboard show the link and state from the persisted row.
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('Pull requests (as recorded by the factory):');
    expect(shown.stdout).toMatch(
      new RegExp(
        `acme/tiny-ts#${String(row.number)}\\s+merged\\s+${row.url.replace(/[.?]/g, '\\$&')}`,
      ),
    );
    expect(shown.stdout).toMatch(/pull_request\s+succeeded/);
    const dash = await startDashboard(rt.home);
    const html = await dash.html(`/jobs/${job.id}`);
    expect(html).toContain(`href="${row.url}"`);
    expect(text(html)).toMatch(new RegExp(`acme/tiny-ts#${String(row.number)} merged`));
    expect(text(html)).toContain('As recorded by the factory; not read live from GitHub.');
    // Nothing went upstream to the operator's own checkout.
    expect(git(src, ['branch', '--list', 'factory/*']).trim()).toBe('');
  });

  it('flags an empty delivery, never refusing it: the PR body, the merge item, the record and job show say it changes no files', async () => {
    const { home, gh, src } = await githubHome(emptyScript());
    const rt = await startRuntime(home, { env: runtimeEnv(gh) });
    const repo = await register(rt, src);
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    // Delivered, not refused: the PR is open and waits for the merge as any other.
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'pull_request')).toEqual(['succeeded']);
    expect(stagesOf(job, 'merge_approval')).toEqual(['waiting_human']);

    const [row] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`));
    if (row === undefined) throw new Error('no pull request');
    expect(row.changedFiles).toBe(0);
    const note = emptyDeliveryNote(row.headSha, row.baseSha);

    // On GitHub: flagged at the top of the body, before the summary.
    const [pr] = gh.pullRequests(FULL_NAME);
    const body = pr?.body ?? '';
    expect(body).toContain(`## No changes\n\n**${note}**`);
    expect(body.indexOf('## No changes')).toBeLessThan(body.indexOf('## Summary'));

    // The merge item leads with it, where the human decides.
    const items = await json<{ jobId: string; kind: string; why: string }[]>(
      rt.request('/v1/inbox'),
    );
    const merge = items.find((i) => i.jobId === job.id && i.kind === 'merge');
    expect(merge?.why.startsWith(note), merge?.why).toBe(true);

    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain(`flagged: ${note}`);
  });

  it('skips pull_request with "no GitHub remote" for a Repository without coordinates, and delivers locally', async () => {
    const src = tinyTsRepo();
    const home = await initializedHome();
    useFakeHarness(home, twoTaskScript());
    const rt = await startRuntime(home);
    const repo = await register(rt, src);
    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, settled, 90_000);

    expect(job.status, rt.output()).toBe('completed');
    expect(stagesOf(job, 'integration_review')).toEqual(['succeeded']);
    expect(stagesOf(job, 'pull_request')).toEqual(['skipped']);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const skipped = events.find(
      (e) => e.type === 'stage_run.skipped' && e.payload['stageId'] === 'pull_request',
    );
    expect(skipped?.payload['reason']).toMatch(/^no GitHub remote/);
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`))).toEqual([]);

    // The Phase B local delivery: the Integration Branch to fetch, nothing pushed.
    const report = await reportOf(rt, job.id);
    expect(report.pullRequests).toEqual([]);
    expect(report.integration?.fetchCommand).toContain(`factory/${job.id}/integration`);
    expect(report.knownLimitations).toContain(
      'Delivery is a local branch in the Factory Clone; nothing was pushed.',
    );
    expect(report.notes.join('\n')).toMatch(/No pull request was opened: no GitHub remote/);
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toMatch(/pull_request\s+skipped/);
    expect(shown.stdout).not.toContain('Pull requests (as recorded by the factory):');
  });

  it('adopts the marked PR after a crash between creating it and recording it, never opening a second one', async () => {
    const { home, gh, src } = await githubHome(twoTaskScript());
    const rt = await startRuntime(home, {
      env: runtimeEnv(gh, { FACTORY_TEST_CRASH_AT: 'pull_request.after_create' }),
    });
    const repo = await register(rt, src);
    const created = await createJob(rt, repo.id);
    await rt.exited; // it killed itself once GitHub had created the PR
    expect(gh.pullRequests(FULL_NAME)).toHaveLength(1);
    const before = await startRuntime(home, { env: runtimeEnv(gh) });

    const job = await waitForJob(before, created.id, settled, 60_000);

    expect(job.status, before.output()).toBe('waiting_human');
    expect(stagesOf(job, 'pull_request')).toEqual(['succeeded']);
    expect(gh.pullRequests(FULL_NAME), 'never a second PR').toHaveLength(1);
    const creates = gh.requests.filter((r) => r.method === 'POST' && /\/pulls$/.test(r.path));
    expect(creates).toHaveLength(1);
    const [pr] = gh.pullRequests(FULL_NAME);
    const recorded = await json<PullRequestBody[]>(
      before.request(`/v1/jobs/${job.id}/pull-requests`),
    );
    expect(recorded).toEqual([expect.objectContaining({ number: pr?.number, adopted: true })]);
    const events = await json<EventBody[]>(before.request(`/v1/jobs/${job.id}/events?limit=1000`));
    expect(
      events.filter((e) => /^pull_request\.(opened|adopted)$/.test(e.type)).map((e) => e.type),
    ).toEqual(['pull_request.adopted']);
  });

  it('raises recovery_uncertain for a PR on the head branch without the marker: never adopted, never pushed to', async () => {
    const gates = tempDir('pr-gate-');
    const gate = join(gates, 'b');
    const { home, gh, src } = await githubHome(twoTaskScript(undefined, gate));
    const rt = await startRuntime(home, { env: runtimeEnv(gh) });
    const repo = await register(rt, src);
    const created = await createJob(rt, repo.id);
    // While b runs, someone opens a PR of their own from the factory's head branch.
    const branch = `factory/${created.id}/integration`;
    const foreignHead = gh.pushForeignCommit(FULL_NAME, branch, { 'NOTES.md': 'mine\n' });
    const port = new GitHubPort({
      apiBaseUrl: gh.url,
      token: () => Promise.resolve({ ok: true, token: GH_ACCESS }),
    });
    const foreign = await port.createPullRequest(
      { owner: 'acme', name: 'tiny-ts' },
      { title: 'Mine', body: 'Opened by hand.', head: branch, base: repo.defaultBranch },
    );
    expect(foreign.ok).toBe(true);
    writeFileSync(gate, '');

    const job = await waitForJob(rt, created.id, settled, 90_000);

    expect(job.status, rt.output()).toBe('waiting_human');
    const run = job.stageRuns.find((s) => s.stageId === 'pull_request') as
      | (JobBody['stageRuns'][number] & {
          blocker: { kind: string; reason: string; detail: string } | null;
        })
      | undefined;
    expect(run?.state).toBe('waiting_human');
    expect(run?.blocker).toMatchObject({ kind: 'human', reason: 'recovery_uncertain' });
    expect(run?.blocker?.detail).toMatch(/does not carry this Job's factory marker/);
    // Not adopted, not recorded, no second PR, and its branch was not pushed to.
    expect(gh.pullRequests(FULL_NAME).map((p) => p.title)).toEqual(['Mine']);
    expect(gh.branchHead(FULL_NAME, branch)).toBe(foreignHead);
    expect(await json<unknown[]>(rt.request(`/v1/jobs/${job.id}/pull-requests`))).toEqual([]);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    expect(events.filter((e) => e.type.startsWith('pull_request.')).map((e) => e.type)).toEqual([
      'pull_request.foreign_found',
    ]);
    expect(job.stageRuns.find((s) => s.stageId === 'closure')?.state).toBe('pending');
  });
});
