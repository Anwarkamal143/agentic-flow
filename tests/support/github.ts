/**
 * The fake GitHub (#54, ADR-0033): an HTTP server that implements the REST
 * subset the factory's GitHub port uses, with ETags and 304s, and a local bare
 * repository per repository as the git remote. Test support only: it is never
 * shipped in the runtime, and a test that passes against it says nothing about
 * the real GitHub.
 *
 * The git side is real: branch heads, PR head and base SHAs, and merges are
 * read from and made in the bare repository, so a push the factory makes is
 * what the API reports. `gitEnv()` rewrites each repository's
 * `https://github.com/<owner>/<name>.git` URL to its bare repository
 * (`url.<bare>.insteadOf`), for the runtime's git.
 *
 * The control API (methods on the returned object) acts as GitHub's other
 * users would: set check results, add reviews and comments, move the base,
 * push foreign commits, close, reopen or merge a PR, open, label, edit or close
 * an issue (#112), refuse a merge method or
 * a reopen, and simulate a 304, a rate limit, a 5xx or a dropped connection.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import { git, tempDir } from './factory.js';

export interface RecordedRequest {
  method: string;
  /** Path and query, as received. */
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  /** When it arrived (ms since the epoch). */
  at: number;
  /** The status answered (304 for a matching ETag); unset while in flight or for a dropped connection. */
  status?: number;
}

export interface FakeRemote {
  fullName: string;
  /** The bare repository standing in for GitHub's git remote. */
  bareDir: string;
  /** The URL a checkout would have as its origin. `gitEnv()` rewrites it to `bareDir`. */
  remoteUrl: string;
}

export type Fault =
  /** The next matching GET (never another method) answers 304, whatever its If-None-Match. */
  | { kind: 'not_modified' }
  /** The primary rate limit spent: `x-ratelimit-remaining: 0` with the reset time. */
  | { kind: 'rate_limit'; status: 429 | 403; resetAt: Date }
  /** A secondary rate limit: 403 with `retry-after`. */
  | { kind: 'secondary_rate_limit'; retryAfterSeconds: number }
  /** A 403 that is not a rate limit (for example, missing permissions). */
  | { kind: 'forbidden' }
  | { kind: 'server_error'; status: 500 | 502 | 503 | 504 }
  /** The connection is dropped with no response. */
  | { kind: 'network' };

export interface CheckRunInput {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  detailsUrl?: string | null;
  /** Served as `output.summary`. */
  summary?: string | null;
  /**
   * The slug of the app that made it (`app.slug`): `github-actions` (the
   * default) makes it a job of an Actions workflow run, re-run through the
   * Actions API; any other app's run can't be re-run with the factory's token.
   */
  app?: string;
  /** The Actions workflow run it is a job of, by name (default `ci`); only for `github-actions`. */
  workflow?: string;
}

export interface StatusInput {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
  targetUrl?: string | null;
  description?: string | null;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeableState: string;
  author: string;
  createdAt: string;
  reviews: Review[];
  comments: Comment[];
  reviewComments: (Comment & { path: string })[];
  refuseReopen: boolean;
  /** The last SHAs seen for head and base, kept if a branch is deleted (as GitHub keeps them). */
  lastSha: { head: string; base: string };
}

interface Review {
  id: number;
  state: string;
  body: string;
  author: string;
  commitId: string;
  submittedAt: string;
}

interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
  sha: string;
  app: string;
  checkSuiteId: number;
}

/** An Actions workflow run on a head: its jobs are the check runs of its check suite. */
interface WorkflowRun {
  id: number;
  name: string;
  sha: string;
  checkSuiteId: number;
  runAttempt: number;
}

interface Repo {
  remote: FakeRemote;
  pulls: PullRequest[];
  checkRuns: CheckRun[];
  workflowRuns: WorkflowRun[];
  /** The check suite of each other app on a head (`<sha>:<app>`). */
  appSuites: Map<string, number>;
  statuses: (StatusInput & { id: number; sha: string; createdAt: string })[];
  refusedMethods: Set<MergeMethod>;
  /** What `GET /repos/:owner/:name` reports as `permissions.push` for the token. */
  push: boolean;
  /** Issues (#112): numbered with the PRs, as on GitHub. */
  issues: Issue[];
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
}

/** The next issue or PR number: issues and PRs share one sequence, as on GitHub. */
function nextNumber(repo: Repo): number {
  return Math.max(0, ...repo.pulls.map((p) => p.number), ...repo.issues.map((i) => i.number)) + 1;
}

/** The newest check run of each job (name) of a workflow run. */
function newestJobs(repo: Repo, run: WorkflowRun): CheckRun[] {
  const newest = new Map<string, CheckRun>();
  for (const c of repo.checkRuns) {
    if (c.checkSuiteId !== run.checkSuiteId) continue;
    const seen = newest.get(c.name);
    if (seen === undefined || c.id > seen.id) newest.set(c.name, c);
  }
  return [...newest.values()];
}

/** A workflow run is completed once each of its jobs is; it failed when one did. */
function workflowState(
  repo: Repo,
  run: WorkflowRun,
): { status: string; conclusion: string | null } {
  const jobs = newestJobs(repo, run);
  if (jobs.some((j) => j.status !== 'completed'))
    return { status: 'in_progress', conclusion: null };
  const failed = jobs.some(
    (j) => j.conclusion !== 'success' && j.conclusion !== 'skipped' && j.conclusion !== 'neutral',
  );
  return { status: 'completed', conclusion: failed ? 'failure' : 'success' };
}

export interface FakeGitHub {
  /** The API base URL to point the factory at. */
  readonly url: string;
  /** Every API request received, in order (faults included). */
  readonly requests: RecordedRequest[];
  /** A repository on the fake, its bare remote seeded from the checkout at `seed` (empty without one). */
  addRepository(fullName: string, seed?: string): FakeRemote;
  /** Git config (as environment) that makes each repository's github.com URL reach its bare remote. */
  gitEnv(): Record<string, string>;
  branchHead(fullName: string, branch: string): string | undefined;
  /** The PRs of a repository, as GitHub would list them. */
  pullRequests(fullName: string): {
    number: number;
    state: string;
    head: string;
    base: string;
    body: string | null;
    title: string;
    merged: boolean;
  }[];

  /** The PR's conversation comments, oldest first. */
  comments(fullName: string, number: number): { author: string; body: string }[];

  // ---- the control API ----
  setCheckRun(fullName: string, sha: string, run: CheckRunInput): void;
  setStatus(fullName: string, sha: string, status: StatusInput): void;
  addReview(
    fullName: string,
    number: number,
    review: {
      user: string;
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
      body?: string;
      commitId?: string;
    },
  ): void;
  addComment(fullName: string, number: number, comment: { user: string; body: string }): void;
  addReviewComment(
    fullName: string,
    number: number,
    comment: { user: string; body: string; path: string },
  ): void;
  /** Commits `files` on the default branch, as another user merging something. Returns the new head. */
  moveBase(fullName: string, files: Record<string, string>): string;
  /** Commits `files` on `branch` (created from the default branch if missing), as someone else. */
  pushForeignCommit(fullName: string, branch: string, files: Record<string, string>): string;
  /**
   * Force-pushes to `branch` one commit made on the default branch's tip, so
   * every commit the branch held is dropped (a rewrite); returns its SHA.
   */
  forcePushForeignCommit(fullName: string, branch: string, files: Record<string, string>): string;
  closePullRequest(fullName: string, number: number): void;
  reopenPullRequest(fullName: string, number: number): void;
  /** A human merges the PR on GitHub. Returns the merge commit. */
  mergePullRequest(fullName: string, number: number, method?: MergeMethod): string;
  setMergeableState(fullName: string, number: number, state: string): void;
  refuseMergeMethod(fullName: string, method: MergeMethod): void;
  /** The repository's settings allow `method` again. */
  allowMergeMethod(fullName: string, method: MergeMethod): void;
  refuseReopen(fullName: string, number: number): void;
  /**
   * The token loses push permission (#108): the repository's `permissions.push`
   * reads false and a git push to it is refused as GitHub refuses it
   * ("Permission to owner/name.git denied"). `apiStillAllows`: only git refuses,
   * the REST API still reports push (a permission lost between two reads).
   */
  denyPush(fullName: string, opts?: { apiStillAllows?: boolean }): void;
  /** The token may push again, through the API and git. */
  allowPush(fullName: string): void;
  /** Opens an issue as a GitHub user would; returns its number. */
  addIssue(fullName: string, issue: { title: string; body?: string; labels?: string[] }): number;
  /** Replaces an issue's labels (a user labeling or unlabeling it). */
  setIssueLabels(fullName: string, number: number, labels: string[]): void;
  /** Edits an issue's title or body. */
  editIssue(fullName: string, number: number, edit: { title?: string; body?: string }): void;
  closeIssue(fullName: string, number: number): void;
  reopenIssue(fullName: string, number: number): void;
  /** Queues a one-shot fault for the next API request (matching `path`, when given). */
  simulate(fault: Fault, opts?: { path?: RegExp }): void;
}

const FAKE_BOT = 'factory-bot';

/** A request body field as text: a string as is, anything else as empty. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Starts a fake GitHub on 127.0.0.1. It is stopped when the test finishes. */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const repos = new Map<string, Repo>();
  const requests: RecordedRequest[] = [];
  const faults: { fault: Fault; path?: RegExp }[] = [];
  let nextId = 1000;
  let url = '';

  const repoOf = (fullName: string): Repo => {
    const repo = repos.get(fullName.toLowerCase());
    if (repo === undefined) throw new Error(`fake GitHub: no repository ${fullName}`);
    return repo;
  };
  const prOf = (fullName: string, number: number): PullRequest => {
    const pr = repoOf(fullName).pulls.find((p) => p.number === number);
    if (pr === undefined) throw new Error(`fake GitHub: no PR #${String(number)} in ${fullName}`);
    return pr;
  };
  const issueOf = (fullName: string, number: number): Issue => {
    const issue = repoOf(fullName).issues.find((i) => i.number === number);
    if (issue === undefined) {
      throw new Error(`fake GitHub: no issue #${String(number)} in ${fullName}`);
    }
    return issue;
  };
  const head = (repo: Repo, branch: string): string | undefined => {
    try {
      return git(repo.remote.bareDir, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}^{commit}`,
      ]).trim();
    } catch {
      return undefined;
    }
  };
  const defaultBranch = (repo: Repo): string =>
    git(repo.remote.bareDir, ['symbolic-ref', '--short', 'HEAD']).trim();

  /** Commits `files` on `branch` of the bare remote through a scratch clone, as `author`. */
  const commitOn = (
    repo: Repo,
    branch: string,
    files: Record<string, string>,
    message: string,
    opts: { from?: string; force?: boolean } = {},
  ) => {
    const work = join(tempDir('fake-gh-work-'), 'w');
    git(dirname(work), ['clone', '--quiet', repo.remote.bareDir, work]);
    if (opts.from !== undefined)
      git(work, ['checkout', '--quiet', '-B', branch, `origin/${opts.from}`]);
    else if (head(repo, branch) === undefined) git(work, ['checkout', '--quiet', '-b', branch]);
    else git(work, ['checkout', '--quiet', branch]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    git(work, ['add', '--all']);
    git(work, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
    git(work, [
      'push',
      '--quiet',
      ...(opts.force === true ? ['--force'] : []),
      'origin',
      `HEAD:refs/heads/${branch}`,
    ]);
    return git(work, ['rev-parse', 'HEAD']).trim();
  };

  /** Merges `pr` in the bare remote. A conflict, or an unsupported method, returns a reason. */
  const merge = (
    repo: Repo,
    pr: PullRequest,
    method: MergeMethod,
  ): { sha: string } | { error: string } | { notImplemented: string } => {
    const baseSha = head(repo, pr.base);
    const headSha = head(repo, pr.head);
    if (baseSha === undefined || headSha === undefined) return { error: 'Branch not found' };
    if (method === 'rebase')
      return { notImplemented: 'The fake GitHub does not implement rebase merges' };
    let tree: string;
    try {
      tree =
        git(repo.remote.bareDir, ['merge-tree', '--write-tree', baseSha, headSha])
          .trim()
          .split('\n')[0] ?? '';
    } catch {
      return { error: 'Pull Request is not mergeable' };
    }
    const parents = method === 'merge' ? ['-p', baseSha, '-p', headSha] : ['-p', baseSha];
    const title = `${method === 'merge' ? 'Merge pull request' : 'Squash'} #${String(pr.number)}`;
    const sha = git(repo.remote.bareDir, ['commit-tree', tree, ...parents, '-m', title]).trim();
    git(repo.remote.bareDir, ['update-ref', `refs/heads/${pr.base}`, sha, baseSha]);
    pr.state = 'closed';
    pr.mergedAt = new Date().toISOString();
    pr.mergeCommitSha = sha;
    return { sha };
  };

  // ---- REST representations (the subset of GitHub's fields the port reads) ----
  const user = (login: string) => ({ login, type: login === FAKE_BOT ? 'Bot' : 'User' });
  const prJson = (repo: Repo, pr: PullRequest, single: boolean) => {
    pr.lastSha = {
      head: head(repo, pr.head) ?? pr.lastSha.head,
      base: head(repo, pr.base) ?? pr.lastSha.base,
    };
    return prBody(repo, pr, single);
  };
  const prBody = (repo: Repo, pr: PullRequest, single: boolean) => ({
    number: pr.number,
    html_url: `${url}/${repo.remote.fullName}/pull/${String(pr.number)}`,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    draft: false,
    user: user(pr.author),
    created_at: pr.createdAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: {
      ref: pr.head,
      sha: pr.lastSha.head,
      repo: { full_name: repo.remote.fullName },
    },
    base: {
      ref: pr.base,
      sha: pr.lastSha.base,
      repo: { full_name: repo.remote.fullName },
    },
    ...(single
      ? {
          merged: pr.mergedAt !== null,
          mergeable_state: pr.state === 'open' ? pr.mergeableState : 'unknown',
        }
      : {}),
  });
  const commentJson = (repo: Repo, prNumber: number, c: Comment) => ({
    id: c.id,
    body: c.body,
    user: user(c.author),
    created_at: c.createdAt,
    html_url: `${url}/${repo.remote.fullName}/pull/${String(prNumber)}#issuecomment-${String(c.id)}`,
  });

  const issueJson = (repo: Repo, i: Issue) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    html_url: `${url}/${repo.remote.fullName}/issues/${String(i.number)}`,
    labels: i.labels.map((name) => ({ name })),
    user: user('octo-user'),
  });

  type Reply = { status: number; body?: unknown };
  const notFound: Reply = { status: 404, body: { message: 'Not Found' } };

  const route = (method: string, path: string, query: URLSearchParams, body: unknown): Reply => {
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (m === null) return notFound;
    const repo = repos.get(`${m[1] ?? ''}/${m[2] ?? ''}`.toLowerCase());
    if (repo === undefined) return notFound;
    const rest = m[3] ?? '';
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    let r: RegExpExecArray | null;

    if (rest === '' && method === 'GET') {
      return {
        status: 200,
        body: {
          full_name: repo.remote.fullName,
          default_branch: defaultBranch(repo),
          permissions: { admin: false, maintain: false, push: repo.push, triage: true, pull: true },
        },
      };
    }
    if (rest === '/pulls' && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const headQ = query.get('head');
      const list = repo.pulls.filter(
        (p) =>
          (state === 'all' || p.state === state) &&
          (headQ === null ||
            `${repo.remote.fullName.split('/')[0] ?? ''}:${p.head}`.toLowerCase() ===
              headQ.toLowerCase()),
      );
      return { status: 200, body: list.map((p) => prJson(repo, p, false)) };
    }
    if (rest === '/pulls' && method === 'POST') {
      const headRef = text(input['head']);
      const baseRef = text(input['base']);
      if (head(repo, headRef) === undefined || head(repo, baseRef) === undefined) {
        return {
          status: 422,
          body: { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] },
        };
      }
      if (repo.pulls.some((p) => p.head === headRef && p.state === 'open')) {
        return { status: 422, body: { message: `A pull request already exists for ${headRef}.` } };
      }
      const pr: PullRequest = {
        number: nextNumber(repo),
        title: text(input['title']),
        body: typeof input['body'] === 'string' ? input['body'] : null,
        head: headRef,
        base: baseRef,
        state: 'open',
        mergedAt: null,
        mergeCommitSha: null,
        mergeableState: 'clean',
        author: FAKE_BOT,
        createdAt: new Date().toISOString(),
        reviews: [],
        comments: [],
        reviewComments: [],
        refuseReopen: false,
        lastSha: { head: head(repo, headRef) ?? '', base: head(repo, baseRef) ?? '' },
      };
      repo.pulls.push(pr);
      return { status: 201, body: prJson(repo, pr, true) };
    }
    if ((r = /^\/pulls\/(\d+)(\/[a-z]+)?$/.exec(rest)) !== null) {
      const pr = repo.pulls.find((p) => p.number === Number(r?.[1]));
      if (pr === undefined) return notFound;
      const sub = r[2];
      if (sub === undefined && method === 'GET')
        return { status: 200, body: prJson(repo, pr, true) };
      if (sub === undefined && method === 'PATCH') {
        if (input['state'] === 'open' && pr.state === 'closed') {
          if (pr.refuseReopen || pr.mergedAt !== null) {
            return {
              status: 422,
              body: {
                message: 'Validation Failed',
                errors: [{ code: 'custom', message: 'state cannot be changed.' }],
              },
            };
          }
        }
        if (typeof input['title'] === 'string') pr.title = input['title'];
        if (typeof input['body'] === 'string') pr.body = input['body'];
        if (input['state'] === 'open' || input['state'] === 'closed') pr.state = input['state'];
        return { status: 200, body: prJson(repo, pr, true) };
      }
      if (sub === '/merge' && method === 'PUT') {
        const methodIn = (input['merge_method'] ?? 'merge') as MergeMethod;
        if (repo.refusedMethods.has(methodIn)) {
          const what = { merge: 'Merge commits', squash: 'Squash merges', rebase: 'Rebase merges' }[
            methodIn
          ];
          return { status: 405, body: { message: `${what} are not allowed on this repository.` } };
        }
        if (pr.state !== 'open')
          return { status: 405, body: { message: 'Pull Request is not mergeable' } };
        if (typeof input['sha'] === 'string' && input['sha'] !== head(repo, pr.head)) {
          return {
            status: 409,
            body: { message: 'Head branch was modified. Review and try the merge again.' },
          };
        }
        const done = merge(repo, pr, methodIn);
        // 501: the fake's own gap, never mistaken for GitHub refusing a method (405).
        if ('notImplemented' in done)
          return { status: 501, body: { message: done.notImplemented } };
        if ('error' in done) return { status: 405, body: { message: done.error } };
        return {
          status: 200,
          body: { sha: done.sha, merged: true, message: 'Pull Request successfully merged' },
        };
      }
      if (sub === '/reviews' && method === 'GET') {
        return {
          status: 200,
          body: pr.reviews.map((v) => ({
            id: v.id,
            state: v.state,
            body: v.body,
            user: user(v.author),
            commit_id: v.commitId,
            submitted_at: v.submittedAt,
          })),
        };
      }
      if (sub === '/comments' && method === 'GET') {
        return {
          status: 200,
          body: pr.reviewComments.map((c) => ({
            ...commentJson(repo, pr.number, c),
            path: c.path,
          })),
        };
      }
      return notFound;
    }
    if (rest === '/issues' && method === 'GET') {
      // GitHub lists PRs here too (with a `pull_request` key); `labels` must all match.
      const state = query.get('state') ?? 'open';
      const wanted = (query.get('labels') ?? '')
        .split(',')
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l !== '');
      const list = repo.issues.filter(
        (i) =>
          (state === 'all' || i.state === state) &&
          wanted.every((w) => i.labels.some((l) => l.toLowerCase() === w)),
      );
      const pulls =
        wanted.length === 0
          ? repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => p.number)
          : [];
      return {
        status: 200,
        body: [
          ...list.map((i) => issueJson(repo, i)),
          ...pulls.map((number) => ({
            ...issueJson(repo, { number, title: '', body: null, state: 'open', labels: [] }),
            pull_request: { url: `${url}/repos/${repo.remote.fullName}/pulls/${String(number)}` },
          })),
        ],
      };
    }
    if ((r = /^\/issues\/(\d+)$/.exec(rest)) !== null && method === 'GET') {
      const number = Number(r[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue !== undefined) return { status: 200, body: issueJson(repo, issue) };
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return notFound;
      return {
        status: 200,
        body: {
          ...issueJson(repo, {
            number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            labels: [],
          }),
          pull_request: { url: `${url}/repos/${repo.remote.fullName}/pulls/${String(number)}` },
        },
      };
    }
    if ((r = /^\/issues\/(\d+)\/comments$/.exec(rest)) !== null) {
      const pr = repo.pulls.find((p) => p.number === Number(r?.[1]));
      if (pr === undefined) return notFound;
      if (method === 'GET')
        return { status: 200, body: pr.comments.map((c) => commentJson(repo, pr.number, c)) };
      if (method === 'POST') {
        const c: Comment = {
          id: nextId++,
          body: text(input['body']),
          author: FAKE_BOT,
          createdAt: new Date().toISOString(),
        };
        pr.comments.push(c);
        return { status: 201, body: commentJson(repo, pr.number, c) };
      }
      return notFound;
    }
    if (
      (r = /^\/commits\/([^/]+)\/(check-runs|statuses)$/.exec(rest)) !== null &&
      method === 'GET'
    ) {
      const sha = r[1] ?? '';
      if (r[2] === 'check-runs') {
        const runs = repo.checkRuns.filter((c) => c.sha === sha);
        return {
          status: 200,
          body: {
            total_count: runs.length,
            check_runs: runs.map((c) => ({
              id: c.id,
              name: c.name,
              head_sha: c.sha,
              status: c.status,
              conclusion: c.conclusion,
              details_url: c.detailsUrl,
              output: { title: null, summary: c.summary },
              app: { slug: c.app },
              check_suite: { id: c.checkSuiteId },
            })),
          },
        };
      }
      return {
        status: 200,
        body: repo.statuses
          .filter((s) => s.sha === sha)
          .map((s) => ({
            id: s.id,
            context: s.context,
            state: s.state,
            target_url: s.targetUrl ?? null,
            description: s.description ?? null,
            created_at: s.createdAt,
          }))
          .reverse(),
      };
    }
    if (rest === '/actions/runs' && method === 'GET') {
      const sha = query.get('head_sha');
      const runs = repo.workflowRuns.filter((w) => sha === null || w.sha === sha);
      return {
        status: 200,
        body: {
          total_count: runs.length,
          workflow_runs: runs.map((w) => ({
            id: w.id,
            name: w.name,
            head_sha: w.sha,
            check_suite_id: w.checkSuiteId,
            run_attempt: w.runAttempt,
            ...workflowState(repo, w),
          })),
        },
      };
    }
    if (
      (r = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest)) !== null &&
      method === 'POST'
    ) {
      const run = repo.workflowRuns.find((w) => w.id === Number(r?.[1]));
      if (run === undefined) return notFound;
      if (workflowState(repo, run).status !== 'completed')
        return { status: 403, body: { message: 'This workflow is already running' } };
      const failedJobs = newestJobs(repo, run).filter(
        (c) =>
          c.conclusion !== 'success' && c.conclusion !== 'skipped' && c.conclusion !== 'neutral',
      );
      if (failedJobs.length === 0)
        return { status: 403, body: { message: 'This workflow run has no failed jobs' } };
      // As GitHub does: a new attempt, each failed job a new check run, queued.
      run.runAttempt += 1;
      for (const job of failedJobs) {
        repo.checkRuns.push({ ...job, id: nextId++, status: 'queued', conclusion: null });
      }
      return { status: 201, body: {} };
    }
    if ((r = /^\/branches\/(.+)$/.exec(rest)) !== null && method === 'GET') {
      const branch = (r[1] ?? '').split('/').map(decodeURIComponent).join('/');
      const sha = head(repo, branch);
      if (sha === undefined) return { status: 404, body: { message: 'Branch not found' } };
      return { status: 200, body: { name: branch, commit: { sha } } };
    }
    if ((r = /^\/git\/matching-refs\/(.+)$/.exec(rest)) !== null && method === 'GET') {
      const prefix = `refs/${(r[1] ?? '').split('/').map(decodeURIComponent).join('/')}`;
      const refs = git(repo.remote.bareDir, ['for-each-ref', '--format=%(refname) %(objectname)'])
        .split('\n')
        .filter((l) => l.startsWith(prefix))
        .map((l) => {
          const [ref = '', sha = ''] = l.split(' ');
          return { ref, object: { sha, type: 'commit' } };
        });
      return { status: 200, body: refs };
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) !== null && method === 'DELETE') {
      const branch = (r[1] ?? '').split('/').map(decodeURIComponent).join('/');
      const sha = head(repo, branch);
      if (sha === undefined) return { status: 422, body: { message: 'Reference does not exist' } };
      // As GitHub does: an open PR whose head branch is deleted is closed (its SHAs kept).
      for (const pr of repo.pulls) {
        if (pr.head !== branch) continue;
        pr.lastSha = { head: sha, base: head(repo, pr.base) ?? pr.lastSha.base };
        if (pr.state === 'open') pr.state = 'closed';
      }
      git(repo.remote.bareDir, ['update-ref', '-d', `refs/heads/${branch}`]);
      return { status: 204, body: undefined };
    }
    return notFound;
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(text);
  };

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const target = new URL(req.url ?? '/', 'http://fake');
    let body: unknown = undefined;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const method = req.method ?? 'GET';
    const recorded: RecordedRequest = {
      method,
      path: target.pathname + target.search,
      headers,
      body,
      at: Date.now(),
    };
    requests.push(recorded);
    res.on('finish', () => {
      recorded.status = res.statusCode;
    });

    // A forced 304 only ever answers a GET; other faults answer any method.
    const i = faults.findIndex(
      (f) =>
        (f.path === undefined || f.path.test(target.pathname)) &&
        (f.fault.kind !== 'not_modified' || method === 'GET'),
    );
    const fault = i === -1 ? undefined : faults.splice(i, 1)[0]?.fault;
    if (fault !== undefined) {
      switch (fault.kind) {
        case 'network':
          req.socket.destroy();
          return;
        case 'not_modified':
          res.writeHead(304, { etag: headers['if-none-match'] ?? 'W/"simulated"' });
          res.end();
          return;
        case 'rate_limit':
          send(
            res,
            fault.status,
            { message: 'API rate limit exceeded' },
            {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(fault.resetAt.getTime() / 1000)),
            },
          );
          return;
        case 'secondary_rate_limit':
          send(
            res,
            403,
            { message: 'You have exceeded a secondary rate limit.' },
            {
              'retry-after': String(fault.retryAfterSeconds),
            },
          );
          return;
        case 'forbidden':
          send(
            res,
            403,
            { message: 'Resource not accessible by integration' },
            { 'x-ratelimit-remaining': '4999' },
          );
          return;
        case 'server_error':
          send(res, fault.status, { message: 'Server Error' });
          return;
      }
    }
    if (!/^Bearer \S+$/.test(headers['authorization'] ?? '')) {
      send(res, 401, { message: 'Requires authentication' });
      return;
    }
    const reply = route(method, target.pathname, target.searchParams, body);
    if (method === 'GET' && reply.status === 200) {
      const text = JSON.stringify(reply.body);
      const etag = `W/"${createHash('sha1').update(text).digest('hex')}"`;
      if (headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      send(res, 200, reply.body, { etag, 'x-ratelimit-remaining': '4999' });
      return;
    }
    send(res, reply.status, reply.body);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => (raw += d));
    req.on('end', () => {
      try {
        handle(req, res, raw);
      } catch (err) {
        send(res, 500, {
          message: `fake GitHub error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );

  const fake: FakeGitHub = {
    get url() {
      return url;
    },
    requests,
    addRepository(fullName, seed) {
      if (!/^[^/]+\/[^/]+$/.test(fullName))
        throw new Error(`fake GitHub: '${fullName}' is not owner/name`);
      const bareDir = join(tempDir('fake-gh-remote-'), `${fullName.replace('/', '__')}.git`);
      if (seed === undefined) {
        mkdirSync(bareDir, { recursive: true });
        git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main']);
      } else git(dirname(bareDir), ['clone', '--quiet', '--bare', seed, bareDir]);
      const remote: FakeRemote = {
        fullName,
        bareDir,
        remoteUrl: `https://github.com/${fullName}.git`,
      };
      repos.set(fullName.toLowerCase(), {
        remote,
        pulls: [],
        checkRuns: [],
        workflowRuns: [],
        appSuites: new Map(),
        statuses: [],
        refusedMethods: new Set(),
        push: true,
        issues: [],
      });
      return remote;
    },
    gitEnv() {
      const env: Record<string, string> = {};
      const all = [...repos.values()];
      env['GIT_CONFIG_COUNT'] = String(all.length);
      all.forEach((repo, i) => {
        env[`GIT_CONFIG_KEY_${String(i)}`] = `url.${repo.remote.bareDir}.insteadOf`;
        env[`GIT_CONFIG_VALUE_${String(i)}`] = repo.remote.remoteUrl;
      });
      return env;
    },
    branchHead: (fullName, branch) => head(repoOf(fullName), branch),
    pullRequests: (fullName) =>
      repoOf(fullName).pulls.map((p) => ({
        number: p.number,
        state: p.state,
        head: p.head,
        base: p.base,
        body: p.body,
        title: p.title,
        merged: p.mergedAt !== null,
      })),
    setCheckRun(fullName, sha, run) {
      const repo = repoOf(fullName);
      // The newest run of the name: after a re-run, that is the re-run's.
      const existing = repo.checkRuns.findLast((c) => c.sha === sha && c.name === run.name);
      const values = {
        status: run.status,
        conclusion: run.conclusion ?? null,
        detailsUrl: run.detailsUrl ?? null,
        summary: run.summary ?? null,
      };
      if (existing !== undefined) {
        Object.assign(existing, values);
        return;
      }
      const app = run.app ?? 'github-actions';
      let checkSuiteId: number;
      if (app === 'github-actions') {
        const name = run.workflow ?? 'ci';
        let workflow = repo.workflowRuns.find((w) => w.sha === sha && w.name === name);
        if (workflow === undefined) {
          workflow = { id: nextId++, name, sha, checkSuiteId: nextId++, runAttempt: 1 };
          repo.workflowRuns.push(workflow);
        }
        checkSuiteId = workflow.checkSuiteId;
      } else {
        const key = `${sha}:${app}`;
        checkSuiteId = repo.appSuites.get(key) ?? nextId++;
        repo.appSuites.set(key, checkSuiteId);
      }
      repo.checkRuns.push({ id: nextId++, name: run.name, sha, app, checkSuiteId, ...values });
    },
    setStatus(fullName, sha, status) {
      repoOf(fullName).statuses.push({
        ...status,
        id: nextId++,
        sha,
        createdAt: new Date().toISOString(),
      });
    },
    addReview(fullName, number, review) {
      const repo = repoOf(fullName);
      const pr = prOf(fullName, number);
      pr.reviews.push({
        id: nextId++,
        state: review.state,
        body: review.body ?? '',
        author: review.user,
        commitId: review.commitId ?? head(repo, pr.head) ?? '',
        submittedAt: new Date().toISOString(),
      });
    },
    addComment(fullName, number, comment) {
      prOf(fullName, number).comments.push({
        id: nextId++,
        body: comment.body,
        author: comment.user,
        createdAt: new Date().toISOString(),
      });
    },
    addReviewComment(fullName, number, comment) {
      prOf(fullName, number).reviewComments.push({
        id: nextId++,
        body: comment.body,
        author: comment.user,
        path: comment.path,
        createdAt: new Date().toISOString(),
      });
    },
    moveBase(fullName, files) {
      const repo = repoOf(fullName);
      return commitOn(repo, defaultBranch(repo), files, 'Someone else merged a change');
    },
    pushForeignCommit(fullName, branch, files) {
      return commitOn(repoOf(fullName), branch, files, 'A commit the factory did not write');
    },
    forcePushForeignCommit(fullName, branch, files) {
      const repo = repoOf(fullName);
      return commitOn(repo, branch, files, 'A rewrite the factory did not write', {
        from: defaultBranch(repo),
        force: true,
      });
    },
    comments(fullName, number) {
      return prOf(fullName, number).comments.map((c) => ({ author: c.author, body: c.body }));
    },
    closePullRequest(fullName, number) {
      prOf(fullName, number).state = 'closed';
    },
    reopenPullRequest(fullName, number) {
      const pr = prOf(fullName, number);
      if (pr.mergedAt !== null) throw new Error('fake GitHub: a merged PR cannot be reopened');
      pr.state = 'open';
    },
    mergePullRequest(fullName, number, method = 'merge') {
      const done = merge(repoOf(fullName), prOf(fullName, number), method);
      if (!('sha' in done)) {
        throw new Error(
          `fake GitHub: merge failed: ${'error' in done ? done.error : done.notImplemented}`,
        );
      }
      return done.sha;
    },
    setMergeableState(fullName, number, state) {
      prOf(fullName, number).mergeableState = state;
    },
    refuseMergeMethod(fullName, method) {
      repoOf(fullName).refusedMethods.add(method);
    },
    allowMergeMethod(fullName, method) {
      repoOf(fullName).refusedMethods.delete(method);
    },
    refuseReopen(fullName, number) {
      prOf(fullName, number).refuseReopen = true;
    },
    denyPush(fullName, opts) {
      const repo = repoOf(fullName);
      repo.push = opts?.apiStillAllows === true;
      // git's receive-pack runs the hook: the push is refused with GitHub's own words.
      const hook = join(repo.remote.bareDir, 'hooks', 'pre-receive');
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(
        hook,
        `#!/bin/sh\necho "Permission to ${repo.remote.fullName}.git denied to factory-bot." >&2\nexit 1\n`,
        { mode: 0o755 },
      );
    },
    allowPush(fullName) {
      const repo = repoOf(fullName);
      repo.push = true;
      rmSync(join(repo.remote.bareDir, 'hooks', 'pre-receive'), { force: true });
    },
    addIssue(fullName, issue) {
      const repo = repoOf(fullName);
      const number = nextNumber(repo);
      repo.issues.push({
        number,
        title: issue.title,
        body: issue.body ?? null,
        state: 'open',
        labels: [...(issue.labels ?? [])],
      });
      return number;
    },
    setIssueLabels(fullName, number, labels) {
      issueOf(fullName, number).labels = [...labels];
    },
    editIssue(fullName, number, edit) {
      const issue = issueOf(fullName, number);
      if (edit.title !== undefined) issue.title = edit.title;
      if (edit.body !== undefined) issue.body = edit.body;
    },
    closeIssue(fullName, number) {
      issueOf(fullName, number).state = 'closed';
    },
    reopenIssue(fullName, number) {
      issueOf(fullName, number).state = 'open';
    },
    simulate(fault, opts) {
      faults.push({ fault, ...(opts?.path === undefined ? {} : { path: opts.path }) });
    },
  };
  return fake;
}
