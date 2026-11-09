/**
 * The Claude Code Harness adapter (#14), driven against a stand-in CLI
 * (`tests/support/claude-stub.mjs`, NOT Claude Code) that speaks its headless
 * stream-json protocol. Selecting it is runtime configuration only. What the
 * real CLI does is the `[real]` test's job (`pnpm test:real`).
 */
import { describe, expect, it } from 'vitest';
import {
  emptyHome,
  initializedHome,
  startRuntime,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createJob,
  json,
  registeredRepo,
  waitForJob,
  type EventBody,
  type JobBody,
} from '../support/api.js';
import { claudeStub, flagValues, useClaudeCode, type StubScenario } from '../support/claude.js';
import { killGroupsOnFinish, waitFor } from '../support/processes.js';

interface AttemptBody {
  id: string;
  state: string;
  exitReason: string | null;
  exitDetail: string | null;
  sessionRef: string | null;
  harness: { id: string; version: string | null };
  promptTemplate: { id: string; hash: string };
  usage: {
    tag: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    costTag?: string;
    durationMs: number;
  } | null;
}

interface ReviewBody {
  sessionRef: string | null;
  reviewer: { harnessId: string; version: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const settled = (job: JobBody) => job.status !== 'active';
/** A secret-named value in the runtime's environment; it must never reach the Harness. */
const API_KEY = 'sk-ant-api03-this-is-not-a-real-key-000000000000';

async function runtimeWith(
  scenario: StubScenario = {},
): Promise<{ rt: RunningRuntime; stub: ReturnType<typeof claudeStub>; repoId: string }> {
  const stub = claudeStub(scenario);
  const home = await initializedHome();
  useClaudeCode(home, stub.command);
  const rt = await startRuntime(home, { env: { ANTHROPIC_API_KEY: API_KEY } });
  killGroupsOnFinish(rt);
  const repo = await registeredRepo(rt);
  return { rt, stub, repoId: repo.id };
}

describe('the Claude Code Harness adapter', () => {
  it('runs every Role of a Job through the adapter, chosen by runtime configuration alone', async () => {
    const { rt, stub, repoId } = await runtimeWith();
    const created = await createJob(rt, repoId);
    const job = await waitForJob(rt, created.id, settled, 30_000);
    expect(job.status, rt.output()).toBe('completed');

    const status = await json<{ harness: { id: string; version: string; credentials: string } }>(
      rt.request('/v1/status'),
    );
    expect(status.harness).toMatchObject({
      id: 'claude-code',
      version: '9.8.7',
      credentials: 'present',
    });

    const runs = stub.invocations();
    expect(runs.map((r) => r.role)).toEqual([
      'triager',
      'researcher',
      'specifier',
      'planner',
      'developer',
      'reviewer',
    ]);
    for (const run of runs) {
      // Headless, structured, the prompt on stdin, no settings, MCP servers or skills loaded.
      expect(run.argv.slice(0, 4)).toEqual([
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
      ]);
      expect(run.promptOnArgv).toBe(false);
      expect(flagValues(run.argv, '--setting-sources')).toEqual(['']);
      expect(run.argv).toContain('--strict-mcp-config');
      expect(run.argv).toContain('--disable-slash-commands');
      expect(flagValues(run.argv, '--permission-mode')).toEqual(['dontAsk']);
      expect(flagValues(run.argv, '--permission-prompts')).toEqual(['none']);
      expect(flagValues(run.argv, '--session-id')[0]).toMatch(UUID);
      expect(flagValues(run.argv, '--max-turns')[0]).toMatch(/^\d+$/);
      // The guardrail env: no secret, whatever the runtime's environment holds.
      expect(run.env).not.toContain('ANTHROPIC_API_KEY');
      expect(run.env.filter((k) => /TOKEN|SECRET|KEY/.test(k))).toEqual([]);
      expect(flagValues(run.argv, '--disallowed-tools')).toEqual(
        expect.arrayContaining(['WebFetch', 'WebSearch']),
      );
    }
    // Tool flags derive from the Effective Configuration's policy per Role.
    const byRole = (role: string) => runs.find((r) => r.role === role)?.argv ?? [];
    expect(flagValues(byRole('planner'), '--tools')).toEqual(['Read,Glob,Grep']);
    expect(flagValues(byRole('developer'), '--tools')).toEqual(['Read,Glob,Grep,Edit,Write,Bash']);
    expect(flagValues(byRole('developer'), '--disallowed-tools')).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Bash(git reset --hard:*)']),
    );
    expect(flagValues(byRole('reviewer'), '--tools')).toEqual(['Read,Glob,Grep,Bash']);
    expect(flagValues(byRole('reviewer'), '--allowed-tools')).toContain('Bash(git diff:*)');
    expect(flagValues(byRole('reviewer'), '--allowed-tools')).not.toContain('Bash');
    expect(flagValues(byRole('reviewer'), '--disallowed-tools')).toEqual(
      expect.arrayContaining(['Edit', 'Write']),
    );
    const config = job.effectiveConfig as unknown as {
      toolPolicies: { source: string; value: Record<string, { allow: string[] }> };
    };
    expect(config.toolPolicies.source).toBe('recipe');
    expect(flagValues(byRole('developer'), '--allowed-tools')).toEqual(
      config.toolPolicies.value['developer']?.allow,
    );

    // The Attempt records the version, the Session, the template and honestly tagged usage.
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempt?.harness).toEqual({ id: 'claude-code', version: '9.8.7' });
    expect(attempt?.sessionRef).toBe(flagValues(byRole('developer'), '--session-id')[0]);
    expect(attempt?.promptTemplate.id).toBe('task-packet@3');
    expect(attempt?.promptTemplate.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attempt?.usage).toMatchObject({
      tag: 'actual',
      inputTokens: 15,
      outputTokens: 3,
      // The CLI's total_cost_usd is a list price, not what a subscription Harness Run cost.
      costUsd: null,
      costTag: 'unknown/subscription',
    });
    const [review] = await json<ReviewBody[]>(rt.request(`/v1/jobs/${job.id}/reviews`));
    expect(review?.reviewer).toEqual({ harnessId: 'claude-code', version: '9.8.7' });
    expect(review?.sessionRef).toBe(flagValues(byRole('reviewer'), '--session-id')[0]);
    expect(review?.sessionRef).not.toBe(attempt?.sessionRef);

    // Progress events were streamed and counted; `job show` shows the tags.
    const events = await json<EventBody[]>(rt.request(`/v1/jobs/${job.id}/events?limit=1000`));
    const finished = events.find(
      (e) => e.type === 'harness_run.finished' && e.payload['role'] === 'developer',
    );
    expect(finished?.payload['events']).toBeGreaterThan(0);
    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toContain('claude-code 9.8.7');
    expect(show.stdout).toContain('15 in / 3 out tokens (actual), cost unknown/subscription');
    expect(show.stdout).toContain(`session:   ${String(attempt?.sessionRef)}`);
  });

  it('records the reason the CLI gave when a Harness Run fails, not only its exit code', async () => {
    const { rt, repoId } = await runtimeWith({
      responses: {
        triager: [
          {
            error: {
              subtype: 'error_max_turns',
              errors: ['Reached maximum number of turns (30)'],
              exitCode: 1,
            },
          },
        ],
      },
    });
    const created = await createJob(rt, repoId);
    const job = await waitForJob(rt, created.id, settled, 20_000);
    expect(job.status).toBe('failed');
    const triage = job.stageRuns.find((s) => s.stageId === 'triage');
    expect(triage?.failure?.reason).toBe('harness_failed');
    expect(triage?.failure?.message).toBe(
      'the triage Harness Run exited with code 1: Claude Code reported error_max_turns: Reached maximum number of turns (30)',
    );
  });

  it('fails a developer Harness Run that ends without a result event, with that reason on the Attempt', async () => {
    const { rt, repoId } = await runtimeWith({
      responses: {
        developer: [{ error: { subtype: 'error_during_execution', errors: [], exitCode: 0 } }],
      },
    });
    const created = await createJob(rt, repoId);
    const job = await waitForJob(rt, created.id, settled, 30_000);
    expect(job.status).toBe('failed');
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    // Exit 0 with is_error is no success: the adapter reports the Harness Run failed.
    expect(attempt?.exitReason).toBe('harness_failed');
    expect(attempt?.exitDetail).toBe(
      'the claude-code Harness Run exited with code 1: Claude Code reported error_during_execution',
    );
  });

  it('cancels a running Harness Run without leaving any of its processes behind', async () => {
    const { rt, stub, repoId } = await runtimeWith({ responses: { developer: [{ hang: true }] } });
    const created = await createJob(rt, repoId);
    await waitFor(
      () => stub.invocations().some((r) => r.role === 'developer' && r.child !== undefined),
      30_000,
      'the developer Harness Run to start its child process',
    );
    const run = stub.invocations().find((r) => r.role === 'developer');
    const pids = [run?.pid, run?.child].filter((p): p is number => p !== undefined);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid)).toBe(true);

    const res = await rt.home.cli(['job', 'cancel', created.id, '--reason', 'stop it']);
    expect(res.code, res.stderr).toBe(0);
    for (const pid of pids) expect(alive(pid), `process ${String(pid)} is gone`).toBe(false);
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${created.id}/attempts`));
    expect(attempt?.state).toBe('cancelled');
  });
});

describe('Claude Code flag verification (detect, shared with factory doctor)', () => {
  it('refuses to start a runtime configured for a Claude Code that lacks a flag the adapter passes', async () => {
    const stub = claudeStub({ helpOmits: ['--permission-prompts'] });
    const home = await initializedHome();
    useClaudeCode(home, stub.command);
    await expect(startRuntime(home)).rejects.toThrow(
      /harness 'claude-code' 9\.8\.7 can't be used: Claude Code 9\.8\.7 does not list --permission-prompts in --help/,
    );
    expect(stub.invocations()).toEqual([]);
  });

  it('reports the missing flag, the unverifiable one and the login in factory doctor', async () => {
    const stub = claudeStub({ helpOmits: ['--tools'], loggedIn: false });
    const home = emptyHome();
    const init = await home.cli(['init', '--workspace-root', home.workspaceRoot]);
    expect(init.code, init.stderr).toBe(0);
    const rt = await startRuntime(home, {
      env: { PATH: `${stub.dir}:${String(process.env['PATH'])}` },
    });
    const res = await rt.home.cli(['doctor', '--json'], {
      env: { PATH: `${stub.dir}:${String(process.env['PATH'])}` },
    });
    expect(res.code, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout) as {
      tools: { id: string; status: string; version?: string; fix?: string; notes?: string[] }[];
      credentials: { id: string; present: boolean }[];
    };
    const claude = report.tools.find((t) => t.id === 'claude');
    expect(claude).toMatchObject({ status: 'failed', version: '9.8.7' });
    expect(claude?.fix).toContain('does not list --tools in --help');
    expect(claude?.notes?.[0]).toContain('--max-turns not listed in --help');
    expect(report.credentials.find((c) => c.id === 'claude_login')).toEqual(
      expect.objectContaining({ present: false }),
    );
    const text = await rt.home.cli(['doctor'], {
      env: { PATH: `${stub.dir}:${String(process.env['PATH'])}` },
    });
    expect(text.stdout).toContain('failed   Claude Code');
    expect(text.stdout).toContain('absent   Claude Code login (claude auth status)');
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
