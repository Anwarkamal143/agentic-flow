/**
 * Recovery of the PR write (#57, Q28, ADR-0036): before creating a PR, the
 * factory looks one up by head branch. It adopts the PR only if it carries the
 * Job's marker; a PR without it raises `recovery_uncertain` and is never
 * adopted. Drives the built runtime's exported `ensurePullRequest` and the
 * built `@factory/github` port against the fake GitHub over real HTTP, with no
 * database (ADR-0025, ADR-0033).
 *
 * The fake GitHub is a test double; passing here is not evidence against the
 * real GitHub (that is C7, `[real]`).
 */
import { pullRequestMarker } from '@factory/domain';
import { GitHubPort } from '@factory/github';
import { describe, expect, it } from 'vitest';
import { ensurePullRequest } from '../../apps/runtime/dist/pull-request.js';
import { tinyTsRepo } from '../support/factory.js';
import { fakeGitHub } from '../support/github.js';

const REPO = { owner: 'acme', name: 'tiny-ts' };
const JOB = 'job_01';
const HEAD = `factory/${JOB}/integration`;

async function setup() {
  const gh = await fakeGitHub();
  gh.addRepository('acme/tiny-ts', tinyTsRepo());
  gh.pushForeignCommit('acme/tiny-ts', HEAD, { 'src/extra.ts': 'export {};\n' });
  const port = new GitHubPort({
    apiBaseUrl: gh.url,
    token: () => Promise.resolve({ ok: true, token: 'fake-gh-token-0000' }),
  });
  const request = {
    jobId: JOB,
    head: HEAD,
    base: 'main',
    title: 'Add sum()',
    body: `The body.\n\n${pullRequestMarker(JOB)}\n`,
  };
  const creates = () => gh.requests.filter((r) => r.method === 'POST' && /\/pulls$/.test(r.path));
  return { gh, port, request, creates };
}

describe('ensurePullRequest', () => {
  it('creates the PR when none is on the head branch', async () => {
    const { gh, port, request, creates } = await setup();

    const result = await ensurePullRequest(port, REPO, request);

    expect(result.kind).toBe('created');
    expect(creates()).toHaveLength(1);
    expect(gh.pullRequests('acme/tiny-ts')).toMatchObject([
      { state: 'open', head: HEAD, base: 'main', title: 'Add sum()', body: request.body },
    ]);
  });

  it('adopts the marked PR a crash left unrecorded, and never opens a second one', async () => {
    const { gh, port, request, creates } = await setup();
    // The first run created the PR, then the runtime died before recording it.
    const first = await ensurePullRequest(port, REPO, request);
    expect(first.kind).toBe('created');

    const recovered = await ensurePullRequest(port, REPO, request);

    expect(recovered.kind).toBe('adopted');
    if (recovered.kind !== 'adopted' || first.kind !== 'created') throw new Error('unreachable');
    expect(recovered.pr.number).toBe(first.pr.number);
    expect(creates()).toHaveLength(1);
    expect(gh.pullRequests('acme/tiny-ts')).toHaveLength(1);
  });

  it("raises recovery_uncertain for a PR on the head branch without the Job's marker, adopting nothing", async () => {
    const { gh, port, request, creates } = await setup();
    // Someone else opened a PR from the factory's head branch.
    const foreign = await port.createPullRequest(REPO, {
      title: 'Not the factory',
      body: 'Opened by hand.',
      head: HEAD,
      base: 'main',
    });
    expect(foreign.ok).toBe(true);

    const result = await ensurePullRequest(port, REPO, request);

    expect(result.kind).toBe('uncertain');
    expect(creates()).toHaveLength(1); // the foreign one only
    expect(gh.pullRequests('acme/tiny-ts')).toMatchObject([{ title: 'Not the factory' }]);
  });

  it("does not adopt another Job's PR on the same branch name", async () => {
    const { port, request, creates } = await setup();
    await port.createPullRequest(REPO, {
      ...request,
      body: `Other.\n\n${pullRequestMarker('job_02')}\n`,
    });

    const result = await ensurePullRequest(port, REPO, request);

    expect(result.kind).toBe('uncertain');
    expect(creates()).toHaveLength(1);
  });

  it('reports a GitHub failure as it is, creating nothing', async () => {
    const { gh, port, request, creates } = await setup();
    gh.simulate({ kind: 'server_error', status: 503 }, { path: /\/pulls/ });

    const result = await ensurePullRequest(port, REPO, request);

    expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'transient' } });
    expect(creates()).toHaveLength(0);
  });
});
