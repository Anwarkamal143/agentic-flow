/**
 * C7 `[real]` (ROADMAP Phase C, #67): a Job end to end on the real GitHub,
 * with the real Claude Code, against the sandbox `Anwarkamal143/factory-sandbox`
 * (PROGRESS.md, human answer 4). Not part of `pnpm test` or CI:
 *
 *   pnpm test:real tests/real/c7-github.test.ts
 *
 * Preconditions (each failure names itself; none is a C7 result):
 * - `claude` logged in (as A7);
 * - `gh` logged in as the sandbox's owner, with the `repo` and `workflow`
 *   scopes. The runtime's token reference is `gh`, and its pushes use
 *   `gh auth git-credential` (set for the runtime only, through
 *   `GIT_CONFIG_COUNT`), so both are the same login.
 *
 * The setup (`tests/support/sandbox.ts`) seeds an empty sandbox once and, at
 * the start of each run, closes the PRs the factory opened and deletes the
 * `factory/*` branches. It touches no other repository. The run's own PR is
 * left for the human to look at; the next run cleans it up.
 *
 * The Repository is registered with `--merge-policy human_approval`, the
 * sandbox workflow's check required, and a `--setup` that installs the
 * dependencies in each Worktree (ADR-0047). The test waits for the PR, checks its
 * head is the reviewed SHA, waits for CI to pass and the `merge` item to offer
 * `merge`, and then waits for **the human** to decide it (the command is
 * printed and written to `tests/real/results/c7-waiting.txt`). Nothing merges
 * before that, and the test never decides it itself.
 *
 * Each run writes its outcome to `tests/real/results/` (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tempDir,
  type RunningRuntime,
} from '../support/factory.js';
import { json, post, skipPlanApproval, type JobBody } from '../support/api.js';
import { useClaudeCode } from '../support/claude.js';
import { killGroupsOnFinish } from '../support/processes.js';
import { repoRoot } from '../support/paths.js';
import {
  GH_CREDENTIALS,
  GITHUB_API,
  ghToken,
  requireSandboxLogin,
  sandboxGet,
} from '../support/real-github.js';
import { gitWith, prepareSandbox, SANDBOX, SANDBOX_CHECK } from '../support/sandbox.js';

const [OWNER = '', NAME = ''] = SANDBOX.split('/');
const MINUTE = 60_000;
const RESULTS = join(repoRoot, 'tests/real/results');
/**
 * The Worktree setup (ADR-0047): `tiny-ts` has no lockfile, so `npm ci` would
 * refuse; `--no-package-lock` writes none, so git status stays clean.
 */
const SANDBOX_SETUP = 'npm install --no-package-lock --ignore-scripts --no-audit --no-fund';

interface RepoBody {
  id: string;
  projectId: string;
  clonePath: string;
  github: { owner: string; name: string } | null;
  mergePolicy: string;
}
interface TaskBody {
  id: string;
  key: string;
  kind: 'plan' | 'integration';
  state: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}
interface AttemptBody {
  taskId: string;
  n: number;
  cause: string;
  state: string;
  headSha: string | null;
  exitReason: string | null;
  exitDetail: string | null;
}
interface ReviewBody {
  taskId: string;
  outcome: string;
  headSha: string;
  baseSha: string;
}
interface PullRequestBody {
  number: number;
  url: string;
  state: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  pushedSha: string;
  mergeSha: string | null;
  gate: { verdict: string; conditions: { id: string; status: string; reason: string }[] } | null;
}
interface ItemBody {
  id: string;
  kind: string;
  subjectRef: string;
  state: string;
  version: number;
  options: { id: string }[];
  decidedBy: string | null;
  decision: { option: string } | null;
}
interface AuditBody {
  actor: string;
  action: string;
  after: Record<string, unknown>;
}
interface GitHubPull {
  state: string;
  merged: boolean;
  changed_files: number;
  merge_commit_sha: string | null;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

/** Polls `read` every `everyMs` until `done` holds, or fails after `ms` naming `what`. */
async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms: number,
  what: string,
  everyMs: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(ms / MINUTE)} min waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * The change C7 asks for: the first of these that the sandbox's `src/math.ts`
 * doesn't export yet. The sandbox is never reset, so a fixed change would be
 * a no-op once a run has merged it (run 5's PR changed no files).
 */
const C7_FUNCTIONS = [
  'sum',
  'difference',
  'product',
  'quotient',
  'remainder',
  'power',
  'maximum',
  'minimum',
  'average',
  'absoluteDifference',
];

function nextFunction(checkout: string): string {
  const math = readFileSync(join(checkout, 'src/math.ts'), 'utf8');
  const name = C7_FUNCTIONS.find((f) => !new RegExp(`export function ${f}\\b`).test(math));
  if (name === undefined)
    throw new Error(
      `the sandbox's src/math.ts already exports every C7 function (${C7_FUNCTIONS.join(', ')}); add names to C7_FUNCTIONS`,
    );
  return name;
}

const stagesOf = (job: JobBody, id: string) =>
  job.stageRuns.filter((s) => s.stageId === id).map((s) => s.state);

/** What the factory recorded about why the Job stopped short of the merge item. */
async function reasons(rt: RunningRuntime, job: JobBody): Promise<string[]> {
  const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
  const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
  return [
    ...job.stageRuns.flatMap((s) => [
      ...(s.failure === null
        ? []
        : [`stage ${s.stageId}: ${s.failure.reason}: ${s.failure.message}`]),
      ...((s.blocker ?? null) === null
        ? []
        : [`stage ${s.stageId} blocked: ${s.blocker?.reason ?? ''}`]),
    ]),
    ...attempts.flatMap((a) =>
      a.exitReason === null || a.state === 'passed'
        ? []
        : [`attempt ${String(a.n)}: ${a.exitReason}: ${a.exitDetail ?? ''}`],
    ),
    ...tasks.flatMap((t) =>
      t.blocker === null ? [] : [`task ${t.key}: ${t.blocker.reason}: ${t.blocker.detail}`],
    ),
  ];
}

const mergeItem = async (rt: RunningRuntime, jobId: string): Promise<ItemBody | undefined> =>
  (await json<(ItemBody & { jobId: string })[]>(rt.request('/v1/inbox'))).find(
    (i) => i.kind === 'merge' && i.jobId === jobId,
  );

describe('C7 [real] GitHub delivery', () => {
  it(
    'opens a real PR whose head is the reviewed SHA, and merges it only after the human approves the merge item',
    async () => {
      const outcome: Record<string, unknown> = { at: new Date().toISOString(), sandbox: SANDBOX };
      const record = () => {
        mkdirSync(RESULTS, { recursive: true });
        const at = String(outcome['at']).replace(/[:.]/g, '-');
        writeFileSync(join(RESULTS, `c7-${at}.json`), JSON.stringify(outcome, null, 2));
      };

      // ---- preconditions ----
      await requireSandboxLogin();

      // ---- the sandbox: seed once, clean between runs, check out ----
      const sandbox = await prepareSandbox({
        fullName: SANDBOX,
        apiBaseUrl: GITHUB_API,
        token: ghToken,
        gitEnv: GH_CREDENTIALS,
        workDir: tempDir('c7-sandbox-'),
      });
      outcome['setup'] = { seeded: sandbox.seeded, cleaned: sandbox.cleaned };
      const mainBefore = gitWith({}, sandbox.checkout, ['rev-parse', 'HEAD']).trim();

      // ---- the factory, with the real Claude Code and the real GitHub ----
      const home = await initializedHome();
      useClaudeCode(home, 'claude');
      patchFactoryConfig(home, { github: { token: 'gh', pollIntervalMs: 10_000 } });
      const rt = await startRuntime(home, {
        env: { HOME: homedir(), USER: userInfo().username, ...GH_CREDENTIALS },
      });
      killGroupsOnFinish(rt);
      const status = await json<{ harness: { credentials: string } | null }>(
        rt.request('/v1/status'),
      );
      if (status.harness?.credentials !== 'present')
        throw new Error('precondition: Claude Code reports no login. Run `claude /login`.');

      const added = await rt.home.cli([
        'repo',
        'add',
        sandbox.checkout,
        '--project',
        'sandbox',
        '--yes',
        '--merge-policy',
        'human_approval',
        '--required-check',
        SANDBOX_CHECK,
        '--setup',
        SANDBOX_SETUP,
      ]);
      expect(added.code, added.stderr).toBe(0);
      const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
      if (repo === undefined) throw new Error('no Repository');
      expect(repo.github).toEqual({ owner: OWNER, name: NAME });
      expect(repo.mergePolicy).toBe('human_approval');
      await skipPlanApproval(rt, repo.projectId);

      const fn = nextFunction(sandbox.checkout);
      outcome['function'] = fn;
      const res = await post(rt, '/v1/jobs', {
        repositoryId: repo.id,
        title: `Add ${fn}() to math.ts`,
        description: `Export ${fn}(a: number, b: number): number from src/math.ts, with a test.`,
      });
      expect(res.status).toBe(201);
      const jobId = ((await res.json()) as JobBody).id;
      outcome['job'] = jobId;
      const jobOf = () => json<JobBody>(rt.request(`/v1/jobs/${jobId}`));

      try {
        // ---- through to an opened PR, waiting on the merge Gate ----
        const waiting = await until(
          jobOf,
          (j) => j.status !== 'active' || stagesOf(j, 'merge_approval').includes('waiting_human'),
          45 * MINUTE,
          'the Job to reach merge_approval',
          10_000,
        );
        if (!stagesOf(waiting, 'merge_approval').includes('waiting_human')) {
          outcome['status'] = waiting.status;
          outcome['reasons'] = await reasons(rt, waiting);
          throw new Error(
            `the Job stopped before a PR waited on the merge Gate (${waiting.status}): ${JSON.stringify(outcome['reasons'])}`,
          );
        }

        const [pr] = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
        if (pr === undefined) throw new Error('no pull request recorded');
        outcome['pullRequest'] = pr.url;
        const branch = `factory/${jobId}/integration`;
        expect(pr).toMatchObject({ headBranch: branch, baseBranch: 'main', state: 'open' });
        expect(pr.url).toBe(`https://github.com/${SANDBOX}/pull/${String(pr.number)}`);
        const live = await sandboxGet<GitHubPull>(`/pulls/${String(pr.number)}`);
        expect(live).toMatchObject({ state: 'open', merged: false });
        expect(live.head.ref).toBe(branch);
        expect(live.base.ref).toBe('main');
        expect(live.body).toContain(`<!-- factory:${jobId}:pull_request -->`);
        // A real change: the function C7 asked for isn't on main yet.
        expect(live.changed_files, 'the PR changes files').toBeGreaterThan(0);

        // The PR head is the SHA the factory approved and pushed, and that head was reviewed.
        const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${jobId}/tasks`));
        const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${jobId}/attempts`));
        const reviews = await json<ReviewBody[]>(rt.request(`/v1/jobs/${jobId}/reviews`));
        const integration = tasks.find((t) => t.kind === 'integration');
        const approvedHead = attempts
          .filter((a) => a.taskId === integration?.id && a.state === 'passed')
          .at(-1)?.headSha;
        expect(live.head.sha).toBe(approvedHead);
        expect(pr.headSha).toBe(live.head.sha);
        expect(pr.pushedSha).toBe(live.head.sha);
        const approvals = reviews.filter((r) => r.outcome === 'approved');
        const tree = (sha: string) =>
          gitWith({}, repo.clonePath, ['rev-parse', `${sha}^{tree}`]).trim();
        if (stagesOf(waiting, 'integration_review').includes('skipped')) {
          // One Plan Task (ADR-0035): the branch's tree is the tree of the head its review approved.
          const planTasks = tasks.filter((t) => t.kind === 'plan').map((t) => t.id);
          const reviewed = approvals.filter((r) => planTasks.includes(r.taskId));
          expect(reviewed.map((r) => tree(r.headSha))).toContain(tree(live.head.sha));
          outcome['reviewedSha'] = {
            how: 'integration review skipped; tree of the approved Task head',
            sha: reviewed.at(-1)?.headSha,
          };
        } else {
          const reviewed = approvals.filter((r) => r.taskId === integration?.id).at(-1);
          expect(reviewed?.headSha).toBe(live.head.sha);
          outcome['reviewedSha'] = { how: 'integration review', sha: reviewed?.headSha };
        }

        // ---- CI on the real GitHub Actions: the merge item offers merge once it passes ----
        const offered = await until(
          async () => {
            const [p] = await json<PullRequestBody[]>(
              rt.request(`/v1/jobs/${jobId}/pull-requests`),
            );
            const j = await jobOf();
            return { p, j, item: await mergeItem(rt, jobId) };
          },
          ({ p, j, item }) =>
            j.status !== 'waiting_human' ||
            p?.gate?.conditions.find((c) => c.id === 'checks')?.status === 'fail' ||
            item?.options.some((o) => o.id === 'merge') === true,
          25 * MINUTE,
          `the required check '${SANDBOX_CHECK}' to pass and the merge item to offer merge`,
          10_000,
        );
        outcome['gate'] = offered.p?.gate;
        if (offered.item?.options.some((o) => o.id === 'merge') !== true) {
          outcome['reasons'] = await reasons(rt, offered.j);
          throw new Error(
            `CI did not pass, or the Job left the merge Gate: ${JSON.stringify(offered.p?.gate)} ${JSON.stringify(outcome['reasons'])}`,
          );
        }
        const item = offered.item;
        const policy = offered.p?.gate?.conditions.find((c) => c.id === 'policy');
        expect(policy?.status).toBe('pending');
        expect(policy?.reason).toMatch(/^human_approval/);
        expect((await sandboxGet<GitHubPull>(`/pulls/${String(pr.number)}`)).merged).toBe(false);

        // ---- the human's merge decision ----
        const command = `FACTORY_HOME=${home.dir} pnpm factory inbox decide ${item.id} merge --expect-version ${String(item.version)}`;
        const message = [
          `C7 waits for your merge decision on ${pr.url} (head ${live.head.sha}).`,
          `Look at the PR, then approve it with:`,
          `  ${command}`,
          `(or decline: replace 'merge' with 'cancel_job'). Waiting up to 30 minutes.`,
        ].join('\n');
        mkdirSync(RESULTS, { recursive: true });
        writeFileSync(join(RESULTS, 'c7-waiting.txt'), `${message}\n`);
        process.stderr.write(`\n${message}\n`);
        await until(
          async () => {
            // Nothing merges while the item waits. The factory merges seconds
            // after the decision, so a merged PR is only right if the item,
            // read after the PR, was decided `merge` by the human. A merge on
            // GitHub itself is decided by the poller (`MERGED_ON_GITHUB`):
            // that bypasses the Inbox approval C7 is about, so it fails.
            const gh = await sandboxGet<GitHubPull>(`/pulls/${String(pr.number)}`);
            const waiting = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
            if (gh.merged)
              expect(
                {
                  state: waiting.state,
                  decidedBy: waiting.decidedBy,
                  option: waiting.decision?.option,
                },
                'merged without the human approving the merge item (merged on GitHub directly?)',
              ).toEqual({ state: 'decided', decidedBy: 'user:local', option: 'merge' });
            return waiting;
          },
          (i) => i.state !== 'open',
          30 * MINUTE,
          'the human to decide the merge item',
          15_000,
        );
        const decidedItem = await json<ItemBody>(rt.request(`/v1/inbox/${item.id}`));
        outcome['decision'] = decidedItem.decision;
        expect(decidedItem).toMatchObject({ state: 'decided', decidedBy: 'user:local' });
        expect(decidedItem.decision?.option, 'the human chose merge').toBe('merge');

        // ---- merged by the factory, after the approval ----
        const done = await until(
          jobOf,
          (j) =>
            ['completed', 'failed', 'cancelled'].includes(j.status) ||
            stagesOf(j, 'merge').includes('waiting_human'),
          5 * MINUTE,
          'the merge',
          5_000,
        );
        outcome['status'] = done.status;
        expect(done.status, JSON.stringify(await reasons(rt, done))).toBe('completed');
        const merged = await sandboxGet<GitHubPull>(`/pulls/${String(pr.number)}`);
        expect(merged.merged).toBe(true);
        const [recorded] = await json<PullRequestBody[]>(
          rt.request(`/v1/jobs/${jobId}/pull-requests`),
        );
        expect(recorded?.state).toBe('merged');
        expect(recorded?.mergeSha).toBe(merged.merge_commit_sha);
        outcome['mergeSha'] = recorded?.mergeSha;
        const audit = await json<AuditBody[]>(rt.request(`/v1/jobs/${jobId}/audit`));
        const approval = audit.find((a) => a.action === 'merge.approved');
        expect(approval?.actor).toBe('user:local');
        expect(approval?.after).toMatchObject({ headSha: live.head.sha, method: 'merge' });
        // A merge commit on main: parents (main as it was, the reviewed head).
        const parents = await sandboxGet<{ parents: { sha: string }[] }>(
          `/commits/${String(merged.merge_commit_sha)}`,
        );
        expect(parents.parents.map((p) => p.sha)).toEqual([mainBefore, live.head.sha]);
        outcome['result'] = 'passed';
      } catch (err) {
        outcome['result'] = 'failed';
        outcome['error'] = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        outcome['logs'] = (await rt.home.cli(['logs', jobId])).stdout;
        record();
      }
    },
    120 * MINUTE,
  );
});
