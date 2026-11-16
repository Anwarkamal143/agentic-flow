/**
 * The C7 sandbox's setup and cleanup (#67), against the fake GitHub over real
 * HTTP with no database: the same client `tests/real/c7-github.test.ts` runs
 * against `Anwarkamal143/factory-sandbox`. It seeds an empty sandbox once,
 * and between runs closes only PRs the factory opened and deletes only
 * `factory/*` branches, of that repository only.
 *
 * Passing here is evidence about which PRs and branches the client selects,
 * not about the real GitHub.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, tempDir, tinyTsRepo } from '../support/factory.js';
import { fakeGitHub, type FakeGitHub } from '../support/github.js';
import {
  prepareSandbox,
  SANDBOX_CHECK,
  SANDBOX_RERUN_CHECK,
  SANDBOX_WORKFLOW_PATH,
} from '../support/sandbox.js';

const SANDBOX = 'acme/sandbox';
const OTHER = 'acme/other';
const TOKEN = 'fake-gh-token-sandbox';

async function openPr(gh: FakeGitHub, fullName: string, head: string, body: string) {
  const res = await fetch(`${gh.url}/repos/${fullName}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: head, body, head, base: 'main' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

function prepare(gh: FakeGitHub) {
  return prepareSandbox({
    fullName: SANDBOX,
    apiBaseUrl: gh.url,
    token: () => TOKEN,
    gitEnv: gh.gitEnv(),
    workDir: tempDir('sandbox-work-'),
  });
}

const stateOf = (gh: FakeGitHub, fullName: string, head: string) =>
  gh.pullRequests(fullName).find((p) => p.head === head)?.state;

describe('the C7 sandbox setup', () => {
  it('seeds an empty sandbox with tiny-ts and a CI workflow on main, once', async () => {
    const gh = await fakeGitHub();
    gh.addRepository(SANDBOX);

    const first = await prepare(gh);
    expect(first.seeded).toBe(true);
    const main = gh.branchHead(SANDBOX, 'main');
    expect(main).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(first.checkout, 'src/math.ts'))).toBe(true);
    expect(existsSync(join(first.checkout, SANDBOX_WORKFLOW_PATH))).toBe(true);
    expect(git(first.checkout, ['remote', 'get-url', 'origin']).trim()).toBe(
      `https://github.com/${SANDBOX}.git`,
    );

    const second = await prepare(gh);
    expect(second.seeded).toBe(false);
    expect(gh.branchHead(SANDBOX, 'main'), 'never re-seeded').toBe(main);
  });

  it('refuses a sandbox whose main has no CI workflow, changing nothing', async () => {
    const gh = await fakeGitHub();
    gh.addRepository(SANDBOX, tinyTsRepo());
    const main = gh.branchHead(SANDBOX, 'main');
    await expect(prepare(gh)).rejects.toThrow(/precondition: .*\.github\/workflows\/ci\.yml/);
    expect(gh.branchHead(SANDBOX, 'main')).toBe(main);
  });

  it('brings a workflow it seeded earlier up to date on main with a fast-forward commit, once (#77)', async () => {
    const gh = await fakeGitHub();
    gh.addRepository(SANDBOX, tinyTsRepo());
    gh.pushForeignCommit(SANDBOX, 'main', {
      [SANDBOX_WORKFLOW_PATH]:
        "# Seeded by the Software Factory's C7 [real] test (tests/support/sandbox.ts).\nname: ci\n",
    });
    const old = gh.branchHead(SANDBOX, 'main') ?? '';

    const first = await prepare(gh);
    expect(first.workflowUpdated).toBe(true);
    const main = gh.branchHead(SANDBOX, 'main') ?? '';
    expect(main).not.toBe(old);
    expect(git(first.checkout, ['rev-parse', 'HEAD']).trim()).toBe(main);
    expect(git(first.checkout, ['rev-parse', `${main}^`]).trim()).toBe(old);
    const workflow = readFileSync(join(first.checkout, SANDBOX_WORKFLOW_PATH), 'utf8');
    expect(workflow).toContain(`${SANDBOX_RERUN_CHECK}:`);
    expect(workflow).toContain(`${SANDBOX_CHECK}:`);

    const second = await prepare(gh);
    expect(second.workflowUpdated).toBe(false);
    expect(gh.branchHead(SANDBOX, 'main')).toBe(main);
  });

  it("refuses a sandbox whose workflow it didn't seed, changing nothing", async () => {
    const gh = await fakeGitHub();
    gh.addRepository(SANDBOX, tinyTsRepo());
    gh.pushForeignCommit(SANDBOX, 'main', { [SANDBOX_WORKFLOW_PATH]: 'name: theirs\n' });
    const main = gh.branchHead(SANDBOX, 'main');
    await expect(prepare(gh)).rejects.toThrow(/precondition: .*not one these tests seeded/);
    expect(gh.branchHead(SANDBOX, 'main')).toBe(main);
  });

  it('closes only marked factory PRs and deletes only factory/* branches, of the sandbox only', async () => {
    const gh = await fakeGitHub();
    gh.addRepository(SANDBOX);
    gh.addRepository(OTHER, tinyTsRepo());
    await prepare(gh);

    const marked = '<!-- factory:job_1:pull_request -->';
    for (const b of ['factory/job_1/integration', 'factory/job_2/integration', 'factory/old/t-x'])
      gh.pushForeignCommit(SANDBOX, b, { [`${b.replaceAll('/', '-')}.txt`]: 'x\n' });
    gh.pushForeignCommit(SANDBOX, 'feature/mine', { 'mine.txt': 'x\n' });
    gh.pushForeignCommit(SANDBOX, 'mine-marked', { 'mm.txt': 'x\n' });
    gh.pushForeignCommit(OTHER, 'factory/job_9/integration', { 'o.txt': 'x\n' });
    await openPr(gh, SANDBOX, 'factory/job_1/integration', `Body\n${marked}`);
    await openPr(gh, SANDBOX, 'factory/job_2/integration', 'Opened by hand, no marker.');
    await openPr(gh, SANDBOX, 'feature/mine', 'Mine.');
    await openPr(gh, SANDBOX, 'mine-marked', `Quotes a marker ${marked}`);
    await openPr(gh, OTHER, 'factory/job_9/integration', `Body\n${marked}`);
    const before = gh.requests.length;

    const { cleaned } = await prepare(gh);

    expect(cleaned.closed).toEqual([1]);
    expect(cleaned.deleted.sort()).toEqual(['factory/job_1/integration', 'factory/old/t-x']);
    expect(stateOf(gh, SANDBOX, 'factory/job_1/integration')).toBe('closed');
    expect(gh.branchHead(SANDBOX, 'factory/job_1/integration')).toBeUndefined();
    expect(gh.branchHead(SANDBOX, 'factory/old/t-x')).toBeUndefined();
    // An unmarked PR is someone else's: open, and its factory/* branch kept.
    expect(stateOf(gh, SANDBOX, 'factory/job_2/integration')).toBe('open');
    expect(gh.branchHead(SANDBOX, 'factory/job_2/integration')).toBeDefined();
    // A marker on a branch outside factory/* is not the factory's PR.
    expect(stateOf(gh, SANDBOX, 'feature/mine')).toBe('open');
    expect(stateOf(gh, SANDBOX, 'mine-marked')).toBe('open');
    expect(gh.branchHead(SANDBOX, 'feature/mine')).toBeDefined();
    // The other repository is never touched, nor even read.
    expect(stateOf(gh, OTHER, 'factory/job_9/integration')).toBe('open');
    expect(gh.branchHead(OTHER, 'factory/job_9/integration')).toBeDefined();
    const paths = gh.requests.slice(before).map((r) => r.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(`/repos/${SANDBOX}/`), p).toBe(true);
  });

  it('refuses a full name that is not owner/name before sending anything', async () => {
    const gh = await fakeGitHub();
    await expect(
      prepareSandbox({
        fullName: '../other',
        apiBaseUrl: gh.url,
        token: () => TOKEN,
        gitEnv: gh.gitEnv(),
        workDir: tempDir('sandbox-work-'),
      }),
    ).rejects.toThrow(/owner\/name/);
    expect(gh.requests).toHaveLength(0);
  });
});
