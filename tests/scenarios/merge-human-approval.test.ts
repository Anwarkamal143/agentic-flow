/**
 * C3, the `human_approval` Merge Policy (#59, ADR-0038). The Repository is
 * registered with `--merge-policy human_approval`. The `merge` item offers
 * `merge` only while every other Merge Gate condition passes. Approving it is
 * audited, and the factory re-reads the PR and merges it with the
 * Repository's merge method (default `merge`, a merge commit). A method GitHub
 * refuses raises the `merge_method_refused` Blocker (retry the merge, cancel
 * the Job), and a PR that is already merged when re-read is recorded as
 * merged, never merged twice.
 *
 * Runs against the fake GitHub only (tests/support/github.ts): passing here is
 * not evidence against the real GitHub (that is C7, `[real]`).
 */
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
  type TestHome,
} from '../support/factory.js';
import { fakeGitHub, type FakeGitHub, type FakeRemote } from '../support/github.js';
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
const POLL_MS = 250;

interface RepoBody {
  id: string;
  projectId: string;
  mergePolicy: string;
  mergeMethod: string;
}
interface GateBody {
  verdict: string;
  conditions: { id: string; status: string; reason: string }[];
}
interface PullRequestBody {
  state: string;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  gate: GateBody | null;
}
interface ItemBody {
  id: string;
  kind: string;
  stageId: string | null;
  subjectRef: string;
  state: string;
  question: string;
  version: number;
  options: { id: string }[];
  decidedBy: string | null;
  decision: { option: string } | null;
}
interface AuditBody {
  actor: string;
  action: string;
  target: string;
  after: Record<string, unknown>;
  policyRef: string | null;
}

/** One Plan Task writing `src/a.ts`: the Integration Review is skipped by its rule. */
function oneTaskScript() {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'a',
    title: 'Write src/a.ts',
    scope: { writable: ['src/a.ts'], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: 'exists', args: ['src/a.ts'], criteria: ['AC-01'] }],
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    {
      a: [
        {
          steps: [
            { write: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
            { commit: 'Write src/a.ts' },
          ],
          result: {
            status: 'done',
            summary: 'Wrote src/a.ts.',
            commits: [],
            criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
          },
        },
      ],
    },
    {
      a: [
        {
          output: {
            outcome: 'approved',
            summary: 'Looks right.',
            findings: [],
            criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the command passed' }],
          },
        },
      ],
    },
  );
}

interface Setup {
  home: TestHome;
  gh: FakeGitHub;
  remote: FakeRemote;
  src: string;
}

async function githubHome(): Promise<Setup> {
  const gh = await fakeGitHub();
  const src = tinyTsRepo();
  const remote = gh.addRepository(FULL_NAME, src);
  git(src, ['remote', 'add', 'origin', remote.remoteUrl]);
  const home = await initializedHome();
  useFakeHarness(home, oneTaskScript());
  // A long grace window: the checks condition waits for the check the test reports.
  patchFactoryConfig(home, {
    github: {
      token: 'env:GH_ACCESS',
      apiBaseUrl: gh.url,
      pollIntervalMs: POLL_MS,
      checksGraceMs: 600_000,
    },
  });
  return { home, gh, remote, src };
}

async function startRepo(setup: Setup, repoArgs: string[]) {
  const rt = await startRuntime(setup.home, { env: { ...setup.gh.gitEnv(), GH_ACCESS } });
  await createProject(rt, 'demo');
  const added = await rt.home.cli([
    'repo',
    'add',
    setup.src,
    '--project',
    'demo',
    '--yes',
    ...repoArgs,
  ]);
  expect(added.code, added.stderr).toBe(0);
  const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
  if (repo === undefined) throw new Error('no Repository');
  await declareCommands(rt, repo.id);
  await skipPlanApproval(rt, repo.projectId);
  return { rt, repo, added };
}

async function runJob(rt: RunningRuntime, repo: RepoBody, extra: Record<string, unknown> = {}) {
  const res = await post(rt, '/v1/jobs', { repositoryId: repo.id, title: 'Add a', ...extra });
  expect(res.status, 'create Job').toBe(201);
  const created = (await res.json()) as JobBody;
  return waitForJob(rt, created.id, (j) => j.status !== 'active', 90_000);
}

const stagesOf = (job: JobBody, stageId: string) =>
  job.stageRuns.filter((s) => s.stageId === stageId).map((s) => s.state);

async function pullRequest(rt: RunningRuntime, jobId: string): Promise<PullRequestBody> {
  const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
  if (pr === undefined) throw new Error('no pull request recorded');
  return pr;
}

/** Polls `read` until `done` holds (20 s at most). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function openItem(rt: RunningRuntime, kind: string): Promise<ItemBody> {
  const items = (await json<ItemBody[]>(rt.request('/v1/inbox'))).filter((i) => i.kind === kind);
  expect(items, `one open ${kind} item`).toHaveLength(1);
  return items[0] as ItemBody;
}

const optionIds = (item: ItemBody) => item.options.map((o) => o.id);

async function decide(rt: RunningRuntime, item: ItemBody, option: string) {
  return post(rt, `/v1/inbox/${item.id}/decide`, {
    expectedVersion: item.version,
    subjectRef: item.subjectRef,
    option,
  });
}

/** Reports a check run on the PR head and waits for the `merge` item to offer `merge`. */
async function greenAndOffered(rt: RunningRuntime, gh: FakeGitHub, head: string) {
  gh.setCheckRun(FULL_NAME, head, { name: 'build', status: 'completed', conclusion: 'success' });
  return until(
    () => openItem(rt, 'merge'),
    (i) => optionIds(i).includes('merge'),
    'the merge item to offer merge',
  );
}

const mergeRequests = (gh: FakeGitHub) =>
  gh.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/merge'));

const terminal = (j: JobBody) => ['completed', 'failed', 'cancelled'].includes(j.status);

describe('the human_approval Merge Policy (C3)', { timeout: 150_000 }, () => {
  it('blocks the merge until the merge item is approved, audits the approval, then merges with a merge commit', async () => {
    const setup = await githubHome();
    const { gh, remote } = setup;
    const { rt, repo, added } = await startRepo(setup, ['--merge-policy', 'human_approval']);
    expect(added.stdout).toMatch(/Merge Policy: human_approval/);
    expect(repo).toMatchObject({ mergePolicy: 'human_approval', mergeMethod: 'merge' });

    const job = await runJob(rt, repo);
    expect(job.status, rt.output()).toBe('waiting_human');
    expect(stagesOf(job, 'merge_approval')).toEqual(['waiting_human']);
    const head = gh.branchHead(FULL_NAME, `factory/${job.id}/integration`);
    if (head === undefined) throw new Error('the Integration Branch was not pushed');

    // The checks condition is pending (no check yet): merge is not offered, and deciding it is refused.
    const first = await until(
      () => pullRequest(rt, job.id),
      (pr) => pr.gate !== null,
      'the first gate',
    );
    expect(first.gate?.conditions.find((c) => c.id === 'checks')?.status).toBe('pending');
    const waiting = await openItem(rt, 'merge');
    expect(optionIds(waiting)).toEqual(['request_changes', 'cancel_job']);
    expect((await decide(rt, waiting, 'merge')).status).toBe(400);

    // A failing check: still no merge option.
    gh.setCheckRun(FULL_NAME, head, { name: 'build', status: 'completed', conclusion: 'failure' });
    await until(
      () => pullRequest(rt, job.id),
      (pr) => pr.gate?.conditions.find((c) => c.id === 'checks')?.status === 'fail',
      'the checks condition to fail',
    );
    expect(optionIds(await openItem(rt, 'merge'))).toEqual(['request_changes', 'cancel_job']);

    // Green: merge is offered beside cancel_job; the policy still waits and nothing is merged.
    const offered = await greenAndOffered(rt, gh, head);
    expect(optionIds(offered)).toEqual(['merge', 'request_changes', 'cancel_job']);
    const green = await pullRequest(rt, job.id);
    const policy = green.gate?.conditions.find((c) => c.id === 'policy');
    expect(policy?.status).toBe('pending');
    expect(policy?.reason).toMatch(/^human_approval/);
    expect(gh.pullRequests(FULL_NAME)[0]?.merged).toBe(false);
    expect(mergeRequests(gh)).toHaveLength(0);

    // Approved through the CLI: audited, then merged by the factory with a merge commit.
    const decided = await rt.home.cli([
      'inbox',
      'decide',
      offered.id,
      'merge',
      '--expect-version',
      String(offered.version),
    ]);
    expect(decided.code, decided.stderr).toBe(0);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect(stagesOf(done, 'merge_approval')).toEqual(['succeeded']);
    expect(stagesOf(done, 'merge')).toEqual(['succeeded']);
    expect(stagesOf(done, 'closure')).toEqual(['succeeded']);

    const item = await json<ItemBody>(rt.request(`/v1/inbox/${offered.id}`));
    expect(item).toMatchObject({ state: 'decided', decidedBy: 'user:local' });
    expect(item.decision?.option).toBe('merge');

    const audit = await json<AuditBody[]>(rt.request(`/v1/jobs/${job.id}/audit`));
    const approval = audit.find((a) => a.action === 'merge.approved');
    expect(approval).toMatchObject({
      actor: 'user:local',
      policyRef: `inbox:${offered.id}/merge`,
    });
    expect(approval?.after).toMatchObject({
      headSha: head,
      baseSha: green.baseSha,
      method: 'merge',
    });

    const [ghPr] = gh.pullRequests(FULL_NAME);
    expect(ghPr?.merged).toBe(true);
    const puts = mergeRequests(gh);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toMatchObject({ merge_method: 'merge', sha: head });
    const merged = await pullRequest(rt, job.id);
    expect(merged.state).toBe('merged');
    if (merged.mergeSha === null) throw new Error('no merge SHA recorded');
    // A merge commit: two parents, the base and the reviewed head.
    const parents = git(remote.bareDir, ['rev-list', '--parents', '-n', '1', merged.mergeSha])
      .trim()
      .split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(head);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const mergeStage = events.find(
      (e) => e.type === 'stage_run.succeeded' && e.payload['stageId'] === 'merge',
    );
    expect(mergeStage?.payload['mergeSha']).toBe(merged.mergeSha);
  });

  it('raises merge_method_refused when GitHub refuses the method, and retrying the merge succeeds once it is allowed', async () => {
    const setup = await githubHome();
    const { gh } = setup;
    gh.refuseMergeMethod(FULL_NAME, 'squash');
    const { rt, repo } = await startRepo(setup, [
      '--merge-policy',
      'human_approval',
      '--merge-method',
      'squash',
    ]);
    expect(repo.mergeMethod).toBe('squash');
    const job = await runJob(rt, repo);
    expect(job.status, rt.output()).toBe('waiting_human');
    const head = gh.branchHead(FULL_NAME, `factory/${job.id}/integration`) ?? '';
    const offered = await greenAndOffered(rt, gh, head);
    expect((await decide(rt, offered, 'merge')).status).toBe(200);

    // Not a failure: the merge Stage waits on a human with the Blocker and its options.
    const blocked = await waitForJob(
      rt,
      job.id,
      (j) => stagesOf(j, 'merge')[0] === 'waiting_human',
    );
    expect(blocked.status).toBe('waiting_human');
    expect(stagesOf(blocked, 'merge_approval')).toEqual(['succeeded']);
    const mergeRun = blocked.stageRuns.find((r) => r.stageId === 'merge');
    expect(mergeRun?.blocker?.reason).toBe('merge_method_refused');
    const item = await openItem(rt, 'blocker');
    expect(item.stageId).toBe('merge');
    expect(optionIds(item)).toEqual(['retry_merge', 'cancel_job']);
    expect(item.question).toMatch(/merge method/);
    expect(gh.pullRequests(FULL_NAME)[0]?.merged).toBe(false);

    gh.allowMergeMethod(FULL_NAME, 'squash');
    expect((await decide(rt, item, 'retry_merge')).status).toBe(200);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect(stagesOf(done, 'merge')).toEqual(['succeeded']);
    expect(gh.pullRequests(FULL_NAME)[0]?.merged).toBe(true);
    const puts = mergeRequests(gh);
    expect(puts.map((r) => r.status)).toEqual([405, 200]);
    expect(puts.every((r) => (r.body as { merge_method?: string }).merge_method === 'squash')).toBe(
      true,
    );
    expect((await pullRequest(rt, job.id)).state).toBe('merged');
  });

  it('records a PR already merged when re-read before merging as merged, and never merges it twice', async () => {
    const setup = await githubHome();
    const { gh } = setup;
    gh.refuseMergeMethod(FULL_NAME, 'merge');
    const { rt, repo } = await startRepo(setup, ['--merge-policy', 'human_approval']);
    const job = await runJob(rt, repo);
    expect(job.status, rt.output()).toBe('waiting_human');
    const head = gh.branchHead(FULL_NAME, `factory/${job.id}/integration`) ?? '';
    const offered = await greenAndOffered(rt, gh, head);
    expect((await decide(rt, offered, 'merge')).status).toBe(200);
    await waitForJob(rt, job.id, (j) => stagesOf(j, 'merge')[0] === 'waiting_human');
    const item = await openItem(rt, 'blocker');

    // Meanwhile a human merges it on GitHub; the retry re-reads the PR first.
    const [ghPr] = gh.pullRequests(FULL_NAME);
    const mergeSha = gh.mergePullRequest(FULL_NAME, ghPr?.number ?? 0, 'squash');
    expect((await decide(rt, item, 'retry_merge')).status).toBe(200);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('completed');
    expect(await pullRequest(rt, job.id)).toMatchObject({ state: 'merged', mergeSha });
    expect(
      mergeRequests(gh).map((r) => r.status),
      'only the refused attempt',
    ).toEqual([405]);
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const merged = events.filter((e) => e.type === 'pull_request.merged');
    expect(merged.map((e) => e.payload['how'])).toEqual(['already_merged']);
    const stage = events.find(
      (e) => e.type === 'stage_run.succeeded' && e.payload['stageId'] === 'merge',
    );
    expect(stage?.payload['mergeSha']).toBe(mergeSha);
  });

  it('fails the merge, merging nothing, when the head moved after the approval', async () => {
    const setup = await githubHome();
    const { gh } = setup;
    gh.refuseMergeMethod(FULL_NAME, 'merge');
    const { rt, repo } = await startRepo(setup, ['--merge-policy', 'human_approval']);
    const job = await runJob(rt, repo);
    expect(job.status, rt.output()).toBe('waiting_human');
    const branch = `factory/${job.id}/integration`;
    const head = gh.branchHead(FULL_NAME, branch) ?? '';
    const offered = await greenAndOffered(rt, gh, head);
    expect((await decide(rt, offered, 'merge')).status).toBe(200);
    await waitForJob(rt, job.id, (j) => stagesOf(j, 'merge')[0] === 'waiting_human');
    const item = await openItem(rt, 'blocker');

    // Someone pushes to the PR branch: the approval was for the old head.
    gh.pushForeignCommit(FULL_NAME, branch, { 'src/b.ts': 'export const b = 2;\n' });
    gh.allowMergeMethod(FULL_NAME, 'merge');
    expect((await decide(rt, item, 'retry_merge')).status).toBe(200);
    const done = await waitForJob(rt, job.id, terminal, 30_000);
    expect(done.status, rt.output()).toBe('failed');
    const merge = done.stageRuns.find((r) => r.stageId === 'merge');
    expect(merge?.state).toBe('failed');
    expect(merge?.failure?.message).toMatch(/moved after the merge was approved/);
    expect(gh.pullRequests(FULL_NAME)[0]?.merged).toBe(false);
    expect(mergeRequests(gh).map((r) => r.status)).toEqual([405]);
  });

  it('refuses a Job override that loosens the Merge Policy and applies a stricter one; the schema refuses auto_if_low_risk_and_green', async () => {
    const setup = await githubHome();
    const { rt, repo } = await startRepo(setup, []);
    expect(repo.mergePolicy).toBe('never_auto');

    const looser = await post(rt, '/v1/jobs', {
      repositoryId: repo.id,
      title: 'Add a',
      mergePolicy: 'human_approval',
    });
    expect(looser.status).toBe(409);
    expect(((await looser.json()) as { error: string }).error).toBe('merge_policy_looser');
    const auto = await post(rt, '/v1/jobs', {
      repositoryId: repo.id,
      title: 'Add a',
      mergePolicy: 'auto_if_low_risk_and_green',
    });
    expect(auto.status).toBe(400);
    const cli = await rt.home.cli([
      'repo',
      'add',
      setup.src,
      '--merge-policy',
      'auto_if_low_risk_and_green',
    ]);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toMatch(/Phase E/);
    expect(await json<RepoBody[]>(rt.request('/v1/repositories'))).toHaveLength(1);
  });

  it('a stricter Job override (never_auto on a human_approval Repository) never offers merge', async () => {
    const setup = await githubHome();
    const { gh } = setup;
    const { rt, repo } = await startRepo(setup, ['--merge-policy', 'human_approval']);
    const job = await runJob(rt, repo, { mergePolicy: 'never_auto' });
    expect(job.status, rt.output()).toBe('waiting_human');
    const shown = await json<{ effectiveConfig: { repositories: { mergePolicy: unknown }[] } }>(
      rt.request(`/v1/jobs/${job.id}`),
    );
    expect(shown.effectiveConfig.repositories[0]?.mergePolicy).toEqual({
      value: 'never_auto',
      source: 'job',
      chain: [
        { source: 'repository', value: 'human_approval' },
        { source: 'job', value: 'never_auto' },
      ],
    });
    const head = gh.branchHead(FULL_NAME, `factory/${job.id}/integration`) ?? '';
    gh.setCheckRun(FULL_NAME, head, { name: 'build', status: 'completed', conclusion: 'success' });
    const green = await until(
      () => pullRequest(rt, job.id),
      (pr) => pr.gate?.conditions.find((c) => c.id === 'checks')?.status === 'pass',
      'the checks to pass',
    );
    expect(green.gate?.conditions.find((c) => c.id === 'policy')?.reason).toMatch(/^never_auto/);
    expect(optionIds(await openItem(rt, 'merge'))).toEqual(['request_changes', 'cancel_job']);
  });
});
