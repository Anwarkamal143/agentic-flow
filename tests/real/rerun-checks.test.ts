/**
 * `rerun_checks` `[real]` (#77, ADR-0040): a failed GitHub Actions job on a
 * real PR in the sandbox `Anwarkamal143/factory-sandbox` is re-run through
 * the Actions API, and really runs again. Not part of `pnpm test` or CI:
 *
 *   pnpm test:real tests/real/rerun-checks.test.ts
 *
 * The Harness is the fake one (no Claude usage): its one Plan Task adds
 * `rerun-probe.txt`, which makes the sandbox workflow's `rerun-probe` job
 * fail its first attempt on purpose and pass a re-run
 * (`tests/support/sandbox.ts`). Everything GitHub does is real: the push,
 * the PR, Actions CI, and the re-run.
 *
 * Preconditions (each failure names itself): `gh` logged in as the sandbox's
 * owner with the `repo` and `workflow` scopes (as C7). The setup seeds or
 * cleans the sandbox, and brings its workflow up to date with one
 * fast-forward commit on `main` if it is an older one these tests seeded.
 *
 * The test decides `rerun_checks` itself: re-running a sandbox CI job is the
 * thing under test, and changes nothing outside the sandbox. It never merges.
 * The PR is left open; the next run's cleanup closes it. Each run writes its
 * outcome to `tests/real/results/` (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, post, skipPlanApproval, type JobBody } from '../support/api.js';
import {
  initializedHome,
  patchFactoryConfig,
  startRuntime,
  tempDir,
  useFakeHarness,
} from '../support/factory.js';
import { repoRoot } from '../support/paths.js';
import { killGroupsOnFinish } from '../support/processes.js';
import {
  GH_CREDENTIALS,
  GITHUB_API,
  ghToken,
  requireSandboxLogin,
  sandboxGet,
} from '../support/real-github.js';
import {
  prepareSandbox,
  RERUN_PROBE_FILE,
  SANDBOX,
  SANDBOX_RERUN_CHECK,
} from '../support/sandbox.js';
import { scriptWith, validOutput } from '../support/scripts.js';

const MINUTE = 60_000;
const RESULTS = join(repoRoot, 'tests/real/results');
/** As C7: the factory's own verification of `tiny-ts` needs its dependencies (ADR-0047). */
const SANDBOX_SETUP = 'npm install --no-package-lock --ignore-scripts --no-audit --no-fund';

interface RepoBody {
  id: string;
  projectId: string;
}
interface PullRequestBody {
  number: number;
  headSha: string;
  gate: { conditions: { id: string; status: string; reason: string }[] } | null;
}
interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  state: string;
  subjectRef: string;
  version: number;
  why: string;
}
interface EventBody {
  type: string;
  payload: Record<string, unknown>;
}
interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}
interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: string;
  run_attempt: number;
}

const APPROVE = {
  output: {
    outcome: 'approved',
    summary: 'Looks right.',
    findings: [],
    criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the file is there' }],
  },
};

/** One Plan Task adding the rerun probe file; every review approves. */
function script() {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  const task = {
    ...structuredClone(base),
    key: 'probe',
    title: `Add ${RERUN_PROBE_FILE}`,
    scope: { writable: [RERUN_PROBE_FILE], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'probe', command: `test -f ${RERUN_PROBE_FILE}`, criteria: ['AC-01'] }],
  };
  return scriptWith(
    { planning: [{ output: { tasks: [task] } }] },
    {
      probe: [
        {
          steps: [
            { write: { path: RERUN_PROBE_FILE, content: 'Fails the first CI attempt (#77).\n' } },
            { commit: `Add ${RERUN_PROBE_FILE}` },
          ],
          result: {
            status: 'done',
            summary: `Add ${RERUN_PROBE_FILE}`,
            commits: [],
            criteria: [{ code: 'AC-01', claim: 'met', how: 'the file is there' }],
          },
        },
      ],
    },
    { probe: [APPROVE], integration: [APPROVE] },
  );
}

/** Polls `read` every `everyMs` until `done` holds, or fails after `ms` naming `what`. */
async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms: number,
  what: string,
  everyMs = 10_000,
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

describe('rerun_checks [real] on GitHub Actions', () => {
  it(
    'a failed Actions job on a real PR is re-run through the Actions API and really runs again',
    async () => {
      const outcome: Record<string, unknown> = { at: new Date().toISOString(), sandbox: SANDBOX };
      const record = () => {
        mkdirSync(RESULTS, { recursive: true });
        const at = String(outcome['at']).replace(/[:.]/g, '-');
        writeFileSync(join(RESULTS, `rerun-checks-${at}.json`), JSON.stringify(outcome, null, 2));
      };

      await requireSandboxLogin();
      const sandbox = await prepareSandbox({
        fullName: SANDBOX,
        apiBaseUrl: GITHUB_API,
        token: ghToken,
        gitEnv: GH_CREDENTIALS,
        workDir: tempDir('rerun-sandbox-'),
      });
      outcome['setup'] = {
        seeded: sandbox.seeded,
        workflowUpdated: sandbox.workflowUpdated,
        cleaned: sandbox.cleaned,
      };

      const home = await initializedHome();
      useFakeHarness(home, script());
      patchFactoryConfig(home, { github: { token: 'gh', pollIntervalMs: 10_000 } });
      const rt = await startRuntime(home, {
        env: { HOME: homedir(), USER: userInfo().username, ...GH_CREDENTIALS },
      });
      killGroupsOnFinish(rt);

      const added = await rt.home.cli([
        'repo',
        'add',
        sandbox.checkout,
        '--project',
        'sandbox',
        '--yes',
        '--required-check',
        SANDBOX_RERUN_CHECK,
        '--setup',
        SANDBOX_SETUP,
      ]);
      expect(added.code, added.stderr).toBe(0);
      const [repo] = await json<RepoBody[]>(rt.request('/v1/repositories'));
      if (repo === undefined) throw new Error('no Repository');
      await skipPlanApproval(rt, repo.projectId);
      const res = await post(rt, '/v1/jobs', {
        repositoryId: repo.id,
        title: `Add ${RERUN_PROBE_FILE}`,
      });
      expect(res.status).toBe(201);
      const jobId = ((await res.json()) as JobBody).id;
      outcome['job'] = jobId;

      try {
        // ---- the PR's first CI attempt fails the probe: ci_failed ----
        const ciItem = async () => {
          const job = await json<JobBody>(rt.request(`/v1/jobs/${jobId}`));
          if (job.status !== 'active' && job.status !== 'waiting_human')
            throw new Error(`the Job ended ${job.status} before CI failed`);
          return (await json<ItemBody[]>(rt.request('/v1/inbox'))).find(
            (i) => i.jobId === jobId && i.kind === 'blocker' && i.state === 'open',
          );
        };
        const item = await until(
          ciItem,
          (i) => i !== undefined,
          30 * MINUTE,
          `the ci_failed Blocker Approval on ${SANDBOX_RERUN_CHECK}`,
        );
        if (item === undefined) throw new Error('unreachable');
        const pr = await json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`));
        const [opened] = pr;
        if (opened === undefined) throw new Error('no PR');
        outcome['pr'] = opened.number;
        outcome['head'] = opened.headSha;
        expect(item.why).toContain(
          `rerun_checks can re-run ${SANDBOX_RERUN_CHECK} (GitHub Actions)`,
        );

        const runsOnHead = () =>
          sandboxGet<{ workflow_runs: GitHubWorkflowRun[] }>(
            `/actions/runs?head_sha=${opened.headSha}`,
          );
        const [before] = (await runsOnHead()).workflow_runs;
        outcome['before'] = before;
        expect(before?.run_attempt).toBe(1);

        // ---- rerun_checks: the real GitHub accepts the Actions re-run ----
        const decided = await post(rt, `/v1/inbox/${item.id}/decide`, {
          expectedVersion: item.version,
          subjectRef: item.subjectRef,
          option: 'rerun_checks',
        });
        const decidedText = await decided.text();
        outcome['decision'] = { status: decided.status, body: decidedText };
        expect(decided.status, decidedText).toBe(200);
        const events = await json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events?limit=1000`));
        const requested = events.find((e) => e.type === 'pull_request.checks_rerun_requested');
        expect(requested?.payload['checks']).toEqual([SANDBOX_RERUN_CHECK]);

        // ---- the job really runs again, as attempt 2, and passes ----
        const after = await until(
          runsOnHead,
          (r) => r.workflow_runs.some((w) => w.run_attempt >= 2 && w.status === 'completed'),
          20 * MINUTE,
          'the workflow run to finish its second attempt',
        );
        outcome['after'] = after.workflow_runs;
        const checks = await sandboxGet<{ check_runs: GitHubCheckRun[] }>(
          `/commits/${opened.headSha}/check-runs?check_name=${SANDBOX_RERUN_CHECK}`,
        );
        outcome['checkRuns'] = checks.check_runs;
        expect(checks.check_runs.length, 'a new check run for the re-run').toBeGreaterThanOrEqual(
          2,
        );
        const newest = checks.check_runs.reduce((a, b) => (b.id > a.id ? b : a));
        expect(newest).toMatchObject({ status: 'completed', conclusion: 'success' });

        // ---- the factory sees it: the gate's checks condition passes ----
        const gated = await until(
          () => json<PullRequestBody[]>(rt.request(`/v1/jobs/${jobId}/pull-requests`)),
          (p) => p[0]?.gate?.conditions.find((c) => c.id === 'checks')?.status === 'pass',
          5 * MINUTE,
          'the Merge Gate checks condition to pass',
        );
        outcome['gate'] = gated[0]?.gate;
        outcome['result'] = 'passed';
      } catch (err) {
        outcome['result'] = 'failed';
        outcome['error'] = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        record();
      }
    },
    60 * MINUTE,
  );
});
