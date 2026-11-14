/**
 * Resolving the GitHub token reference (ADR-0033). The reference (`gh` or
 * `env:NAME`) is resolved for each request: the value is held in memory only
 * for that request, and never persisted, logged, put in an event or passed to
 * a Harness. Each resolved value is handed to `learn`, so the runtime's
 * redaction treats it as a secret from then on.
 *
 * A problem says why the reference doesn't resolve, never what it held.
 */
import { execFile } from 'node:child_process';
import { formatTokenReference, type Secret, type TokenReference } from '@factory/domain';

export type TokenResolution = { ok: true; token: string } | { ok: false; problem: string };

const GH_TIMEOUT_MS = 10_000;

/**
 * `gh auth token` runs with this much of the runtime's environment and no
 * more: enough for `gh` to find its stored login. `GH_TOKEN` and
 * `GITHUB_TOKEN` are left out, so `gh` means the gh login, as the reference says.
 */
const GH_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'];

export class TokenSource {
  constructor(
    readonly reference: TokenReference,
    private readonly env: NodeJS.ProcessEnv,
    /** Called with every resolved value, before it is used. */
    private readonly learn: (secret: Secret) => void = () => undefined,
  ) {}

  /** `gh` or `env:NAME`: safe to show. */
  get label(): string {
    return formatTokenReference(this.reference);
  }

  async resolve(): Promise<TokenResolution> {
    const resolved =
      this.reference.kind === 'env'
        ? fromEnv(this.env, this.reference.name)
        : await fromGh(this.env);
    this.learnIfResolved(resolved);
    return resolved;
  }

  /**
   * Teaches redaction the token before any request needs it, when that needs
   * no process: an `env:` reference's value is known at boot, whatever the
   * variable is called. A `gh` token is learned when it is first resolved;
   * until then the `github_token` pattern (`gho_…`, `ghp_…`) covers it.
   */
  primeRedaction(): void {
    if (this.reference.kind !== 'env') return;
    this.learnIfResolved(fromEnv(this.env, this.reference.name));
  }

  private learnIfResolved(resolved: TokenResolution): void {
    if (!resolved.ok) return;
    const name = this.reference.kind === 'env' ? this.reference.name : 'gh_auth_token';
    this.learn({ name, value: resolved.token });
  }
}

function fromEnv(env: NodeJS.ProcessEnv, name: string): TokenResolution {
  const value = (env[name] ?? '').trim();
  return value === '' ? { ok: false, problem: `${name} is not set` } : { ok: true, token: value };
}

function fromGh(env: NodeJS.ProcessEnv): Promise<TokenResolution> {
  const ghEnv = Object.fromEntries(
    GH_ENV.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])),
  );
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token'],
      { env: ghEnv, timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err === null) {
          const token = stdout.trim();
          resolve(
            token === '' || /\s/.test(token)
              ? { ok: false, problem: '`gh auth token` printed no token' }
              : { ok: true, token },
          );
          return;
        }
        // The output is discarded: it may hold part of a token.
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          ok: false,
          problem:
            code === 'ENOENT'
              ? '`gh` was not found on PATH'
              : err.killed
                ? `\`gh auth token\` timed out after ${String(GH_TIMEOUT_MS / 1000)}s`
                : typeof err.code === 'number'
                  ? `\`gh auth token\` exited with code ${String(err.code)} (is gh logged in? run: gh auth login)`
                  : '`gh auth token` could not run',
        });
      },
    );
  });
}
