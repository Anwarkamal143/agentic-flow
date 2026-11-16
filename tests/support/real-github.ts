/**
 * The real GitHub for the `[real]` tests (C7, #67; the rerun probe, #77): the
 * `gh` login's token and git credentials, and the preconditions every such
 * test checks before touching the sandbox. Test support only, never shipped.
 */
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { SANDBOX, sandboxApi } from './sandbox.js';

export const GITHUB_API = 'https://api.github.com';

/** The `gh` login's token, read with no GH_TOKEN/GITHUB_TOKEN in the way. Never printed. */
export function ghToken(): string {
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], HOME: homedir(), USER: userInfo().username },
    }).trim();
  } catch {
    throw new Error('precondition: `gh auth token` failed. Run `gh auth login`.');
  }
}

/** git credentials for github.com from the `gh` login only (no keychain helper). */
export const GH_CREDENTIALS: Record<string, string> = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
};

/** Reads of the sandbox on GitHub: the sandbox client, which reaches no other repository. */
export const sandboxGet = <T>(path: string) =>
  sandboxApi({ fullName: SANDBOX, apiBaseUrl: GITHUB_API, token: ghToken })<T>('GET', path);

async function ghLogin(): Promise<{ login: string; scopes: string[] }> {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: { authorization: `Bearer ${ghToken()}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`precondition: GET /user answered ${String(res.status)}`);
  const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim());
  return { login: ((await res.json()) as { login: string }).login, scopes };
}

/** The `gh` login is the sandbox's owner, with the `repo` and `workflow` scopes. */
export async function requireSandboxLogin(): Promise<void> {
  const [owner = ''] = SANDBOX.split('/');
  const who = await ghLogin();
  if (who.login.toLowerCase() !== owner.toLowerCase())
    throw new Error(
      `precondition: the active gh account is ${who.login}, not ${owner}. Run \`gh auth switch --user ${owner}\`.`,
    );
  for (const scope of ['repo', 'workflow'])
    if (!who.scopes.includes(scope))
      throw new Error(
        `precondition: the gh login lacks the '${scope}' scope. Run \`gh auth refresh -s ${scope}\`.`,
      );
}
