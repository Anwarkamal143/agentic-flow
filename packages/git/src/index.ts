/**
 * Local git operations. Every function that touches a user's checkout is
 * read-only: it uses plumbing that never refreshes the index or takes locks
 * (`GIT_OPTIONAL_LOCKS=0`), and never runs `status`, `fetch` or `gc` there.
 */
import { execFile, spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    /** What git printed before it failed (some commands, like `merge-tree`, report through it). */
    readonly stdout = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const TIMEOUT_MS = 10 * 60_000;

/**
 * Git's environment: the runtime's own (so the operator's SSH agent and
 * credential helpers work for clones), never prompting for input.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * The environment of the factory's git calls inside a Worktree, whose `.git`
 * config a Harness may have changed: none of the runtime's own variables (so
 * no secrets), and no user or system git config.
 */
function worktreeGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

export function git(
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? gitEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(stdout);
          return;
        }
        const code = typeof err.code === 'number' ? err.code : null;
        const detail = redactUrlCredentials(stderr.trim().split('\n').at(-1) ?? err.message);
        reject(
          new GitError(
            `git ${args[0] ?? ''} failed: ${detail}`,
            args.map(redactUrlCredentials),
            code,
            redactUrlCredentials(stderr),
            redactUrlCredentials(stdout),
          ),
        );
      },
    );
  });
}

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * True when a URL carries userinfo for a password-capable scheme
 * (`https://token@host/…`, `https://user:pass@host/…`). `ssh://git@host` and
 * scp-style `git@host:path` name a user, not a secret, and are not flagged.
 */
export function hasEmbeddedCredentials(url: string): boolean {
  return /^(https?|ftps?):\/\/[^/@\s]+@/i.test(url);
}

/** Replaces any `scheme://userinfo@` with `scheme://***@`, so no credential is echoed. */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO, '$1***@');
}

/** The working tree root containing `path`, or undefined if it is not inside a git working tree. */
export async function workTreeRoot(path: string): Promise<string | undefined> {
  try {
    const inside = (await git(['-C', path, 'rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return undefined;
    return (await git(['-C', path, 'rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    if (err instanceof GitError) return undefined;
    throw err;
  }
}

/** The URL of the `origin` remote, or undefined when there is none. */
export async function originUrl(repo: string): Promise<string | undefined> {
  try {
    const url = (await git(['-C', repo, 'config', '--get', 'remote.origin.url'])).trim();
    return url === '' ? undefined : url;
  } catch (err) {
    // `git config --get` exits 1 when the key is unset.
    if (err instanceof GitError && err.exitCode === 1) return undefined;
    throw err;
  }
}

/**
 * Clones `from` into `dest` (which must not exist).
 *
 * With `reference`, objects already present in that local repository are
 * borrowed during the clone and then copied (`--dissociate`), so the result
 * never depends on the reference repository afterwards: a `git gc` there can't
 * break it. Without a reference, a local path is copied, never hard-linked.
 */
export async function clone(opts: {
  from: string;
  dest: string;
  reference?: string;
}): Promise<void> {
  const args = ['clone', '--quiet', '--no-hardlinks'];
  if (opts.reference !== undefined) args.push('--reference', opts.reference, '--dissociate');
  args.push('--', opts.from, opts.dest);
  await git(args);
}

/** The branch checked out in `repo` (after a clone: the remote's default branch). */
export async function currentBranch(repo: string): Promise<string> {
  return (await git(['-C', repo, 'symbolic-ref', '--short', 'HEAD'])).trim();
}

// ---- Factory Clone and Worktree operations ----------------------------------
// These run only in the factory's own clone and its Worktrees, never in a source checkout.
// A Harness can change a Worktree's shared `.git` config, so every factory git call in
// the Factory Clone or a Worktree disables hooks and fsmonitor, and (except fetch) runs
// with no secrets in its environment in case another configured driver runs.

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function worktreeGit(worktree: string, args: readonly string[]): Promise<string> {
  return git(['-C', worktree, ...NO_HOOKS, ...args], { env: worktreeGitEnv() });
}

/** Fetch keeps the runtime's environment (SSH agent, credential helpers), but runs no hooks. */
function fetchGit(repo: string, args: readonly string[]): Promise<string> {
  return git(['-C', repo, ...NO_HOOKS, ...args]);
}

/** The identity of commits the factory itself makes (WIP commits). */
export const FACTORY_COMMITTER = { name: 'Software Factory', email: 'factory@factory.invalid' };

/** Fetches every branch of `remote` into `refs/remotes/<remote>/*`. */
export async function fetchRemote(repo: string, remote = 'origin'): Promise<void> {
  await fetchGit(repo, ['fetch', '--quiet', '--prune', remote]);
}

/** The full SHA `rev` names, or undefined when it names no commit. */
export async function resolveCommit(repo: string, rev: string): Promise<string | undefined> {
  try {
    return (
      await worktreeGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    ).trim();
  } catch (err) {
    if (err instanceof GitError) return undefined;
    throw err;
  }
}

/** Creates `branch` at `startSha` and checks it out in a new Worktree at `path`. */
export async function addWorktree(opts: {
  repo: string;
  path: string;
  branch: string;
  startSha: string;
  /** Point `branch` at `startSha` even when it exists (`-B`); else git refuses an existing branch. */
  resetBranch?: boolean;
}): Promise<void> {
  await worktreeGit(opts.repo, [
    'worktree',
    'add',
    '--quiet',
    opts.resetBranch === true ? '-B' : '-b',
    opts.branch,
    '--',
    opts.path,
    opts.startSha,
  ]);
}

/**
 * Frees `branch` for a new Worktree: every Worktree of `repo` that has it
 * checked out is detached at the same commit (its files and commits stay as
 * they are), and the records of Worktrees whose directory is gone are pruned.
 * Returns the paths that were detached.
 */
export async function releaseBranch(repo: string, branch: string): Promise<string[]> {
  const out = await worktreeGit(repo, ['worktree', 'list', '--porcelain']);
  const holders: { path: string; prunable: boolean }[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || !lines.includes(`branch refs/heads/${branch}`)) continue;
    holders.push({ path, prunable: lines.some((l) => l.startsWith('prunable')) });
  }
  if (holders.some((h) => h.prunable)) await worktreeGit(repo, ['worktree', 'prune']);
  const detached: string[] = [];
  for (const h of holders.filter((x) => !x.prunable)) {
    await worktreeGit(h.path, ['checkout', '--quiet', '--detach']);
    detached.push(h.path);
  }
  return detached;
}

/**
 * Removes a Worktree; its branch stays. Never forced: git refuses when the
 * Worktree has changes that are neither committed nor ignored.
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await worktreeGit(repo, ['worktree', 'remove', '--', path]);
}

/** Paths with uncommitted changes (tracked or untracked, not ignored). */
export async function uncommittedPaths(worktree: string): Promise<string[]> {
  const out = await worktreeGit(worktree, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const paths: string[] = [];
  const entries = out.split('\0').filter((e) => e !== '');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    paths.push(entry.slice(3));
    // A rename or copy is followed by its source path.
    if (entry.startsWith('R') || entry.startsWith('C')) i++;
  }
  return paths;
}

/**
 * Commits every uncommitted change in the Worktree as the factory, without
 * running the repository's hooks or signing. Returns the new commit's SHA.
 */
export async function commitAll(worktree: string, message: string): Promise<string> {
  await worktreeGit(worktree, ['add', '--all']);
  await worktreeGit(worktree, [
    '-c',
    `user.name=${FACTORY_COMMITTER.name}`,
    '-c',
    `user.email=${FACTORY_COMMITTER.email}`,
    'commit',
    '--quiet',
    '--no-verify',
    '--no-gpg-sign',
    '--message',
    message,
  ]);
  return (await worktreeGit(worktree, ['rev-parse', 'HEAD'])).trim();
}

/** The commits in `base..head`, newest first, with their subjects. */
export async function commitsBetween(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
  const out = await worktreeGit(repo, ['log', '--format=%H%x00%s', `${base}..${head}`]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sha = '', subject = ''] = l.split('\0');
      return { sha, subject };
    });
}

/**
 * The commits reachable from `head` but not from `base` (`base..head`, so
 * `base` need not be an ancestor), newest first, with each one's author name.
 * Used to list the commits someone else pushed (ADR-0042).
 */
export async function authoredCommitsBetween(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string; author: string }[]> {
  const out = await worktreeGit(repo, ['log', '--format=%H%x00%s%x00%an', `${base}..${head}`]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sha = '', subject = '', author = ''] = l.split('\0');
      return { sha, subject, author };
    });
}

/** The tree SHA of the commit `sha`. */
export async function treeOf(repo: string, sha: string): Promise<string> {
  return (await worktreeGit(repo, ['rev-parse', '--verify', `${sha}^{tree}`])).trim();
}

/** Paths changed between two commits. */
export async function changedPaths(repo: string, base: string, head: string): Promise<string[]> {
  const out = await worktreeGit(repo, ['diff', '--name-only', '-z', `${base}..${head}`]);
  return out.split('\0').filter((p) => p !== '');
}

/**
 * Every path changed between two commits, with how. Renames and copies are
 * off (`--no-renames`), so a rename is its old path `deleted` and its new
 * path `added`: a scope check sees both.
 */
export async function changedPathKinds(
  repo: string,
  base: string,
  head: string,
): Promise<{ path: string; kind: 'added' | 'modified' | 'deleted' | 'type_changed' }[]> {
  const out = await worktreeGit(repo, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${base}..${head}`,
  ]);
  const fields = out.split('\0').filter((p) => p !== '');
  const changes: { path: string; kind: 'added' | 'modified' | 'deleted' | 'type_changed' }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? '';
    const path = fields[i + 1] ?? '';
    const kind =
      status === 'A'
        ? 'added'
        : status === 'D'
          ? 'deleted'
          : status === 'T'
            ? 'type_changed'
            : 'modified';
    changes.push({ path, kind });
  }
  return changes;
}

/**
 * Merges two commits without a Worktree or an index (`git merge-tree
 * --write-tree`): the merged tree, or the conflicting paths. Only objects are
 * written; no ref, index or working tree changes.
 */
export async function mergeCommits(
  repo: string,
  ours: string,
  theirs: string,
): Promise<{ kind: 'merged'; tree: string } | { kind: 'conflict'; paths: string[] }> {
  const args = ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', ours, theirs];
  try {
    const out = await worktreeGit(repo, args);
    return { kind: 'merged', tree: (out.split('\0')[0] ?? '').trim() };
  } catch (err) {
    // Exit 1 is a conflict: stdout is the tree, then the conflicting paths.
    if (err instanceof GitError && err.exitCode === 1) {
      const paths = err.stdout.split('\0').slice(1);
      return { kind: 'conflict', paths: [...new Set(paths.filter((p) => p !== ''))] };
    }
    throw err;
  }
}

/** Makes a commit of `tree` with `parents`, as the factory. No ref moves. */
export async function commitTree(
  repo: string,
  tree: string,
  parents: readonly string[],
  message: string,
): Promise<string> {
  const out = await git(
    [
      '-C',
      repo,
      ...NO_HOOKS,
      'commit-tree',
      tree,
      ...parents.flatMap((p) => ['-p', p]),
      '-m',
      message,
    ],
    {
      env: {
        ...worktreeGitEnv(),
        GIT_AUTHOR_NAME: FACTORY_COMMITTER.name,
        GIT_AUTHOR_EMAIL: FACTORY_COMMITTER.email,
        GIT_COMMITTER_NAME: FACTORY_COMMITTER.name,
        GIT_COMMITTER_EMAIL: FACTORY_COMMITTER.email,
      },
    },
  );
  return out.trim();
}

/** Points `ref` (a full ref name, such as `refs/factory/attempts/<id>`) at `sha`. */
export async function updateRef(repo: string, ref: string, sha: string): Promise<void> {
  await worktreeGit(repo, ['update-ref', ref, sha]);
}

/** The repository's `info/exclude` file (shared by all its Worktrees). */
export async function infoExcludePath(repo: string): Promise<string> {
  const common = (
    await worktreeGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  return `${common}/info/exclude`;
}

/**
 * The patch `base..head`, cut at `maxBytes`. External diff drivers and
 * textconv filters are off: a Worktree's config is untrusted.
 */
export async function diffBetween(
  repo: string,
  base: string,
  head: string,
  maxBytes: number,
): Promise<{ patch: string; truncated: boolean }> {
  const out = await worktreeGit(repo, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `${base}..${head}`,
  ]);
  const bytes = Buffer.from(out, 'utf8');
  if (bytes.length <= maxBytes) return { patch: out, truncated: false };
  return { patch: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/** Whether `ancestor` is reachable from `descendant` (equal counts). */
export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await worktreeGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}

/**
 * `git patch-id --stable` of the diff from the merge-base of `base` and `head`
 * to `head` (ADR-0041): equal for two diffs that change the same lines the same
 * way, whatever their line numbers. `null` for an empty diff. External diff
 * drivers and textconv filters are off.
 */
export async function diffPatchId(
  repo: string,
  base: string,
  head: string,
): Promise<string | null> {
  const mergeBase = (await worktreeGit(repo, ['merge-base', base, head])).trim();
  const diff = await worktreeGit(repo, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--full-index',
    `${mergeBase}..${head}`,
  ]);
  if (diff === '') return null;
  // `patch-id` wants a commit-like header line before the diff; any SHA does.
  const out = await withInput(repo, ['patch-id', '--stable'], `commit ${head}\n${diff}`);
  return out.trim().split(/\s+/)[0] || null;
}

/** Runs `git <command>` in `repo` with `input` on its stdin, in the Worktree environment; resolves with stdout. */
function withInput(repo: string, command: readonly string[], input: string): Promise<string> {
  const args = ['-C', repo, ...NO_HOOKS, ...command];
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: worktreeGitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new GitError(
            `git ${command[0] ?? ''} failed: ${stderr.trim()}`,
            [...args],
            code,
            stderr,
            stdout,
          ),
        );
    });
    child.stdin.end(input);
  });
}

/**
 * Moves the branch checked out in `worktree` to `sha` and its files with it
 * (`reset --keep`): git refuses when a file with uncommitted changes would be
 * overwritten, so no work is discarded. Used to fast-forward the Integration
 * Branch onto the factory's own base merge-in commit (ADR-0041).
 */
export async function resetWorktreeTo(worktree: string, sha: string): Promise<void> {
  await worktreeGit(worktree, ['reset', '--quiet', '--keep', sha]);
}

/**
 * The commit `branch` points at on the remote `url` (`git ls-remote`), without
 * fetching into `repo`; `undefined` when the remote has no such branch. Runs
 * with the runtime's environment, so git's own credentials work, and no hooks.
 */
export async function remoteBranchHead(
  repo: string,
  url: string,
  branch: string,
): Promise<string | undefined> {
  const out = await git(['-C', repo, ...NO_HOOKS, 'ls-remote', url, `refs/heads/${branch}`]);
  const [sha] = out.trim().split(/\s+/);
  return sha === undefined || sha === '' ? undefined : sha;
}

/**
 * Fetches `branch` of the remote `url` into `repo`'s object store (no ref is
 * written but `FETCH_HEAD`) and returns the commit it points at; `undefined`
 * when the remote has no such branch. Runs with the runtime's environment, so
 * git's own credentials work, and no hooks. Call under the clone's setup lock.
 */
export async function fetchBranchHead(
  repo: string,
  url: string,
  branch: string,
): Promise<string | undefined> {
  if ((await remoteBranchHead(repo, url, branch)) === undefined) return undefined;
  await fetchGit(repo, ['fetch', '--quiet', '--no-tags', url, `refs/heads/${branch}`]);
  return (await worktreeGit(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
}
