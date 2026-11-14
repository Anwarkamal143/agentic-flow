/**
 * Where a Repository lives on GitHub, and how the factory authenticates there
 * (ADR-0033). Pure: no I/O.
 *
 * - **Coordinates** (`owner/name`) come from a github.com remote URL, or are
 *   given at `factory repo add --github owner/name`. Only github.com is
 *   recognised: any other host, and any local path, gives none.
 * - **The token reference** names where the token is, never the token itself:
 *   `gh` (the `gh` login, read with `gh auth token`) or `env:NAME` (an
 *   environment variable of the runtime). It is resolved for each request.
 */
import { z } from 'zod';

/** A GitHub account: alphanumerics and single inner hyphens, at most 39 characters. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A repository name: letters, digits, `.`, `_` and `-`, at most 100, and not `.` or `..`. */
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export const GitHubCoordinatesSchema = z.object({
  owner: z.string().regex(OWNER),
  name: z.string().regex(NAME),
});
export type GitHubCoordinates = z.infer<typeof GitHubCoordinatesSchema>;

export function formatCoordinates(c: GitHubCoordinates): string {
  return `${c.owner}/${c.name}`;
}

export type ParsedCoordinates =
  { ok: true; coordinates: GitHubCoordinates } | { ok: false; error: string };

/** `owner/name`, as given at `repo add --github`. */
export function parseCoordinates(text: string): ParsedCoordinates {
  const parts = text.trim().split('/');
  const [owner, name] = parts;
  if (
    parts.length === 2 &&
    owner !== undefined &&
    name !== undefined &&
    OWNER.test(owner) &&
    NAME.test(name)
  ) {
    return { ok: true, coordinates: { owner, name } };
  }
  return {
    ok: false,
    error: `'${text}' is not a GitHub repository: expected owner/name (for example acme/widgets)`,
  };
}

/**
 * The coordinates of a github.com remote URL, or null for any other remote.
 * Reads the https, http, git and ssh URL forms and the scp-like
 * `git@github.com:owner/name.git`.
 */
export function coordinatesFromRemoteUrl(url: string): GitHubCoordinates | null {
  const path = githubPath(url.trim());
  if (path === null) return null;
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.length !== 2) return null;
  const parsed = parseCoordinates(parts.join('/'));
  return parsed.ok ? parsed.coordinates : null;
}

/** The path after `github.com` in `url`, or null when the host isn't exactly github.com. */
function githubPath(url: string): string | null {
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (scp !== null) return isGitHubHost(scp[1]) ? (scp[2] ?? null) : null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
  if (!isGitHubHost(parsed.hostname)) return null;
  return parsed.pathname.replace(/^\/+/, '');
}

function isGitHubHost(host: string | undefined): boolean {
  return host?.toLowerCase() === 'github.com';
}

/** GitHub's REST API for github.com; `config.json` `github.apiBaseUrl` overrides it. */
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * `config.json` `github.apiBaseUrl`: an http(s) URL with no username or
 * password. Credentials in it would be a secret in config that doctor and
 * every error message show, so the URL is refused, and the error never
 * echoes it. The token always comes from the token reference.
 */
export const GitHubApiBaseUrlSchema = z
  .url({ protocol: /^https?$/, error: 'must be an http or https URL' })
  .refine(
    (url) => {
      // Zod runs this even when `z.url` failed; that failure is the one to report.
      if (!URL.canParse(url)) return true;
      const parsed = new URL(url);
      return parsed.username === '' && parsed.password === '';
    },
    {
      message:
        'must not contain a username or password; set the token with github.token (gh or env:NAME)',
    },
  );

/** Where the GitHub token comes from. Never the token. */
export type TokenReference = { kind: 'gh' } | { kind: 'env'; name: string };

export type ParsedTokenReference =
  { ok: true; reference: TokenReference } | { ok: false; error: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseTokenReference(text: string): ParsedTokenReference {
  if (text === 'gh') return { ok: true, reference: { kind: 'gh' } };
  if (text.startsWith('env:') && ENV_NAME.test(text.slice(4))) {
    return { ok: true, reference: { kind: 'env', name: text.slice(4) } };
  }
  // The text is not echoed: someone may have pasted a token where the reference goes.
  return {
    ok: false,
    error: "a token reference is 'gh' (the gh login) or 'env:NAME' (an environment variable)",
  };
}

export function formatTokenReference(ref: TokenReference): string {
  return ref.kind === 'gh' ? 'gh' : `env:${ref.name}`;
}

/** A token reference already checked by {@link TokenReferenceTextSchema}. */
export function tokenReferenceOf(text: string): TokenReference {
  const parsed = parseTokenReference(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.reference;
}

/** `config.json` `github.token`: a token reference, checked when the config is read. */
export const TokenReferenceTextSchema = z.string().refine((text) => parseTokenReference(text).ok, {
  message: "must be 'gh' or 'env:NAME' (a token reference, never the token)",
});
