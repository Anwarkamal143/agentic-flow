/**
 * Cancel cleanup (#48, ROADMAP exit test B7, PRODUCT_SPEC §12, ADR-0027). A
 * cancel first stops everything: every running Attempt (SIGTERM, then SIGKILL
 * after the grace period), its leases and capacity tokens, its Worktree
 * `preserved`, the open Inbox Items `cancelled`. Only then does it open the
 * Job's one `cleanup` Inbox Item: discard the preserved Worktrees, or keep
 * them (the default). A discard removes only the Worktree directories; the
 * Task Branches stay in the Factory Clone. Asserted through the API, the CLI,
 * the dashboard and git only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tempDir,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  json,
  jobSettled,
  post,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { startDashboard } from '../support/dashboard.js';
import { groupAlive, killGroupsOnFinish, waitFor } from '../support/processes.js';
import { scriptWith, validOutput } from '../support/scripts.js';

interface ItemBody {
  id: string;
  jobId: string;
  kind: string;
  subjectRef: string;
  question: string;
  why: string;
  options: { id: string; label: string; description: string }[];
  recommended: string | null;
  state: string;
  decidedBy: string | null;
  decision: { option: string } | null;
  version: number;
}
interface WorktreeBody {
  id: string;
  taskId: string;
  path: string;
  branch: string;
  state: string;
}
interface AttemptBody {
  id: string;
  taskId: string;
  state: string;
  exitReason: string | null;
}

/** A Plan Task writing one file, `docs/<key>.md`. */
function docTask(key: string) {
  const [base] = (validOutput('planning') as { tasks: Record<string, unknown>[] }).tasks;
  return {
    ...structuredClone(base),
    key,
    title: `Write docs/${key}.md`,
    scope: { writable: [`docs/${key}.md`], forbidden: [] },
    dependsOn: [],
    acceptance: ['AC-01'],
    verification: [{ key: 'test', command: `test -f docs/${key}.md`, criteria: ['AC-01'] }],
  };
}

const RESULT = {
  status: 'done',
  summary: 'Wrote the file.',
  commits: [],
  criteria: [{ code: 'AC-01', claim: 'met', how: 'the file exists' }],
};

/**
 * A developer Run that commits `docs/<key>.md`, leaves an uncommitted change,
 * notes it started (`<dir>/<key>`), and then never ends. `stubborn` ignores
 * SIGTERM, so only SIGKILL stops it. Once `<dir>/release` exists, the Run
 * ends at once after its commit instead (a later Job's Tasks finish).
 */
function hangingRun(dir: string, key: string, opts: { stubborn?: boolean } = {}) {
  const trap = opts.stubborn === true ? `trap 'echo TERM >> ${dir}/signals' TERM; ` : '';
  return [
    {
      steps: [
        { write: { path: `docs/${key}.md`, content: `# ${key}\n` } },
        { commit: `Write docs/${key}.md` },
        {
          run:
            `if [ -f '${dir}/release' ]; then exit 0; fi; ${trap}` +
            `echo 'not committed' > docs/${key}-draft.md; touch '${dir}/${key}'; ` +
            'while :; do sleep 0.2; done',
        },
      ],
      result: RESULT,
    },
  ];
}

const APPROVE = [
  {
    output: {
      outcome: 'approved',
      summary: 'The file is there.',
      findings: [],
      criteria: [{ code: 'AC-01', verdict: 'pass', detail: 'the test command passed' }],
    },
  },
];

async function runtimeWith(script: string): Promise<{ rt: RunningRuntime; repoId: string }> {
  const home = await initializedHome();
  useFakeHarness(home, script);
  const rt = await startRuntime(home);
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  return { rt, repoId: repo.id };
}

async function createJob(rt: RunningRuntime, repositoryId: string, extra = {}): Promise<JobBody> {
  const res = await post(rt, '/v1/jobs', { repositoryId, title: 'Write the docs', ...extra });
  expect(res.status, 'create Job').toBe(201);
  return (await res.json()) as JobBody;
}

const events = (rt: RunningRuntime, jobId: string) =>
  json<EventBody[]>(rt.request(`/v1/jobs/${jobId}/events`));

async function cleanupItemOf(rt: RunningRuntime, jobId: string): Promise<ItemBody[]> {
  const all = await json<ItemBody[]>(rt.request('/v1/inbox?all=true'));
  return all.filter((i) => i.jobId === jobId && i.kind === 'cleanup');
}

describe('B7: cancelling a Job with several running Attempts', { timeout: 90_000 }, () => {
  it('stops them all first, then opens one cleanup item, and keeps the Worktrees by default', async () => {
    const dir = tempDir('factory-b7-');
    const { rt, repoId } = await runtimeWith(
      scriptWith(
        { planning: [{ output: { tasks: [docTask('x'), docTask('y'), docTask('z')] } }] },
        {
          x: hangingRun(dir, 'x', { stubborn: true }),
          y: hangingRun(dir, 'y'),
          z: hangingRun(dir, 'z'),
        },
        { x: APPROVE, y: APPROVE, z: APPROVE },
      ),
    );
    const wide = { concurrency: { perRepository: 3, perJob: 3 } };
    const created = await createJob(rt, repoId, wide);
    await waitFor(
      () => ['x', 'y', 'z'].every((k) => existsSync(join(dir, k))),
      30_000,
      'three Attempts running at once',
    );
    const groups = (await events(rt, created.id))
      .filter((e) => e.type === 'harness_run.started' && e.payload['role'] === 'developer')
      .map((e) => e.payload['pid'] as number);
    expect(groups).toHaveLength(3);

    const res = await rt.home.cli(['job', 'cancel', created.id]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`Cancelled Job ${created.id}`);

    // Everything stopped: graceful first, forced for the one that ignored SIGTERM.
    expect(readFileSync(join(dir, 'signals'), 'utf8')).toContain('TERM');
    for (const group of groups) expect(groupAlive(group), `group ${String(group)}`).toBe(false);
    const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${created.id}/attempts`));
    expect(attempts.map((a) => [a.state, a.exitReason])).toEqual([
      ['cancelled', 'cancelled'],
      ['cancelled', 'cancelled'],
      ['cancelled', 'cancelled'],
    ]);
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`));
    expect(worktrees.map((w) => w.state)).toEqual(['preserved', 'preserved', 'preserved']);
    for (const w of worktrees) expect(existsSync(w.path), w.path).toBe(true);

    // One cleanup item, opened only after every Attempt, Task and Worktree was recorded.
    const [item, more] = await cleanupItemOf(rt, created.id);
    expect(more).toBeUndefined();
    if (item === undefined) throw new Error('no cleanup item');
    expect(res.stdout).toContain(`Cleanup Approval ${item.id}`);
    expect(item).toMatchObject({ state: 'open', recommended: 'keep', subjectRef: created.id });
    expect(item.question).toContain('3 preserved Worktrees');
    expect(item.options.map((o) => o.id)).toEqual(['keep', 'discard']);
    const log = await events(rt, created.id);
    const opened = log.find((e) => e.type === 'approval.opened' && e.entityId === item.id)?.seq;
    if (opened === undefined) throw new Error('no approval.opened for the cleanup item');
    const stops = log.filter((e) =>
      ['attempt.cancelled', 'task.cancelled', 'worktree.preserved', 'job.cancelled'].includes(
        e.type,
      ),
    );
    expect(stops.length).toBeGreaterThanOrEqual(10);
    for (const e of stops) expect(e.seq, e.type).toBeLessThan(opened);
    expect(log.filter((e) => e.type === 'attempt.cancelled')).toHaveLength(3);

    // The leases and capacity tokens were released: a new Job claims all three global slots.
    writeFileSync(join(dir, 'release'), '');
    const next = await createJob(rt, repoId, wide);
    const done = await waitForJob(rt, next.id, jobSettled, 40_000);
    expect(done.status).toBe('completed');
    const nextLog = await events(rt, next.id);
    const claimed = nextLog.filter((e) => e.type === 'task.claimed').map((e) => e.seq);
    const approved = nextLog.filter((e) => e.type === 'task.approved').map((e) => e.seq);
    expect(claimed).toHaveLength(3);
    expect(Math.max(...claimed), 'all three claimed at once').toBeLessThan(Math.min(...approved));

    // Keep (the default) closes the item and leaves every Worktree in place.
    const kept = await rt.home.cli([
      'inbox',
      'decide',
      item.id,
      'keep',
      '--expect-version',
      String(item.version),
    ]);
    expect(kept.code, kept.stderr).toBe(0);
    const [decided] = await cleanupItemOf(rt, created.id);
    expect(decided).toMatchObject({ state: 'decided', decision: { option: 'keep' } });
    await new Promise((r) => setTimeout(r, 500));
    const after = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`));
    expect(after.map((w) => w.state)).toEqual(['preserved', 'preserved', 'preserved']);
    for (const w of after) expect(existsSync(w.path), w.path).toBe(true);
  });

  it('opens no cleanup item when the cancel leaves no preserved Worktree', async () => {
    const slow = { output: validOutput('triage'), delayMs: 60_000 };
    const { rt, repoId } = await runtimeWith(scriptWith({ triage: [slow] }));
    const created = await createJob(rt, repoId);
    await waitForJob(rt, created.id, (j) =>
      j.stageRuns.some((s) => s.stageId === 'triage' && s.state === 'running'),
    );
    const res = await rt.home.cli(['job', 'cancel', created.id]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('No cleanup Approval: the cancel left no preserved Worktree');
    expect(await cleanupItemOf(rt, created.id)).toEqual([]);
  });
});

describe('discarding the preserved Worktrees', { timeout: 90_000 }, () => {
  it('removes the directories on the dashboard decision and keeps the Task Branches', async () => {
    const dir = tempDir('factory-discard-');
    const { rt, repoId } = await runtimeWith(
      scriptWith(
        { planning: [{ output: { tasks: [docTask('x'), docTask('y')] } }] },
        { x: hangingRun(dir, 'x'), y: hangingRun(dir, 'y') },
      ),
    );
    const created = await createJob(rt, repoId);
    await waitFor(
      () => ['x', 'y'].every((k) => existsSync(join(dir, k))),
      30_000,
      'both Attempts running',
    );
    const res = await rt.home.cli(['job', 'cancel', created.id]);
    expect(res.code, res.stderr).toBe(0);
    const [item] = await cleanupItemOf(rt, created.id);
    if (item === undefined) throw new Error('no cleanup item');
    expect(item.question).toContain('2 preserved Worktrees');
    const worktrees = await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`));
    expect(worktrees).toHaveLength(2);
    const [repo] = await json<[{ clonePath: string }]>(rt.request('/v1/repositories'));
    const tips = worktrees.map((w) => git(repo.clonePath, ['rev-parse', w.branch]).trim());

    const dash = await startDashboard(rt.home);
    const form = await dash.postForm(`/api/inbox/${item.id}/decide`, {
      expectedVersion: String(item.version),
      subjectRef: item.subjectRef,
      option: 'discard',
    });
    expect(form.status, form.body).toBe(303);
    const [decided] = await cleanupItemOf(rt, created.id);
    expect(decided).toMatchObject({
      state: 'decided',
      decidedBy: 'user:local',
      decision: { option: 'discard' },
    });

    await waitFor(
      async () =>
        (await json<WorktreeBody[]>(rt.request(`/v1/jobs/${created.id}/worktrees`))).every(
          (w) => w.state === 'removed',
        ),
      20_000,
      'the Worktrees to be removed',
    );
    for (const w of worktrees) expect(existsSync(w.path), w.path).toBe(false);
    // The Task Branches stay, at the same commits, holding the committed work.
    worktrees.forEach((w, i) => {
      expect(git(repo.clonePath, ['rev-parse', w.branch]).trim()).toBe(tips[i]);
    });
    const x = worktrees.find((w) => w.branch.endsWith('-x'));
    expect(git(repo.clonePath, ['show', `${x?.branch ?? ''}:docs/x.md`])).toBe('# x\n');
    const types = (await events(rt, created.id)).map((e) => e.type);
    expect(types.filter((t) => t === 'worktree.removed')).toHaveLength(2);
    expect(types).toContain('cleanup.completed');
  });
});
