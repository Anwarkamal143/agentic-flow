/**
 * The C7 sandbox (#67): setup and cleanup of the one GitHub repository the
 * `[real]` tests may touch, `Anwarkamal143/factory-sandbox` (PROGRESS.md,
 * human answer 4). Test support only, never shipped in the runtime.
 *
 * - **Seed, once.** An empty sandbox (no branches) gets two commits on `main`:
 *   the `tiny-ts` fixture's own, then a minimal GitHub Actions workflow with
 *   the jobs {@link SANDBOX_CHECK} and {@link SANDBOX_RERUN_CHECK}. A sandbox
 *   with branches is never re-seeded, and one whose `main` has no workflow is
 *   refused, changing nothing.
 * - **Keep the workflow current.** A workflow these tests seeded earlier (it
 *   starts with {@link SEED_HEADER}) that differs from today's is replaced by
 *   one fast-forward commit on `main`. Any other workflow is refused, changing
 *   nothing.
 * - **Clean, between runs.** Closes the open PRs the factory opened (a head
 *   branch under `factory/` of the sandbox itself, and a body carrying a
 *   factory marker), then deletes the `factory/*` branches, except one that is
 *   the head of an open PR the factory didn't open.
 *
 * Every API request is scoped to `/repos/<fullName>/`: no other repository is
 * read or written. Git runs with no user or system config, plus `gitEnv`
 * (credentials for the real GitHub, the fake's `insteadOf` rewrites in tests).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carriesFactoryMarker } from '@factory/domain';
import { tinyTsRepo } from './factory.js';

/** The only repository the `[real]` GitHub tests touch. */
export const SANDBOX = 'Anwarkamal143/factory-sandbox';

/** The CI check the sandbox's workflow reports: the C7 Repository's required check. */
export const SANDBOX_CHECK = 'test';

/**
 * The rerun probe's check (#77): it fails the first attempt of its workflow
 * run when the head has {@link RERUN_PROBE_FILE}, and passes otherwise, so a
 * re-run of its failed job passes. Without the file (C7) it always passes.
 */
export const SANDBOX_RERUN_CHECK = 'rerun-probe';
export const RERUN_PROBE_FILE = 'rerun-probe.txt';

export const SANDBOX_WORKFLOW_PATH = '.github/workflows/ci.yml';

/** How every workflow these tests seed starts; only such a workflow is ever replaced. */
const SEED_HEADER = "# Seeded by the Software Factory's";

const WORKFLOW = `${SEED_HEADER} [real] tests (tests/support/sandbox.ts).
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ${SANDBOX_CHECK}:
    name: ${SANDBOX_CHECK}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-audit --no-fund
      - run: npm run typecheck
      - run: npm test
  ${SANDBOX_RERUN_CHECK}:
    name: ${SANDBOX_RERUN_CHECK}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fail the first attempt when the rerun probe is present
        env:
          RUN_ATTEMPT: \${{ github.run_attempt }}
        run: |
          if [ -f ${RERUN_PROBE_FILE} ] && [ "$RUN_ATTEMPT" = "1" ]; then
            echo "${RERUN_PROBE_FILE} is present: failing attempt 1 on purpose"
            exit 1
          fi
`;

export interface SandboxOptions {
  /** `owner/name`. */
  fullName: string;
  apiBaseUrl: string;
  /** The token, read for each request; never printed. */
  token: () => string;
  /** Extra git environment (`GIT_CONFIG_COUNT` entries): credentials, or the fake's rewrites. */
  gitEnv: Record<string, string>;
  /** A scratch directory for the checkout. */
  workDir: string;
}

export interface PreparedSandbox {
  /** A checkout of the sandbox with `origin` at its github.com URL, on `main`. */
  checkout: string;
  seeded: boolean;
  /** `main`'s workflow was one these tests seeded earlier, and was brought up to date. */
  workflowUpdated: boolean;
  cleaned: { closed: number[]; deleted: string[] };
}

interface PullJson {
  number: number;
  body: string | null;
  head: { ref: string; repo: { full_name: string } | null };
}

const FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export async function prepareSandbox(opts: SandboxOptions): Promise<PreparedSandbox> {
  if (!FULL_NAME.test(opts.fullName) || opts.fullName.split('/')[1]?.startsWith('.') === true)
    throw new Error(`sandbox: '${opts.fullName}' is not owner/name`);
  const url = `https://github.com/${opts.fullName}.git`;
  const run = (cwd: string, args: string[]) => gitWith(opts.gitEnv, cwd, args);

  const seeded = run(opts.workDir, ['ls-remote', '--heads', url]).trim() === '';
  if (seeded) seed(opts, url);

  const checkout = join(opts.workDir, 'checkout');
  run(opts.workDir, ['clone', '--quiet', '--branch', 'main', url, checkout]);
  const workflowFile = join(checkout, SANDBOX_WORKFLOW_PATH);
  if (!existsSync(workflowFile))
    throw new Error(
      `precondition: ${opts.fullName} main has no ${SANDBOX_WORKFLOW_PATH}; it is not a sandbox this test seeded, and is left as it is`,
    );
  const current = readFileSync(workflowFile, 'utf8');
  if (!current.startsWith(SEED_HEADER))
    throw new Error(
      `precondition: ${opts.fullName} main's ${SANDBOX_WORKFLOW_PATH} is not one these tests seeded; it is left as it is`,
    );
  const workflowUpdated = current !== WORKFLOW;
  if (workflowUpdated) {
    writeFileSync(workflowFile, WORKFLOW);
    run(checkout, ['add', SANDBOX_WORKFLOW_PATH]);
    run(checkout, [
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '--message',
      'ci: update the sandbox workflow',
    ]);
    // A fast-forward only: a main that moved meanwhile refuses the push.
    run(checkout, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  }

  const cleaned = await clean(opts);
  return { checkout, seeded, workflowUpdated, cleaned };
}

function seed(opts: SandboxOptions, url: string) {
  const dir = tinyTsRepo();
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, SANDBOX_WORKFLOW_PATH), WORKFLOW);
  const run = (args: string[]) => gitWith(opts.gitEnv, dir, args);
  run(['add', '--all']);
  run(['commit', '--quiet', '--no-gpg-sign', '--message', 'ci: run typecheck and tests']);
  run(['push', '--quiet', url, 'HEAD:refs/heads/main']);
}

async function clean(opts: SandboxOptions): Promise<PreparedSandbox['cleaned']> {
  const api = sandboxApi(opts);
  const open = await api<PullJson[]>('GET', '/pulls?state=open&per_page=100');
  // One page only: a full page may hide an unmarked PR whose branch must be kept.
  if (open.length >= 100)
    throw new Error(
      `sandbox: ${opts.fullName} has 100 or more open PRs; clean it by hand, nothing was changed`,
    );
  const ours = (p: PullJson) =>
    p.head.ref.startsWith('factory/') &&
    p.head.repo?.full_name.toLowerCase() === opts.fullName.toLowerCase() &&
    carriesFactoryMarker(p.body ?? '');
  const closed: number[] = [];
  for (const p of open.filter(ours)) {
    await api('PATCH', `/pulls/${String(p.number)}`, { state: 'closed' });
    closed.push(p.number);
  }
  const kept = new Set(open.filter((p) => !ours(p)).map((p) => p.head.ref));
  const refs = await api<{ ref: string }[]>('GET', '/git/matching-refs/heads/factory/');
  const deleted: string[] = [];
  for (const { ref } of refs) {
    const branch = ref.replace(/^refs\/heads\//, '');
    if (!branch.startsWith('factory/') || kept.has(branch)) continue;
    await api('DELETE', `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    deleted.push(branch);
  }
  return { closed, deleted };
}

/** A REST client that can only reach `/repos/<fullName>/…`. */
export function sandboxApi(opts: Pick<SandboxOptions, 'fullName' | 'apiBaseUrl' | 'token'>) {
  const prefix = `/repos/${opts.fullName}`;
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${opts.apiBaseUrl.replace(/\/$/, '')}${prefix}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok)
      throw new Error(`sandbox: ${method} ${prefix}${path} answered ${String(res.status)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}

/** git with no user or system config, plus `extra` (as `tests/support/factory.ts` `git`). */
export function gitWith(extra: Record<string, string>, cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Factory C7',
      GIT_AUTHOR_EMAIL: 'c7@factory.invalid',
      GIT_COMMITTER_NAME: 'Factory C7',
      GIT_COMMITTER_EMAIL: 'c7@factory.invalid',
      ...extra,
    },
  });
}
