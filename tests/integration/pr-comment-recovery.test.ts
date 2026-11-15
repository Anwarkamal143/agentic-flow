/**
 * Recovery of the factory's PR comments (#60, Q28, ADR-0039): every comment
 * carries the marker `<!-- factory:<job>:<event> -->` and is looked up by it
 * before it is posted, so a write retried after a crash is not duplicated.
 * Drives the built runtime's exported `ensureComment` and the built
 * `@factory/github` port against the fake GitHub over real HTTP, with no
 * database (ADR-0025, ADR-0033).
 *
 * The fake GitHub is a test double; passing here is not evidence against the
 * real GitHub (that is C7, `[real]`).
 */
import { factoryMarker } from '@factory/domain';
import { GitHubPort } from '@factory/github';
import { describe, expect, it } from 'vitest';
import { ensureComment } from '../../apps/runtime/dist/pr-feedback.js';
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
  const pr = await port.createPullRequest(REPO, {
    title: 'T',
    body: 'B',
    head: HEAD,
    base: 'main',
  });
  if (!pr.ok) throw new Error('no PR');
  const marker = factoryMarker(JOB, 'pull_request.updated:stg_01');
  const body = `Updated in place.\n\n${marker}\n`;
  const posts = () =>
    gh.requests.filter((r) => r.method === 'POST' && /\/issues\/\d+\/comments$/.test(r.path));
  return { gh, port, number: pr.value.number, marker, body, posts };
}

describe('ensureComment', () => {
  it('posts the marked comment when none is there', async () => {
    const { port, number, marker, body, posts } = await setup();

    const result = await ensureComment(port, REPO, number, marker, body);

    expect(result.kind).toBe('created');
    expect(posts()).toHaveLength(1);
  });

  it('a write retried after a crash finds the comment it made and posts no second one', async () => {
    const { gh, port, number, marker, body, posts } = await setup();
    gh.addComment('acme/tiny-ts', number, { user: 'alice', body: 'Unrelated comment.' });
    // The first run posted the comment, then the runtime died before recording it.
    const first = await ensureComment(port, REPO, number, marker, body);
    expect(first.kind).toBe('created');

    const retried = await ensureComment(port, REPO, number, marker, body);

    expect(retried.kind).toBe('found');
    if (retried.kind !== 'found' || first.kind !== 'created') throw new Error('unreachable');
    expect(retried.comment.id).toBe(first.comment.id);
    expect(posts()).toHaveLength(1);
  });

  it("a comment with another event's marker is not taken for this one", async () => {
    const { port, number, marker, body, posts } = await setup();
    const other = factoryMarker(JOB, 'pull_request.updated:stg_00');
    await ensureComment(port, REPO, number, other, `Earlier update.\n\n${other}\n`);

    const result = await ensureComment(port, REPO, number, marker, body);

    expect(result.kind).toBe('created');
    expect(posts()).toHaveLength(2);
  });

  it('posts nothing when the lookup fails', async () => {
    const { gh, port, number, marker, body, posts } = await setup();
    gh.simulate({ kind: 'server_error', status: 503 }, { path: /\/issues\/\d+\/comments$/ });

    const result = await ensureComment(port, REPO, number, marker, body);

    expect(result).toMatchObject({ kind: 'failed', failure: { kind: 'transient' } });
    expect(posts()).toHaveLength(0);
  });
});
