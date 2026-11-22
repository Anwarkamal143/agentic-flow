/**
 * Verification by Repository Profile command name (#102, ADR-0051, the expand
 * step): a Plan's verification entry names a profile command, with arguments
 * only when the command accepts them; the factory runs it from the Job's
 * frozen per-Repository section and its Evidence names the command and the
 * arguments. Free shell entries still run. The Task Packet gives the
 * developer the Repository's instruction files as context, and the planner's
 * prompt lists each Repository's profile commands and Sensitive Paths.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  git,
  initializedHome,
  startRuntime,
  tinyTsRepo,
  useFakeHarness,
  type RunningRuntime,
} from '../support/factory.js';
import {
  createJob,
  createProject,
  declareCommands,
  jobSettled,
  json,
  onlyAttempt,
  registeredRepo,
  skipPlanApproval,
  waitForJob,
} from '../support/api.js';
import { FIXTURE_COMMANDS, scriptWith, validOutput } from '../support/scripts.js';
import { claudeStub, useClaudeCode } from '../support/claude.js';
import { killGroupsOnFinish } from '../support/processes.js';

interface AttemptBody {
  state: string;
  promptTemplate: { id: string };
  packet: {
    packetVersion: number;
    verification: { key: string; command: string; args?: string[]; run: string }[];
    context: { instructionFiles: string[] };
  };
  verificationRuns: {
    key: string;
    command: string;
    exitCode: number | null;
    profileCommand: { name: string; args: string[] } | null;
  }[];
}

/** The valid Plan with its one Task's verification replaced. */
function planVerifying(verification: Record<string, unknown>[]) {
  const plan = validOutput('planning') as { tasks: Record<string, unknown>[] };
  (plan.tasks[0] as Record<string, unknown>)['verification'] = verification;
  return plan;
}

async function profileSet(rt: RunningRuntime, key: string, value: string): Promise<void> {
  const res = await rt.home.cli(['repo', 'profile', 'set', 'tiny-ts', key, value]);
  expect(res.code, res.stderr).toBe(0);
}

describe('verification by profile command name', () => {
  it('runs the named command from the frozen profile with its arguments, and the Evidence names them', async () => {
    const home = await initializedHome();
    useFakeHarness(
      home,
      scriptWith({
        planning: [
          {
            output: planVerifying([
              { key: 'test', command: 'has-sum', args: ['src/math.ts'], criteria: ['AC-01'] },
              { key: 'typecheck', command: 'test -f src/math.ts && echo typecheck ok' },
            ]),
          },
        ],
      }),
    );
    const rt = await startRuntime(home);
    const repo = await registeredRepo(rt);
    await profileSet(rt, 'commands.has-sum', "grep -q 'export function sum'");
    await profileSet(rt, 'commands.has-sum.acceptsArgs', 'true');

    const created = await createJob(rt, repo.id);
    // A profile change after creation never reaches the Job: it runs what it froze.
    await profileSet(rt, 'commands.has-sum', 'false');
    const job = await waitForJob(rt, created.id, jobSettled, 20_000);

    expect(job.status, rt.output()).toBe('completed');
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt.packet.verification).toEqual([
      {
        key: 'test',
        command: 'has-sum',
        args: ['src/math.ts'],
        run: "grep -q 'export function sum' 'src/math.ts'",
        required: true,
      },
      {
        key: 'typecheck',
        command: 'test -f src/math.ts && echo typecheck ok',
        run: 'test -f src/math.ts && echo typecheck ok',
        required: true,
      },
    ]);
    expect(
      attempt.verificationRuns.map((r) => [r.key, r.command, r.profileCommand, r.exitCode]),
    ).toEqual([
      [
        'test',
        "grep -q 'export function sum' 'src/math.ts'",
        { name: 'has-sum', args: ['src/math.ts'] },
        0,
      ],
      ['typecheck', 'test -f src/math.ts && echo typecheck ok', null, 0],
    ]);
    const shown = await rt.home.cli(['job', 'show', job.id]);
    expect(shown.stdout).toContain('test: has-sum src/math.ts');
    expect(shown.stdout).toMatch(/test\s+pass\s+exit 0 {2}profile command has-sum src\/math\.ts/);
  });

  it('re-prompts a Plan that passes arguments to a command that does not accept them', async () => {
    const home = await initializedHome();
    useFakeHarness(
      home,
      scriptWith({
        planning: [
          {
            output: planVerifying([
              { key: 'test', command: 'test', args: ['src/math.ts'], criteria: ['AC-01'] },
            ]),
          },
          { output: validOutput('planning') },
        ],
      }),
    );
    const rt = await startRuntime(home);
    const repo = await registeredRepo(rt);

    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, jobSettled, 20_000);

    expect(job.status).toBe('completed');
    const events = await json<{ type: string; payload: Record<string, unknown> }[]>(
      rt.request(`/v1/jobs/${job.id}/events`),
    );
    const reprompt = events.find(
      (e) =>
        e.type === 'harness_run.started' &&
        e.payload['stageId'] === 'planning' &&
        e.payload['reprompt'] !== undefined,
    )?.payload['reprompt'];
    expect(reprompt).toEqual({
      issues: [
        {
          rule: 'plan.verification_args',
          message:
            "Task add-sum: verification test: profile command 'test' of Repository tiny-ts does not accept arguments (a human marks it acceptsArgs in the Repository Profile)",
        },
      ],
    });
  });
});

describe('the Repository Profile as agent context', () => {
  it('gives the developer the instruction files and tells the planner the commands and Sensitive Paths', async () => {
    const stub = claudeStub();
    const home = await initializedHome();
    useClaudeCode(home, stub.command);
    const rt = await startRuntime(home);
    killGroupsOnFinish(rt);
    await createProject(rt, 'demo');
    const checkout = tinyTsRepo();
    writeFileSync(join(checkout, 'CLAUDE.md'), '# Rules\n');
    mkdirSync(join(checkout, 'docs'));
    writeFileSync(join(checkout, 'docs', 'AGENTS.md'), 'be careful\n');
    git(checkout, ['add', '--all']);
    git(checkout, ['commit', '--quiet', '--no-gpg-sign', '-m', 'add instructions']);
    const added = await rt.home.cli(['repo', 'add', checkout, '--project', 'demo', '--yes']);
    expect(added.code, added.stderr).toBe(0);
    const [repo] = await json<[{ id: string; projectId: string }]>(rt.request('/v1/repositories'));
    await skipPlanApproval(rt, repo.projectId);
    // The two fixture commands the stub's Plan verifies with (ADR-0063).
    const { 'has-sum': hasSum, 'math-exists': mathExists } = FIXTURE_COMMANDS;
    if (hasSum === undefined || mathExists === undefined) throw new Error('no fixture commands');
    await declareCommands(rt, repo.id, { 'has-sum': hasSum, 'math-exists': mathExists });
    await profileSet(rt, 'commands.test.acceptsArgs', 'true');

    const created = await createJob(rt, repo.id);
    const job = await waitForJob(rt, created.id, jobSettled, 30_000);

    expect(job.status, rt.output()).toBe('completed');
    const attempt = await onlyAttempt<AttemptBody>(rt, job.id);
    expect(attempt.promptTemplate.id).toBe('task-packet@7');
    expect(attempt.packet.packetVersion).toBe(2);
    expect(attempt.packet.context.instructionFiles).toEqual(['CLAUDE.md', 'docs/AGENTS.md']);
    const developer = stub.invocations().find((r) => r.role === 'developer')?.prompt ?? '';
    expect(developer).toContain('context.instructionFiles');

    const planner = stub.invocations().find((r) => r.role === 'planner')?.prompt ?? '';
    expect(planner).toContain(
      'Repository tiny-ts:\n' +
        "  profile commands: has-sum (grep -q 'export function sum' src/math.ts), " +
        'math-exists (test -f src/math.ts && echo typecheck ok), ' +
        'test (npm test; accepts arguments), typecheck (npm run typecheck)\n' +
        '  Sensitive Paths (forbidden for every Task): .env*, **/.env*, .github/workflows/**, infra/**, **/*.pem, **/*.key, CLAUDE.md, docs/AGENTS.md',
    );
    // Only the planner is told the profile.
    const triager = stub.invocations().find((r) => r.role === 'triager')?.prompt ?? '';
    expect(triager).not.toContain('profile commands');
  });
});
