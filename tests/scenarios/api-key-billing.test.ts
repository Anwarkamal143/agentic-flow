/**
 * API-key billing for the Claude Code Harness (human decision 2026-11-09,
 * option (b)): a named permission expansion, off by default. Under
 * `billing: "api_key"`, `ANTHROPIC_API_KEY` reaches Claude Code Harness Runs
 * (and so everything they run) and nothing else; the cost is a tagged
 * estimate; the key never reaches the factory's history. Driven against the
 * stand-in CLI (`tests/support/claude-stub.mjs`, NOT Claude Code).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initializedHome, startRuntime, type RunningRuntime } from '../support/factory.js';
import { createJob, json, registeredRepo, waitForJob, type JobBody } from '../support/api.js';
import {
  claudeStub,
  useClaudeCode,
  validResponses,
  type ClaudeStub,
  type StubScenario,
} from '../support/claude.js';
import { startDashboard } from '../support/dashboard.js';
import { filesUnder } from '../support/files.js';
import { killGroupsOnFinish } from '../support/processes.js';

/** A key-shaped value that matches the Anthropic key pattern and the `*_API_KEY` name. */
const API_KEY = 'sk-ant-api03-billing-test-key-not-real-0000000000000000';
const EXPOSURE = 'visible to the Harness and every command it runs';

interface UsageBody {
  tag: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costTag?: string;
  billing?: string;
}
interface AttemptBody {
  id: string;
  usage: UsageBody | null;
}

async function runtimeWith(
  opts: {
    billing?: 'subscription' | 'api_key';
    prices?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    scenario?: StubScenario;
  } = {},
): Promise<{ rt: RunningRuntime; stub: ClaudeStub }> {
  const stub = claudeStub(opts.scenario);
  const home = await initializedHome();
  useClaudeCode(home, stub.command, {
    ...(opts.billing === undefined ? {} : { billing: opts.billing }),
    ...(opts.prices === undefined ? {} : { prices: opts.prices }),
  });
  const rt = await startRuntime(home, { env: opts.env ?? { ANTHROPIC_API_KEY: API_KEY } });
  killGroupsOnFinish(rt);
  return { rt, stub };
}

async function completedJob(rt: RunningRuntime): Promise<JobBody> {
  const repo = await registeredRepo(rt);
  const created = await createJob(rt, repo.id);
  const job = await waitForJob(rt, created.id, (j) => j.status !== 'active', 30_000);
  expect(job.status, rt.output()).toBe('completed');
  return job;
}

/** The planner's Task also runs a required check that fails when the key is in its env. */
function keyAbsentFromVerification(): Record<string, unknown[]> {
  const planner = structuredClone(validResponses()['planner']) as {
    output: { tasks: { verification: unknown[] }[] };
  }[];
  planner[0]?.output.tasks[0]?.verification.push({
    key: 'no-api-key',
    command: 'test -z "${ANTHROPIC_API_KEY:-}"',
    required: true,
  });
  return { planner };
}

describe('API-key billing for Claude Code', () => {
  it('passes ANTHROPIC_API_KEY to every Claude Code Harness Run, and to no verification command', async () => {
    const { rt, stub } = await runtimeWith({
      billing: 'api_key',
      scenario: { responses: keyAbsentFromVerification() },
    });
    const job = await completedJob(rt);

    const runs = stub.invocations();
    expect(runs.map((r) => r.role)).toEqual(
      expect.arrayContaining(['triager', 'planner', 'developer', 'reviewer']),
    );
    for (const run of runs) expect(run.env, run.role).toContain('ANTHROPIC_API_KEY');
    // The factory's own verification ran without it (else the required `no-api-key` check fails).
    const [attempt] = await json<
      { evidence: { verificationKey: string | null; verdict: string }[] }[]
    >(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempt?.evidence.find((e) => e.verificationKey === 'no-api-key')?.verdict).toBe('pass');
  });

  it('records an estimated cost billed to the API key at the list price', async () => {
    const { rt } = await runtimeWith({ billing: 'api_key' });
    const job = await completedJob(rt);
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    // The developer Harness Run's list-price cost, as the CLI reported it.
    expect(attempt?.usage).toMatchObject({
      tag: 'actual',
      inputTokens: 15,
      outputTokens: 3,
      costUsd: 0.42,
      costTag: 'estimated',
      billing: 'api_key',
    });
  });

  it('records an estimated cost billed to the API key from the configured price table', async () => {
    const priced = await runtimeWith({
      billing: 'api_key',
      prices: {
        'claude-stub-model': {
          inputUsdPerMTok: 1_000_000,
          outputUsdPerMTok: 0,
          cacheReadUsdPerMTok: 0,
          cacheWriteUsdPerMTok: 0,
        },
      },
    });
    const pricedJob = await completedJob(priced.rt);
    const [pricedAttempt] = await json<AttemptBody[]>(
      priced.rt.request(`/v1/jobs/${pricedJob.id}/attempts`),
    );
    // 10 uncached input tokens at $1 each (cache reads are priced separately, here at 0).
    expect(pricedAttempt?.usage).toMatchObject({ costUsd: 10, costTag: 'estimated' });
  });

  it('says plainly who can see the key: status, doctor, job show and the dashboard', async () => {
    const { rt } = await runtimeWith({ billing: 'api_key' });
    const job = await completedJob(rt);

    const doctor = await rt.home.cli(['doctor']);
    expect(doctor.stdout).toContain(
      'Billing: Claude Code is billed to an API key (ANTHROPIC_API_KEY, present)',
    );
    expect(doctor.stdout).toContain(EXPOSURE);
    expect(doctor.stdout).toContain('Tier 0 guardrail, not isolation');

    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toContain('cost $0.4200 (estimated), billed to an API key');
    expect(show.stdout).toContain(EXPOSURE);

    const dash = await startDashboard(rt.home);
    const page = (await dash.html(`/jobs/${job.id}`)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(page).toContain('$0.4200 (estimated)');
    expect(page).toContain(`billed to an API key, ${EXPOSURE}`);
  });

  it('never stores, streams or logs the key, even when the Harness prints it', async () => {
    const developer = structuredClone(validResponses()['developer']) as Record<string, unknown>[];
    if (developer[0] !== undefined) developer[0]['printEnv'] = ['ANTHROPIC_API_KEY'];
    const { rt } = await runtimeWith({
      billing: 'api_key',
      scenario: { responses: { developer } },
    });
    const job = await completedJob(rt);

    const logs = await rt.request(`/v1/jobs/${job.id}/logs`).then((r) => r.text());
    expect(logs).toContain('ANTHROPIC_API_KEY=[REDACTED:ANTHROPIC_API_KEY]');
    for (const path of ['logs', 'events?limit=1000', 'attempts', 'reviews', 'artifacts']) {
      const body = await rt.request(`/v1/jobs/${job.id}/${path}`).then((r) => r.text());
      expect(body, path).not.toContain(API_KEY);
    }
    expect(rt.output()).not.toContain(API_KEY);
    const show = await rt.home.cli(['logs', job.id]);
    expect(show.stdout).not.toContain(API_KEY);
    for (const file of filesUnder(rt.home.dir)) {
      expect(readFileSync(file).includes(API_KEY), file).toBe(false);
    }
  });

  it('tags the cost by what the Harness Run was billed to, and still warns that the key was passed', async () => {
    // The CLI reports paying with its login, although the factory passed the key.
    const { rt } = await runtimeWith({ billing: 'api_key', scenario: { apiKeySource: 'none' } });
    const job = await completedJob(rt);
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempt?.usage).toMatchObject({
      costUsd: null,
      costTag: 'unknown/subscription',
      billing: 'api_key',
    });
    const show = await rt.home.cli(['job', 'show', job.id]);
    expect(show.stdout).toContain(`cost unknown/subscription, billed to an API key, ${EXPOSURE}`);
  });

  it('refuses to start under api_key billing without ANTHROPIC_API_KEY', async () => {
    const stub = claudeStub();
    const home = await initializedHome();
    useClaudeCode(home, stub.command, { billing: 'api_key' });
    await expect(startRuntime(home, { env: { ANTHROPIC_API_KEY: '' } })).rejects.toThrow(
      /billing 'api_key' needs ANTHROPIC_API_KEY in the runtime's environment/,
    );
  });

  it('keeps the default: subscription billing, the key stripped, the cost unknown/subscription', async () => {
    const { rt, stub } = await runtimeWith();
    const job = await completedJob(rt);
    for (const run of stub.invocations())
      expect(run.env, run.role).not.toContain('ANTHROPIC_API_KEY');
    const [attempt] = await json<AttemptBody[]>(rt.request(`/v1/jobs/${job.id}/attempts`));
    expect(attempt?.usage).toMatchObject({
      costTag: 'unknown/subscription',
      billing: 'subscription',
    });
    const doctor = await rt.home.cli(['doctor']);
    expect(doctor.stdout).toContain('Billing: Claude Code is billed to your subscription login');
    expect(doctor.stdout).not.toContain(EXPOSURE);
    expect((await rt.home.cli(['status'])).stdout).toContain(
      'billing:        your subscription login',
    );
  });
});
