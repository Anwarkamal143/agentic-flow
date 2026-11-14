/**
 * The GitHub port (#54, ADR-0033) against the fake GitHub server, over real
 * HTTP, with a local bare repository as the git remote. No database: the port
 * is the built `@factory/github` package, called as the runtime will call it.
 *
 * The fake GitHub is a test double, never shipped in the runtime. Passing here
 * says the port speaks the REST subset the fake implements, as GitHub documents
 * it; it is not evidence against the real GitHub (that is C7, `[real]`).
 */
import { GitHubPort, type GitHubFailure, type TokenResolution } from '@factory/github';
import { describe, expect, it } from 'vitest';
import { git, tinyTsRepo } from '../support/factory.js';
import { fakeGitHub, type FakeGitHub } from '../support/github.js';

const REPO = { owner: 'acme', name: 'tiny-ts' };
const HEAD = 'factory/job_1/integration';

/** A fake GitHub with `acme/tiny-ts`, a pushed head branch, and a port pointed at it. */
async function setup(token: () => Promise<TokenResolution> = fixedToken) {
  const gh = await fakeGitHub();
  const remote = gh.addRepository('acme/tiny-ts', tinyTsRepo());
  const headSha = gh.pushForeignCommit('acme/tiny-ts', HEAD, { 'src/extra.ts': 'export {};\n' });
  const port = new GitHubPort({ apiBaseUrl: gh.url, token });
  return { gh, remote, headSha, port };
}

function fixedToken(): Promise<TokenResolution> {
  return Promise.resolve({ ok: true, token: FAKE_TOKEN });
}
const FAKE_TOKEN = 'fake-gh-token-0000';

function failureOf(result: { ok: boolean; failure?: GitHubFailure }): GitHubFailure | undefined {
  return result.ok ? undefined : result.failure;
}

async function openPr(port: GitHubPort, gh: FakeGitHub) {
  const created = await port.createPullRequest(REPO, {
    title: 'Add sum()',
    body: 'body <!-- factory:job_1 -->',
    head: HEAD,
    base: 'main',
  });
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.failure)}`);
  expect(gh.pullRequests('acme/tiny-ts')).toHaveLength(1);
  return created.value;
}

describe('GitHub port: pull requests', () => {
  it('creates a PR, finds it by head branch, reads, updates and comments on it', async () => {
    const { gh, port, headSha } = await setup();
    expect(await port.findPullRequestByHead(REPO, HEAD)).toEqual({ ok: true, value: null });

    const pr = await openPr(port, gh);
    expect(pr).toMatchObject({
      number: 1,
      state: 'open',
      merged: false,
      head: { ref: HEAD, sha: headSha },
      base: { ref: 'main', sha: gh.branchHead('acme/tiny-ts', 'main') },
      body: 'body <!-- factory:job_1 -->',
    });
    expect(pr.htmlUrl).toBe(`${gh.url}/acme/tiny-ts/pull/1`);

    const found = await port.findPullRequestByHead(REPO, HEAD);
    expect(found.ok && found.value?.number).toBe(1);

    const updated = await port.updatePullRequest(REPO, 1, { body: 'new body' });
    expect(updated.ok && updated.value.body).toBe('new body');

    const comment = await port.createComment(REPO, 1, 'stopped tracking <!-- factory:job_1 -->');
    expect(comment.ok).toBe(true);
    const comments = await port.listIssueComments(REPO, 1);
    expect(comments.ok && !comments.notModified && comments.value.map((c) => c.body)).toEqual([
      'stopped tracking <!-- factory:job_1 -->',
    ]);

    // Every request carried the token the reference resolved to, and GitHub's media type.
    for (const r of gh.requests) {
      expect(r.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(r.headers['accept']).toBe('application/vnd.github+json');
    }
  });

  it('reads reviews, review comments, check runs, statuses and a branch head', async () => {
    const { gh, port, headSha } = await setup();
    await openPr(port, gh);
    gh.addReview('acme/tiny-ts', 1, {
      user: 'reviewer',
      state: 'CHANGES_REQUESTED',
      body: 'please rename',
    });
    gh.addReviewComment('acme/tiny-ts', 1, { user: 'reviewer', body: 'nit', path: 'src/extra.ts' });
    gh.setCheckRun('acme/tiny-ts', headSha, {
      name: 'ci/test',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://ci.example/run/7',
    });
    gh.setStatus('acme/tiny-ts', headSha, {
      context: 'lint',
      state: 'success',
      targetUrl: 'https://ci.example/lint/7',
    });

    const reviews = await port.listReviews(REPO, 1);
    expect(reviews.ok && !reviews.notModified && reviews.value).toEqual([
      expect.objectContaining({
        state: 'CHANGES_REQUESTED',
        body: 'please rename',
        author: 'reviewer',
        commitId: headSha,
      }),
    ]);
    const reviewComments = await port.listReviewComments(REPO, 1);
    expect(reviewComments.ok && !reviewComments.notModified && reviewComments.value).toEqual([
      expect.objectContaining({ body: 'nit', author: 'reviewer', path: 'src/extra.ts' }),
    ]);
    const runs = await port.listCheckRuns(REPO, headSha);
    expect(runs.ok && !runs.notModified && runs.value).toEqual([
      expect.objectContaining({
        name: 'ci/test',
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: 'https://ci.example/run/7',
      }),
    ]);
    const statuses = await port.listCommitStatuses(REPO, headSha);
    expect(statuses.ok && !statuses.notModified && statuses.value).toEqual([
      expect.objectContaining({
        context: 'lint',
        state: 'success',
        targetUrl: 'https://ci.example/lint/7',
      }),
    ]);
    const branch = await port.getBranchHead(REPO, HEAD);
    expect(branch.ok && !branch.notModified && branch.value).toBe(headSha);

    // Re-running a check queues it again.
    const runId = runs.ok && !runs.notModified ? runs.value[0]?.id : undefined;
    expect((await port.rerunCheckRun(REPO, runId ?? -1)).ok).toBe(true);
    const rerun = await port.listCheckRuns(REPO, headSha);
    expect(rerun.ok && !rerun.notModified && rerun.value[0]).toMatchObject({
      status: 'queued',
      conclusion: null,
    });
  });

  it('merges a PR with a merge commit that keeps the head in the base history', async () => {
    const { gh, port, remote, headSha } = await setup();
    await openPr(port, gh);
    const merged = await port.mergePullRequest(REPO, 1, { method: 'merge', sha: headSha });
    expect(merged.ok, JSON.stringify(merged)).toBe(true);
    const mergeSha = merged.ok ? merged.value.sha : '';
    expect(git(remote.bareDir, ['rev-parse', 'refs/heads/main']).trim()).toBe(mergeSha);
    expect(git(remote.bareDir, ['rev-list', '--parents', '-n', '1', mergeSha]).trim()).toContain(
      headSha,
    );
    const pr = await port.getPullRequest(REPO, 1);
    expect(pr.ok && !pr.notModified && pr.value).toMatchObject({
      state: 'closed',
      merged: true,
      mergeCommitSha: mergeSha,
    });
  });

  it('closes and reopens a PR; the fake moves the base and pushes foreign commits', async () => {
    const { gh, port } = await setup();
    await openPr(port, gh);
    const baseBefore = gh.branchHead('acme/tiny-ts', 'main');
    const movedBase = gh.moveBase('acme/tiny-ts', { 'README.md': 'moved\n' });
    const foreign = gh.pushForeignCommit('acme/tiny-ts', HEAD, { 'src/foreign.ts': '//\n' });

    const pr = await port.getPullRequest(REPO, 1);
    expect(pr.ok && !pr.notModified && pr.value).toMatchObject({
      head: { sha: foreign },
      base: { sha: movedBase },
    });
    expect(movedBase).not.toBe(baseBefore);

    gh.closePullRequest('acme/tiny-ts', 1);
    const closed = await port.getPullRequest(REPO, 1);
    expect(closed.ok && !closed.notModified && closed.value).toMatchObject({
      state: 'closed',
      merged: false,
    });
    const reopened = await port.reopenPullRequest(REPO, 1);
    expect(reopened.ok && reopened.value.state).toBe('open');
  });
});

describe('GitHub port: conditional reads', () => {
  it('sends If-None-Match with a stored ETag and surfaces a 304 as not modified', async () => {
    const { gh, port } = await setup();
    await openPr(port, gh);

    const first = await port.getPullRequest(REPO, 1);
    expect(first.ok && !first.notModified).toBe(true);
    const etag = first.ok ? (first.etag ?? '') : '';
    expect(etag).toMatch(/.+/);

    const again = await port.getPullRequest(REPO, 1, { etag });
    expect(again).toEqual({ ok: true, notModified: true, etag });
    expect(gh.requests.at(-1)?.headers['if-none-match']).toBe(etag);

    // A change gives a new representation and a new ETag.
    gh.addComment('acme/tiny-ts', 1, { user: 'human', body: 'hello' });
    gh.closePullRequest('acme/tiny-ts', 1);
    const changed = await port.getPullRequest(REPO, 1, { etag });
    expect(changed.ok && !changed.notModified && changed.value.state).toBe('closed');
    expect(changed.ok && changed.etag).not.toBe(etag);
  });

  it('surfaces a simulated 304 for a list read', async () => {
    const { gh, port, headSha } = await setup();
    gh.simulate({ kind: 'not_modified' });
    expect(await port.listCheckRuns(REPO, headSha, { etag: 'W/"anything"' })).toEqual({
      ok: true,
      notModified: true,
      etag: 'W/"anything"',
    });
  });
});

describe('GitHub port: failures are classified', () => {
  it('a 429 is a rate limit with its reset time', async () => {
    const { gh, port } = await setup();
    const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
    gh.simulate({ kind: 'rate_limit', status: 429, resetAt });
    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toEqual({
      kind: 'rate_limited',
      status: 429,
      resetAt: resetAt.toISOString(),
    });
  });

  it('a 403 with the limit spent is a rate limit; a secondary limit uses retry-after', async () => {
    const { gh, port } = await setup();
    const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 120_000);
    gh.simulate({ kind: 'rate_limit', status: 403, resetAt });
    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toEqual({
      kind: 'rate_limited',
      status: 403,
      resetAt: resetAt.toISOString(),
    });

    const before = Date.now();
    gh.simulate({ kind: 'secondary_rate_limit', retryAfterSeconds: 30 });
    const secondary = failureOf(await port.getBranchHead(REPO, 'main'));
    expect(secondary?.kind).toBe('rate_limited');
    const reset = secondary?.kind === 'rate_limited' ? Date.parse(secondary.resetAt) : 0;
    expect(reset).toBeGreaterThanOrEqual(before + 29_000);
    expect(reset).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('a 5xx and a dropped connection are transient', async () => {
    const { gh, port } = await setup();
    gh.simulate({ kind: 'server_error', status: 502 });
    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toMatchObject({
      kind: 'transient',
      status: 502,
    });
    gh.simulate({ kind: 'network' });
    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toMatchObject({
      kind: 'transient',
    });
    // The fault was one-shot: the next read succeeds.
    expect((await port.getBranchHead(REPO, 'main')).ok).toBe(true);
  });

  it('a 4xx is a definitive refusal, with GitHub message: a merge method or a reopen refused', async () => {
    const { gh, port, headSha } = await setup();
    await openPr(port, gh);

    gh.refuseMergeMethod('acme/tiny-ts', 'merge');
    const merge = failureOf(
      await port.mergePullRequest(REPO, 1, { method: 'merge', sha: headSha }),
    );
    expect(merge).toEqual({
      kind: 'refused',
      status: 405,
      reason: 'Merge commits are not allowed on this repository.',
    });

    gh.closePullRequest('acme/tiny-ts', 1);
    gh.refuseReopen('acme/tiny-ts', 1);
    expect(failureOf(await port.reopenPullRequest(REPO, 1))).toMatchObject({
      kind: 'refused',
      status: 422,
    });

    expect(failureOf(await port.getPullRequest(REPO, 99))).toMatchObject({
      kind: 'refused',
      status: 404,
    });
    // A 403 that is not a rate limit is a refusal too.
    gh.simulate({ kind: 'forbidden' });
    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toMatchObject({
      kind: 'refused',
      status: 403,
    });
  });
});

describe('GitHub port: the token reference', () => {
  it('resolves the token for each request, and refuses without sending when it does not resolve', async () => {
    let n = 0;
    const unset: TokenResolution = { ok: false, problem: 'GH_ACCESS is not set' };
    const tokens: TokenResolution[] = [
      { ok: true, token: 'fake-token-first-0001' },
      { ok: true, token: 'fake-token-second-002' },
    ];
    const { gh, port } = await setup(() => Promise.resolve(tokens[n++] ?? unset));
    gh.requests.length = 0;

    expect((await port.getBranchHead(REPO, 'main')).ok).toBe(true);
    expect((await port.getBranchHead(REPO, 'main')).ok).toBe(true);
    expect(gh.requests.map((r) => r.headers['authorization'])).toEqual([
      'Bearer fake-token-first-0001',
      'Bearer fake-token-second-002',
    ]);

    expect(failureOf(await port.getBranchHead(REPO, 'main'))).toEqual({
      kind: 'refused',
      status: null,
      reason: 'the GitHub token reference does not resolve: GH_ACCESS is not set',
    });
    expect(gh.requests, 'nothing was sent without a token').toHaveLength(2);
  });
});
