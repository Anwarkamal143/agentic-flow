/**
 * Local git operations. Every function that touches a user's checkout is
 * read-only: it uses plumbing that never refreshes the index or takes locks
 * (`GIT_OPTIONAL_LOCKS=0`), and never runs `status`, `fetch` or `gc` there.
 */
import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
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

export function git(args: readonly string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: gitEnv(), timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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

/** The identity of commits the factory itself makes (WIP commits). */
export const FACTORY_COMMITTER = { name: 'Software Factory', email: 'factory@factory.invalid' };

/** Fetches every branch of `remote` into `refs/remotes/<remote>/*`. */
export async function fetchRemote(repo: string, remote = 'origin'): Promise<void> {
  await git(['-C', repo, 'fetch', '--quiet', '--prune', remote]);
}

/** The full SHA `rev` names, or undefined when it names no commit. */
export async function resolveCommit(repo: string, rev: string): Promise<string | undefined> {
  try {
    return (await git(['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
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
}): Promise<void> {
  await git([
    '-C',
    opts.repo,
    'worktree',
    'add',
    '--quiet',
    '-b',
    opts.branch,
    '--',
    opts.path,
    opts.startSha,
  ]);
}

/**
 * Removes a Worktree; its branch stays. Never forced: git refuses when the
 * Worktree has changes that are neither committed nor ignored.
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(['-C', repo, 'worktree', 'remove', '--', path]);
}

/** Paths with uncommitted changes (tracked or untracked, not ignored). */
export async function uncommittedPaths(worktree: string): Promise<string[]> {
  const out = await git([
    '-C',
    worktree,
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
  await git(['-C', worktree, 'add', '--all']);
  await git([
    '-C',
    worktree,
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
  return (await git(['-C', worktree, 'rev-parse', 'HEAD'])).trim();
}

/** The commits in `base..head`, newest first, with their subjects. */
export async function commitsBetween(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
  const out = await git(['-C', repo, 'log', '--format=%H%x00%s', `${base}..${head}`]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [sha = '', subject = ''] = l.split('\0');
      return { sha, subject };
    });
}

/** Paths changed between two commits. */
export async function changedPaths(repo: string, base: string, head: string): Promise<string[]> {
  const out = await git(['-C', repo, 'diff', '--name-only', '-z', `${base}..${head}`]);
  return out.split('\0').filter((p) => p !== '');
}

/** True when the repository has an object named `sha` (full or abbreviated). */
export async function hasCommit(repo: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  return (await resolveCommit(repo, sha)) !== undefined;
}

/** The repository's `info/exclude` file (shared by all its Worktrees). */
export async function infoExcludePath(repo: string): Promise<string> {
  const common = (
    await git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  return `${common}/info/exclude`;
}
