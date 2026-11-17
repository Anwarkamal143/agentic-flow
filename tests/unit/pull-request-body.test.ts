/**
 * The pull request body (#57, C1, ADR-0036): rendered by plain code from
 * persisted state, never by an LLM. Every section is present, the rollback
 * notes never invent a rollback, the text is redacted before it is sent, and
 * the hidden factory marker is there for recovery and the poller.
 */
import {
  createRedactor,
  emptyDeliveryNote,
  hasFactoryMarker,
  pullRequestMarker,
  renderPullRequestBody,
  type PullRequestBodyInput,
} from '@factory/domain';
import { describe, expect, it } from 'vitest';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';

function input(overrides: Partial<PullRequestBodyInput> = {}): PullRequestBodyInput {
  return {
    jobId: 'job_01',
    title: 'Add sum()',
    spec: {
      problem: 'There is no way to sum two numbers.',
      objective: 'Export sum(a, b) from src/math.ts.',
    },
    branch: 'factory/job_01/integration',
    headSha: HEAD,
    baseSha: BASE,
    merged: [{ key: 'add-sum', branch: 'factory/job_01/tsk_1-add-sum' }],
    criteria: [
      {
        code: 'AC-01',
        text: 'sum(2, 3) returns 5.',
        mandatory: true,
        verdict: 'pass',
        detail: 'command test: pass (exit 0)',
      },
      {
        code: 'AC-02',
        text: 'sum is documented.',
        mandatory: false,
        verdict: 'not_tested',
        detail: 'no Evidence',
      },
    ],
    commands: [
      {
        key: 'test',
        command: "grep -q 'export function sum' src/math.ts",
        exitCode: 0,
        verdict: 'pass',
      },
      { key: 'typecheck', command: 'tsc --noEmit', exitCode: 1, verdict: 'fail' },
    ],
    risks: {
      overall: 'medium',
      tasks: [
        { key: 'add-sum', risk: 'low' },
        { key: 'docs', risk: 'medium' },
      ],
      securityConsiderations: ['No user input reaches eval.'],
    },
    findings: [
      {
        task: 'add-sum',
        severity: 'low',
        location: 'src/math.ts:6',
        problem: 'No test covers negative numbers.',
      },
    ],
    questions: [{ task: 'add-sum', text: 'Should sum accept bigint?' }],
    rollback: null,
    ci: null,
    foreignCommits: [],
    droppedCommits: [],
    changedFiles: 2,
    ...overrides,
  };
}

const identity = (text: string) => text;

describe('renderPullRequestBody', () => {
  it('has every section, from the persisted inputs', () => {
    const body = renderPullRequestBody(input(), identity);

    expect(body).toContain('## Summary');
    expect(body).toContain('There is no way to sum two numbers.');
    expect(body).toContain('Export sum(a, b) from src/math.ts.');

    expect(body).toContain('## Acceptance Criteria');
    expect(body).toMatch(/AC-01.*mandatory.*pass/);
    expect(body).toContain('command test: pass (exit 0)');
    expect(body).toMatch(/AC-02.*optional.*not_tested/);

    expect(body).toContain('## Commands run on the integration head');
    expect(body).toContain(HEAD);
    expect(body).toContain("grep -q 'export function sum' src/math.ts");
    expect(body).toMatch(/typecheck.*exit 1.*fail/);

    expect(body).toContain('## Risks');
    expect(body).toMatch(/Overall: medium/);
    expect(body).toMatch(/docs.*medium/);
    expect(body).toContain('No user input reaches eval.');

    expect(body).toContain('## Open non-blocking Findings');
    expect(body).toContain('src/math.ts:6');
    expect(body).toContain('No test covers negative numbers.');

    expect(body).toContain('## Open Questions');
    expect(body).toContain('Should sum accept bigint?');

    expect(body).toContain('## Rollback');
    expect(body).toContain('factory/job_01/tsk_1-add-sum');
  });

  it('says the CI checks were not read yet before the first poll', () => {
    const body = renderPullRequestBody(input(), identity);
    expect(body).toContain('## CI checks');
    expect(body).toContain('Not read from GitHub yet');
  });

  it('shows the Merge Gate checks condition and each check with its link once polled', () => {
    const body = renderPullRequestBody(
      input({
        ci: {
          status: 'fail',
          reason: 'failed: test',
          checks: [
            { name: 'build', outcome: 'success', url: 'https://ci.example/1' },
            { name: 'test', outcome: 'failure', url: null },
          ],
        },
      }),
      identity,
    );
    expect(body).toContain('**fail**: failed: test');
    expect(body).toContain('`build`: success ([details](https://ci.example/1))');
    expect(body).toContain('`test`: failure');
  });

  it('says "no checks reported" when the grace window passed with none', () => {
    const body = renderPullRequestBody(
      input({
        ci: {
          status: 'pass',
          reason: 'no checks reported on 111111111111 within 120 s of the push',
          checks: [],
        },
      }),
      identity,
    );
    expect(body).toMatch(/## CI checks\n\nOn `1{40}`: \*\*pass\*\*: no checks reported/);
  });

  it('says "none supported" for the rollback when the Plan states none', () => {
    const body = renderPullRequestBody(input({ rollback: null }), identity);
    expect(body).toMatch(/## Rollback\n\nNone supported\./);
  });

  it("shows the Plan's rollback when it states one, and never invents another", () => {
    const body = renderPullRequestBody(
      input({ rollback: 'Revert the merge commit; no data migration.' }),
      identity,
    );
    expect(body).toContain('Revert the merge commit; no data migration.');
    expect(body).not.toMatch(/None supported/);
  });

  it('says so when there are no Findings or Questions, rather than leaving a section out', () => {
    const body = renderPullRequestBody(input({ findings: [], questions: [] }), identity);
    expect(body).toMatch(/## Open non-blocking Findings\n\nNone\./);
    expect(body).toMatch(/## Open Questions\n\nNone\./);
  });

  it('lists the foreign commits as foreign, their untrusted text unable to format or mention (#63)', () => {
    const body = renderPullRequestBody(
      input({
        foreignCommits: [
          {
            sha: '3333333333333333333333333333333333333333',
            subject: 'Fix it @alice\n## Merge now',
            author: 'Bob',
          },
        ],
      }),
      identity,
    );
    expect(body).toMatch(
      /## Foreign commits\n\nPushed to `factory\/job_01\/integration` by someone other than the factory/,
    );
    expect(body).toContain(
      '- `3333333333333333333333333333333333333333` by `Bob`: `Fix it @alice ## Merge now`',
    );
    expect(body).not.toMatch(/^## Merge now/m);
  });

  it('lists the approved commits an adopted rewrite dropped, apart from the foreign ones (ADR-0042)', () => {
    const body = renderPullRequestBody(
      input({
        foreignCommits: [{ sha: '4'.repeat(40), subject: 'Rewrite', author: 'Eve' }],
        droppedCommits: [{ sha: HEAD, subject: 'Write src/math.ts', author: 'Software Factory' }],
      }),
      identity,
    );
    expect(body).toMatch(
      /Dropped by a rewrite a human approved: these approved commits are no longer on `factory\/job_01\/integration`\.\n\n- `1{40}` by `Software Factory`: `Write src\/math\.ts`/,
    );
  });

  it("says there are no foreign commits when every commit is the factory's own", () => {
    const body = renderPullRequestBody(input(), identity);
    expect(body).toMatch(/## Foreign commits\n\nNone\./);
  });

  it('flags an empty delivery at the top, before the summary, and still renders every section', () => {
    const body = renderPullRequestBody(input({ changedFiles: 0 }), identity);
    const flag = body.indexOf('## No changes');
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(body.indexOf('## Summary'));
    expect(body).toContain(`**${emptyDeliveryNote(HEAD, BASE)}**`);
    expect(body).toContain(`head ${HEAD} has the same files as base ${BASE}`);
    expect(body).toContain('## Acceptance Criteria');
    expect(hasFactoryMarker(body, 'job_01')).toBe(true);
  });

  it('has no flag when the head changes files, or when the count is unknown', () => {
    expect(renderPullRequestBody(input(), identity)).not.toContain('## No changes');
    expect(renderPullRequestBody(input({ changedFiles: null }), identity)).not.toContain(
      '## No changes',
    );
  });

  it('redacts every section, the marker kept', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const redact = createRedactor([{ name: 'GH_TOKEN', value: secret }]);
    const body = renderPullRequestBody(
      input({
        spec: { problem: `token ${secret} leaked`, objective: 'x' },
        findings: [{ task: 'a', severity: 'low', location: 'a.ts:1', problem: secret }],
        questions: [{ task: 'a', text: secret }],
        commands: [{ key: 'test', command: `echo ${secret}`, exitCode: 0, verdict: 'pass' }],
      }),
      redact,
    );
    expect(body).not.toContain(secret);
    expect(body).toContain('[REDACTED');
    expect(hasFactoryMarker(body, 'job_01')).toBe(true);
  });

  it('carries the hidden factory marker of its Job', () => {
    const body = renderPullRequestBody(input(), identity);
    expect(body).toContain(pullRequestMarker('job_01'));
    expect(pullRequestMarker('job_01')).toBe('<!-- factory:job_01:pull_request -->');
    expect(hasFactoryMarker(body, 'job_01')).toBe(true);
    expect(hasFactoryMarker(body, 'job_02')).toBe(false);
    expect(hasFactoryMarker('A PR someone else opened.', 'job_01')).toBe(false);
    expect(hasFactoryMarker(null, 'job_01')).toBe(false);
  });
});
