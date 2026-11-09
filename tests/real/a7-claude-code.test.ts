/**
 * A7 `[real]` (ROADMAP Phase A): the A1 scenario against a freshly generated
 * `tiny-ts` fixture, with the REAL Claude Code Harness. Not part of `pnpm test`
 * or CI: it needs the `claude` CLI on PATH with a subscription login, uses the
 * network and the operator's usage, and takes minutes.
 *
 *   pnpm test:real
 *
 * Passing means the Job completed with the factory's own Gates and review, or
 * stopped with an honest, specific reason recorded (never a bare exit code).
 * Each run writes its outcome to `tests/real/results/` (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, type RunningRuntime } from '../support/factory.js';
import { createJob, json, registeredRepo, waitForJob, type JobBody } from '../support/api.js';
import { useClaudeCode } from '../support/claude.js';
import { factoryGroups, groupAlive, killGroupsOnFinish, waitFor } from '../support/processes.js';
import { repoRoot } from '../support/paths.js';

interface AttemptBody {
  id: string;
  n: number;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  sessionRef: string | null;
  harness: { id: string; version: string | null };
  promptTemplate: { id: string; hash: string };
  usage: { tag: string; costTag?: string; costUsd: number | null } | null;
}

interface TaskBody {
  key: string;
  state: string;
  blocker: { kind: string; reason: string; detail: string } | null;
}

/**
 * The real CLI finds the operator's subscription login through HOME and USER
 * (the keychain), so the runtime gets the operator's own; the factory home
 * stays a temp dir. A missing login is a precondition failure, never an A7 result.
 */
async function realRuntime(): Promise<{ rt: RunningRuntime; repoId: string }> {
  const home = await initializedHome();
  useClaudeCode(home, 'claude');
  const rt = await startRuntime(home, { env: { HOME: homedir(), USER: userInfo().username } });
  killGroupsOnFinish(rt);
  const status = await json<{ harness: { credentials: string } | null }>(rt.request('/v1/status'));
  if (status.harness?.credentials !== 'present') {
    throw new Error(
      `precondition: Claude Code reports no login (credentials: ${String(status.harness?.credentials)}). Harness Run \`claude /login\`, then \`claude auth status\`.`,
    );
  }
  const repo = await registeredRepo(rt);
  return { rt, repoId: repo.id };
}

/** Why the Job didn't complete, from what the factory recorded. Empty when nothing says. */
function reasons(job: JobBody, attempts: AttemptBody[], tasks: TaskBody[]): string[] {
  return [
    ...job.stageRuns.flatMap((s) =>
      s.failure === null ? [] : [`stage ${s.stageId}: ${s.failure.reason}: ${s.failure.message}`],
    ),
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

describe('A7 [real] Claude Code', () => {
  it(
    'runs the A1 scenario on tiny-ts with the real Harness: completes, or fails with a specific reason',
    async () => {
      const { rt, repoId } = await realRuntime();
      const created = await createJob(rt, repoId, 'Add sum() to math.ts');
      const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 40 * 60_000);
      const attempts = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
      const tasks = await json<TaskBody[]>(rt.request(`/v1/jobs/${job.id}/tasks`));
      const why = reasons(job, attempts, tasks);
      const outcome = {
        at: new Date().toISOString(),
        job: job.id,
        status: job.status,
        stages: job.stageRuns.map((s) => [s.stageId, s.state]),
        attempts: attempts.map((a) => ({
          n: a.n,
          state: a.state,
          exitReason: a.exitReason,
          exitDetail: a.exitDetail,
          harness: a.harness,
          sessionRef: a.sessionRef,
          template: a.promptTemplate,
          usage: a.usage,
        })),
        reasons: why,
        // The Harness Runs' and verification commands' output (redacted), to see why.
        logs: (await rt.home.cli(['logs', job.id])).stdout,
        tasks: tasks.map((t) => ({ key: t.key, state: t.state, blocker: t.blocker })),
      };
      const dir = join(repoRoot, 'tests/real/results');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `a7-${outcome.at.replace(/[:.]/g, '-')}.json`),
        JSON.stringify(outcome, null, 2),
      );
      console.log(`A7 outcome: ${JSON.stringify(outcome, null, 2)}`);

      for (const a of attempts) {
        expect(a.harness.id).toBe('claude-code');
        expect(a.harness.version).toMatch(/^\d+\.\d+/);
        expect(a.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
        expect(a.promptTemplate.hash).toMatch(/^sha256:/);
        if (a.usage !== null) expect(a.usage.costTag).toBe('unknown/subscription');
      }
      if (job.status === 'completed') {
        expect(attempts.at(-1)?.state).toBe('passed');
        expect(tasks.map((t) => t.state)).toEqual(['approved']);
      } else {
        // An honest failure names its cause: never empty, never only an exit code.
        expect(why.length, 'a recorded reason').toBeGreaterThan(0);
        for (const r of why) expect(r).not.toMatch(/exited with code \d+$/);
      }
    },
    45 * 60_000,
  );

  it(
    'cancels a real Harness Run and leaves none of its processes behind',
    async () => {
      const { rt, repoId } = await realRuntime();
      const created = await createJob(rt, repoId, 'Add sum() to math.ts');
      // Triage is the first real Harness Run; cancel while it is in flight.
      await waitFor(() => factoryGroups(rt.home.dir).length > 0, 60_000, 'a Harness Run to start');
      const groups = factoryGroups(rt.home.dir);
      const res = await rt.home.cli(['job', 'cancel', created.id, '--reason', 'A7 cancel check']);
      expect(res.code, res.stderr).toBe(0);
      for (const g of groups)
        expect(groupAlive(g), `process group ${String(g)} is gone`).toBe(false);
      const job = await json<JobBody>(rt.request(`/v1/jobs/${created.id}`));
      expect(job.status).toBe('cancelled');
    },
    5 * 60_000,
  );
});
