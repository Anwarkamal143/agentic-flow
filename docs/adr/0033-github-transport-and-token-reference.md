# The GitHub transport, the token reference, Repository coordinates and the fake GitHub

**Status:** accepted (#54, Phase C). Implements the parent design (#52, "The GitHub port", "Token reference", "Repository additions": coordinates only) and the Phase C grilling answers recorded in PROGRESS.md. Code: `packages/github` (the port and token resolution), `packages/domain/src/github.ts` (coordinates and token-reference parsing, pure), `tests/support/github.ts` (the fake GitHub, test-only).

## Decision

### The port: REST over `fetch`

`GitHubPort` (`packages/github/src/port.ts`) is the factory's only way to call GitHub. It is plain REST over Node's `fetch`, at a configurable API base URL (`config.json` `github.apiBaseUrl`, default `https://api.github.com`). It uses no SDK and no `gh` subprocess, so tests can point it at the fake GitHub and the only dependency is `zod`. It provides the operations the Phase C design names: find a PR by head branch; create, update and reopen a PR; merge (with a method, pinned to the head SHA); read a PR; list check runs and commit statuses for a SHA; re-run a check; list reviews, issue comments and review comments; read a branch head; and create a comment. Pushing is not part of the port. The factory pushes with git from the Factory Clone.

- **Conditional reads.** Every polled read (all but the recovery lookup by head branch) takes an optional ETag, sends it as `If-None-Match`, and returns `{ notModified: true }` on a 304. The port keeps no ETags itself; its caller (the poller, #58) keeps them in memory.
- **Failures are classified, never retried by the port:**
  - `rate_limited`, with `resetAt`: a 429; or a 403 with `x-ratelimit-remaining: 0` or a `retry-after` (GitHub's secondary limit). The reset comes from `retry-after`, else `x-ratelimit-reset`, else now + 60 s.
  - `transient`: a 5xx, a dropped connection or a timeout (30 s).
  - `refused`: any other 4xx, with GitHub's `message` (for example a merge method that isn't allowed, which is a 405, or a refused reopen, which is a 422). Also a token reference that doesn't resolve (`status: null`, sent nowhere), and a 2xx body of an unexpected shape. Retrying won't help any of these.
  The pause and the backoff policy belong to the runtime (#66), not the port.
- **Response bodies are validated** with Zod, down to the fields the port reads. Bodies, comments and messages from GitHub are untrusted text.
- **Lists are one page of 100.** A PR with more than 100 check runs, statuses, reviews or comments is read truncated. Following `Link: rel="next"` is deferred until a case needs it (it is noted under Known limitations).
- **The package is `packages/github`, not `adapters/git-github`.** It follows the existing layout: the Claude Code adapter lives in `packages/harness`, and there is no `adapters/` directory.

- **No credentials in the API base URL.** `github.apiBaseUrl` must be an http(s) URL with no username or password (`GitHubApiBaseUrlSchema`). A URL like `https://user:secret@host` would put a secret in config that doctor prints, which breaks CLAUDE.md §2 (Secrets). The token always comes from the token reference. The runtime refuses to start with such a config, and the error names the field and the rule without quoting the value. `readConfig` reports every invalid field that way (`ConfigError`).

### The token reference

`config.json` `github.token` is a **token reference**, never a token. It is either `gh` (the default: the `gh` login, read with `gh auth token`) or `env:NAME` (a variable in the runtime's environment). Any other value is refused by the config schema, and the error never echoes the value, in case someone pasted a token.

- **Resolved for each request** by `TokenSource.resolve()`. The value lives only for that request. It is never persisted, logged, put in an event or an Artifact, returned by the API, or passed to a Harness. `GH_TOKEN`, `GITHUB_TOKEN` and `GH_CONFIG_DIR` are also scrubbed from guarded processes (ADR-0032).
- **`gh auth token` runs with a minimal environment** (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`). `GH_TOKEN` and `GITHUB_TOKEN` are excluded, so `gh` means the stored login, as the reference says. The command's output is discarded on failure.
- **Redaction learns the token.** The runtime's redactor is now a *learning* redactor (`createLearningRedactor`). Every resolved value is taught to it, so the same `redact` function, already held by the database, the Artifact store, the Harness wrapper and the runtime's own output, redacts it from then on. An `env:` value is learned at boot (`primeRedaction`), whatever the variable is called, so `env:GH_ACCESS` is covered although its name doesn't match the `*_TOKEN` rule. A `gh` token is learned the first time it is resolved. Before that, the `github_token` pattern (`gho_…`, `ghp_…`) covers real GitHub tokens. The runtime does not run `gh auth token` at boot, to keep the operator's login untouched until GitHub is actually needed.

### Repository coordinates

A Repository gains `github: { owner, name } | null` (columns `github_owner`, `github_name`; migration 0015).

- **Derived** at registration from a github.com `remote_url`: the https, http, git and ssh URL forms, and the scp-like `git@github.com:owner/name.git`. Only the host `github.com` counts. GitHub Enterprise hosts, look-alike hosts, local paths and `file://` URLs give none.
- **Set** with `factory repo add --github owner/name`, which wins over the origin URL (for example, a checkout of a fork). The value is validated against GitHub's owner and name rules.
- The `repository.registered` event records the coordinates (`owner/name` or null). `repo add` shows them, and where they came from, before the operator confirms.
- **No backfill.** Repositories registered before this change have `null`. There is no command yet to set coordinates after registration.

### `factory doctor`

`GET /v1/doctor` gains `github: { tokenReference, apiBaseUrl, resolves, problem? }`. Doctor resolves the reference exactly as a request would (the token is then learned by redaction) and reports only whether it resolved, and why not. It never reports the token. GitHub is not called: a token that resolves may still be refused by GitHub.

### The fake GitHub (test support only)

`tests/support/github.ts` starts an HTTP server on 127.0.0.1 per test. It is never imported by the runtime.

- It implements the port's REST subset, with weak ETags (a hash of the body) and 304s, and answers 401 without a bearer token.
- Each repository on it has a **local bare repository** as its git remote. Branch heads, PR head and base SHAs, and merges (a real `merge-tree` and `commit-tree` in the bare repository) all come from git. `gitEnv()` returns `GIT_CONFIG_COUNT` entries (`url.<bare>.insteadOf https://github.com/<owner>/<name>.git`). The runtime is started with those, so a Repository whose origin is a github.com URL clones from, and will push to, the bare remote.
- Its **control API** lets a test:
  - set check runs and commit statuses;
  - add reviews, comments and review comments;
  - move the base, or push a foreign commit;
  - close, reopen or merge a PR, and set `mergeable_state`;
  - refuse a merge method or a reopen;
  - queue a one-shot fault: a forced 304, a primary or secondary rate limit, a 403 that isn't a rate limit, a 5xx, or a dropped connection.
- Rebase merges are not implemented: the fake answers 501, so it is never confused with a merge method refused by policy (405). A PR keeps its last head and base SHAs if a branch is deleted, as GitHub does.

### Tests

- **Unit:** `tests/unit/github-coordinates.test.ts` (URL forms, `owner/name`, token references) and `tests/unit/redaction.test.ts` (the learning redactor).
- **Integration tier** (ADR-0025, widened): `tests/integration/github-port.test.ts` drives the built `@factory/github` against the fake over real HTTP. It opens no database. It covers every operation, the ETag and 304 path, each failure class, and resolving the token for each request.
- **Scenarios:**
  - `repo-add.test.ts`: coordinates from the origin (cloned through the fake's bare remote), from `--github`, none, and a refused value.
  - `doctor.test.ts`: `env:` resolving and not resolving, and `gh` through a fake `gh`.
  - `redaction.test.ts`: a Harness that prints the token, for `env:` and for `gh`, has it redacted from logs, events, Artifacts and every file in the factory home. This test was checked against a runtime that does not learn the token, and it fails there.

## Not done (later Phase C issues)

The Merge Policy, merge method and `requiredChecks` Repository fields (#58, #59, #61), the `pull_requests` and `pr_checks` tables (#57, #58), the poller, the GitHub pause and backoff (#66), and any runtime use of the port beyond doctor. Every test passes against the fake GitHub only. The real GitHub is exercised only by C7 (`[real]`, #67).
