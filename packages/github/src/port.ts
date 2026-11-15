/**
 * The GitHub port (ADR-0033): GitHub's REST API over `fetch`, at a
 * configurable API base URL (`https://api.github.com` by default; tests point
 * it at the fake GitHub). Pushing is not here: the factory pushes with git
 * from the Factory Clone.
 *
 * - Every polled read takes an optional ETag, sends it as `If-None-Match`,
 *   and returns `notModified` on a 304 (the recovery lookup by head branch
 *   takes none).
 * - Every failure is classified as `rate_limited` (with the reset time),
 *   `transient` (a 5xx or a network error: retry with backoff) or `refused`
 *   (any other 4xx, or a token reference that doesn't resolve: retrying won't
 *   help). The port never retries on its own; callers decide.
 * - A rate limit pauses every call (ADR-0045): with a {@link RateLimitGate},
 *   each rate-limit response is reported to it, and while it holds a pause no
 *   request is sent; the call fails `rate_limited` until the reset at once.
 * - The token is resolved for each request and is never part of a result.
 * - Response bodies are validated; text in them (bodies, comments, messages)
 *   is GitHub content and untrusted.
 */
import type { GitHubCoordinates } from '@factory/domain';
import { z } from 'zod';
import type { TokenResolution } from './token.js';

export type GitHubFailure =
  | { kind: 'rate_limited'; status: number; resetAt: string }
  | { kind: 'transient'; status: number | null; reason: string }
  | { kind: 'refused'; status: number | null; reason: string };

export type GitHubResult<T> = { ok: true; value: T } | { ok: false; failure: GitHubFailure };

export type GitHubRead<T> =
  | { ok: true; notModified: false; value: T; etag: string | null }
  | { ok: true; notModified: true; etag: string }
  | { ok: false; failure: GitHubFailure };

export interface ReadOptions {
  /** The ETag of the last representation seen; a 304 then returns `notModified`. */
  etag?: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PullRequest {
  number: number;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  /** GitHub's `mergeable_state` (`clean`, `blocked`, `dirty`, …). Only a single-PR read has it. */
  mergeableState: string | null;
  title: string;
  body: string | null;
  author: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  /** `output.summary`, or `output.title` when it has none: CI text, untrusted. */
  summary: string | null;
}

export interface CommitStatus {
  id: number;
  context: string;
  state: string;
  targetUrl: string | null;
  description: string | null;
}

export interface Review {
  id: number;
  state: string;
  body: string;
  author: string | null;
  commitId: string | null;
  submittedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  author: string | null;
  createdAt: string;
  htmlUrl: string | null;
}

export interface ReviewComment extends Comment {
  path: string | null;
}

/** The GitHub-wide pause a rate limit sets (ADR-0045), kept by the caller. */
export interface RateLimitGate {
  /** The pause in force, or null: while `until` is in the future, no request is sent. */
  current(): { until: string; status: number } | null;
  /** GitHub answered a request with a rate limit. */
  limited(limit: { status: number; resetAt: string }): void;
}

/** Whether `pause` still holds at `now`: no request is sent before its `until`. */
export function pauseInForce(pause: { until: string } | null, now = Date.now()): boolean {
  return pause !== null && Date.parse(pause.until) > now;
}

export interface GitHubPortOptions {
  /** The REST API base: `https://api.github.com` for github.com. */
  apiBaseUrl: string;
  /** Resolves the token reference; called once per request. */
  token: () => Promise<TokenResolution>;
  /** Per-request limit; a request that takes longer is a transient failure. */
  timeoutMs?: number;
  /** The GitHub-wide pause; without one, each call is sent whatever came before. */
  rateLimit?: RateLimitGate;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Lists are read as one page of up to 100 (ADR-0033). */
const PER_PAGE = 100;
/** A rate limit with no reset header waits this long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

// ---- GitHub's representations: the fields the port reads, nothing else ----

const user = z.object({ login: z.string() }).nullable().optional();
const prWire = z.object({
  number: z.number().int(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable().optional(),
  user,
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  mergeable_state: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
});
const checkRunsWire = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      output: z
        .object({
          title: z.string().nullable().optional(),
          summary: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
});
const statusesWire = z.array(
  z.object({
    id: z.number().int(),
    context: z.string(),
    state: z.string(),
    target_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
);
const reviewsWire = z.array(
  z.object({
    id: z.number().int(),
    state: z.string(),
    body: z.string().nullable().optional(),
    user,
    commit_id: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
  }),
);
const commentWire = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  user,
  created_at: z.string(),
  html_url: z.string().nullable().optional(),
});
const reviewCommentWire = commentWire.extend({ path: z.string().nullable().optional() });
const branchWire = z.object({ commit: z.object({ sha: z.string() }) });
const mergeWire = z.object({ sha: z.string() });
const messageWire = z.object({ message: z.string() });

function toPullRequest(w: z.infer<typeof prWire>): PullRequest {
  return {
    number: w.number,
    htmlUrl: w.html_url,
    state: w.state,
    merged: w.merged ?? (w.merged_at !== null && w.merged_at !== undefined),
    mergeCommitSha: w.merge_commit_sha ?? null,
    mergeableState: w.mergeable_state ?? null,
    title: w.title,
    body: w.body ?? null,
    author: w.user?.login ?? null,
    head: { ref: w.head.ref, sha: w.head.sha },
    base: { ref: w.base.ref, sha: w.base.sha },
  };
}

function toComment(w: z.infer<typeof commentWire>): Comment {
  return {
    id: w.id,
    body: w.body ?? '',
    author: w.user?.login ?? null,
    createdAt: w.created_at,
    htmlUrl: w.html_url ?? null,
  };
}

type Raw =
  | { ok: true; status: number; body: unknown; etag: string | null }
  | { ok: true; status: 304; notModified: true; etag: string }
  | { ok: false; failure: GitHubFailure };

export class GitHubPort {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GitHubPortOptions) {
    this.base = opts.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---- pull requests ----

  /**
   * The PR (open or closed) whose head is `branch` in the same repository, or
   * null. A lookup for recovery, never polled, so it takes no ETag.
   */
  async findPullRequestByHead(
    repo: GitHubCoordinates,
    branch: string,
  ): Promise<GitHubResult<PullRequest | null>> {
    const query = new URLSearchParams({
      head: `${repo.owner}:${branch}`,
      state: 'all',
      per_page: String(PER_PAGE),
    });
    const res = await this.send('GET', `${repoPath(repo)}/pulls?${query.toString()}`);
    return mapResult(res, z.array(prWire), (prs) => {
      const pr = prs.find((p) => p.head.ref === branch);
      return pr === undefined ? null : toPullRequest(pr);
    });
  }

  async createPullRequest(
    repo: GitHubCoordinates,
    pr: { title: string; body: string; head: string; base: string },
  ): Promise<GitHubResult<PullRequest>> {
    const res = await this.send('POST', `${repoPath(repo)}/pulls`, pr);
    return mapResult(res, prWire, toPullRequest);
  }

  async updatePullRequest(
    repo: GitHubCoordinates,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed' },
  ): Promise<GitHubResult<PullRequest>> {
    const res = await this.send('PATCH', `${repoPath(repo)}/pulls/${String(number)}`, patch);
    return mapResult(res, prWire, toPullRequest);
  }

  reopenPullRequest(repo: GitHubCoordinates, number: number): Promise<GitHubResult<PullRequest>> {
    return this.updatePullRequest(repo, number, { state: 'open' });
  }

  /** Merges only if the head is still `sha` (GitHub answers 409 otherwise). */
  async mergePullRequest(
    repo: GitHubCoordinates,
    number: number,
    merge: { method: MergeMethod; sha: string },
  ): Promise<GitHubResult<{ sha: string }>> {
    const res = await this.send('PUT', `${repoPath(repo)}/pulls/${String(number)}/merge`, {
      merge_method: merge.method,
      sha: merge.sha,
    });
    return mapResult(res, mergeWire, (m) => ({ sha: m.sha }));
  }

  async getPullRequest(
    repo: GitHubCoordinates,
    number: number,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<PullRequest>> {
    const res = await this.read(`${repoPath(repo)}/pulls/${String(number)}`, opts);
    return mapRead(res, prWire, toPullRequest);
  }

  // ---- checks ----

  async listCheckRuns(
    repo: GitHubCoordinates,
    sha: string,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<CheckRun[]>> {
    const res = await this.read(
      `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${String(PER_PAGE)}`,
      opts,
    );
    return mapRead(res, checkRunsWire, (w) =>
      w.check_runs.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion ?? null,
        detailsUrl: c.details_url ?? null,
        summary: c.output?.summary ?? c.output?.title ?? null,
      })),
    );
  }

  /** Every status reported for `sha`, newest first (GitHub's order). */
  async listCommitStatuses(
    repo: GitHubCoordinates,
    sha: string,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<CommitStatus[]>> {
    const res = await this.read(
      `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/statuses?per_page=${String(PER_PAGE)}`,
      opts,
    );
    return mapRead(res, statusesWire, (w) =>
      w.map((s) => ({
        id: s.id,
        context: s.context,
        state: s.state,
        targetUrl: s.target_url ?? null,
        description: s.description ?? null,
      })),
    );
  }

  async rerunCheckRun(repo: GitHubCoordinates, checkRunId: number): Promise<GitHubResult<null>> {
    const res = await this.send(
      'POST',
      `${repoPath(repo)}/check-runs/${String(checkRunId)}/rerequest`,
    );
    return res.ok ? { ok: true, value: null } : res;
  }

  // ---- reviews and comments ----

  async listReviews(
    repo: GitHubCoordinates,
    number: number,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<Review[]>> {
    const res = await this.read(
      `${repoPath(repo)}/pulls/${String(number)}/reviews?per_page=${String(PER_PAGE)}`,
      opts,
    );
    return mapRead(res, reviewsWire, (w) =>
      w.map((r) => ({
        id: r.id,
        state: r.state,
        body: r.body ?? '',
        author: r.user?.login ?? null,
        commitId: r.commit_id ?? null,
        submittedAt: r.submitted_at ?? null,
      })),
    );
  }

  /** The PR's conversation comments (GitHub's issue comments). */
  async listIssueComments(
    repo: GitHubCoordinates,
    number: number,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<Comment[]>> {
    const res = await this.read(
      `${repoPath(repo)}/issues/${String(number)}/comments?per_page=${String(PER_PAGE)}`,
      opts,
    );
    return mapRead(res, z.array(commentWire), (w) => w.map(toComment));
  }

  /** Comments on lines of the PR's diff. */
  async listReviewComments(
    repo: GitHubCoordinates,
    number: number,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<ReviewComment[]>> {
    const res = await this.read(
      `${repoPath(repo)}/pulls/${String(number)}/comments?per_page=${String(PER_PAGE)}`,
      opts,
    );
    return mapRead(res, z.array(reviewCommentWire), (w) =>
      w.map((c) => ({ ...toComment(c), path: c.path ?? null })),
    );
  }

  async createComment(
    repo: GitHubCoordinates,
    number: number,
    body: string,
  ): Promise<GitHubResult<Comment>> {
    const res = await this.send('POST', `${repoPath(repo)}/issues/${String(number)}/comments`, {
      body,
    });
    return mapResult(res, commentWire, toComment);
  }

  // ---- branches ----

  async getBranchHead(
    repo: GitHubCoordinates,
    branch: string,
    opts: ReadOptions = {},
  ): Promise<GitHubRead<string>> {
    const name = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.read(`${repoPath(repo)}/branches/${name}`, opts);
    return mapRead(res, branchWire, (b) => b.commit.sha);
  }

  /**
   * Deletes `branch` on GitHub (a cancel cleanup's explicit "delete the remote
   * branch", ADR-0043). `gone: true` when it was already gone (GitHub answers
   * 422 "Reference does not exist"). GitHub closes an open PR whose head it was.
   */
  async deleteBranch(
    repo: GitHubCoordinates,
    branch: string,
  ): Promise<GitHubResult<{ gone: boolean }>> {
    const name = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.send('DELETE', `${repoPath(repo)}/git/refs/heads/${name}`);
    if (res.ok) return { ok: true, value: { gone: false } };
    const { failure } = res;
    if (
      failure.kind === 'refused' &&
      (failure.status === 404 ||
        (failure.status === 422 && /reference does not exist/i.test(failure.reason)))
    ) {
      return { ok: true, value: { gone: true } };
    }
    return res;
  }

  // ---- transport ----

  private read(path: string, opts: ReadOptions): Promise<Raw> {
    return this.request('GET', path, undefined, opts.etag);
  }

  /** A request without a conditional ETag: every write, and the recovery lookup. */
  private send(method: string, path: string, body?: unknown): Promise<Raw> {
    return this.request(method, path, body, undefined);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    etag: string | undefined,
  ): Promise<Raw> {
    const paused = this.opts.rateLimit?.current() ?? null;
    if (paused !== null && pauseInForce(paused)) {
      return {
        ok: false,
        failure: { kind: 'rate_limited', status: paused.status, resetAt: paused.until },
      };
    }
    const token = await this.opts.token();
    if (!token.ok) {
      return {
        ok: false,
        failure: {
          kind: 'refused',
          status: null,
          reason: `the GitHub token reference does not resolve: ${token.problem}`,
        },
      };
    }
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'software-factory',
    };
    if (etag !== undefined) headers['if-none-match'] = etag;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    let text: string;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      text = await res.text();
    } catch (err) {
      // Never the request (it holds the token): only why the connection failed.
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no response within ${String(this.timeoutMs / 1000)}s`
          : `network error: ${networkReason(err)}`;
      return { ok: false, failure: { kind: 'transient', status: null, reason } };
    }
    if (res.status === 304) {
      return {
        ok: true,
        status: 304,
        notModified: true,
        etag: res.headers.get('etag') ?? etag ?? '',
      };
    }
    if (res.ok) {
      let parsed: unknown = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          return unexpectedResult(res.status, 'the body is not JSON');
        }
      }
      return { ok: true, status: res.status, body: parsed, etag: res.headers.get('etag') };
    }
    const failure = classify(res.status, res.headers, text, Date.now());
    if (failure.kind === 'rate_limited') {
      this.opts.rateLimit?.limited({ status: failure.status, resetAt: failure.resetAt });
    }
    return { ok: false, failure };
  }
}

/** A non-2xx, non-304 response, classified (ADR-0033). */
function classify(status: number, headers: Headers, text: string, now: number): GitHubFailure {
  const reason = messageOf(text) ?? `HTTP ${String(status)}`;
  const remaining = headers.get('x-ratelimit-remaining');
  const retryAfter = headers.get('retry-after');
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter !== null))) {
    return { kind: 'rate_limited', status, resetAt: resetTime(headers, now) };
  }
  if (status >= 500) return { kind: 'transient', status, reason };
  return { kind: 'refused', status, reason };
}

function resetTime(headers: Headers, now: number): string {
  const retryAfter = Number(headers.get('retry-after') ?? NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(now + retryAfter * 1000).toISOString();
  }
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN);
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  return new Date(now + DEFAULT_RATE_LIMIT_WAIT_MS).toISOString();
}

function messageOf(text: string): string | undefined {
  try {
    const parsed = messageWire.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.message.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

function networkReason(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  if (typeof cause?.code === 'string') return cause.code;
  return err instanceof Error ? err.message : String(err);
}

function mapResult<W, T>(res: Raw, schema: z.ZodType<W>, map: (w: W) => T): GitHubResult<T> {
  if (!res.ok) return res;
  if ('notModified' in res) return unexpectedResult(304, 'not modified on a write');
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) return unexpectedResult(res.status, 'the body has an unexpected shape');
  return { ok: true, value: map(parsed.data) };
}

function mapRead<W, T>(res: Raw, schema: z.ZodType<W>, map: (w: W) => T): GitHubRead<T> {
  if (!res.ok) return res;
  if ('notModified' in res) return { ok: true, notModified: true, etag: res.etag };
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) return unexpectedResult(res.status, 'the body has an unexpected shape');
  return { ok: true, notModified: false, value: map(parsed.data), etag: res.etag };
}

function unexpectedResult(status: number, why: string): { ok: false; failure: GitHubFailure } {
  return {
    ok: false,
    failure: { kind: 'refused', status, reason: `unexpected response from GitHub: ${why}` },
  };
}

function repoPath(repo: GitHubCoordinates): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
