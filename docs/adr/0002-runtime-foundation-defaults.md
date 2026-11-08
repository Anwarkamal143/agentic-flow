# Runtime foundation defaults (Phase A, issue #2)

Routine, reversible choices made while building the monorepo, the runtime boot and the test seam.

- **TypeScript 6.0, not 7.** TypeScript 7 is the latest release, but typescript-eslint 8.72 supports `typescript <6.1`. We pin `typescript@6.0.3` until typescript-eslint supports 7.
- **Hono + `@hono/node-server`** for the runtime HTTP API (ARCHITECTURE §1 allowed Fastify or Hono). It is small, built on web-standard `Request`/`Response`, and streams SSE natively.
- **`better-sqlite3`** is the Drizzle driver. It is a native module, so `pnpm-workspace.yaml` allows its build script.
- **Build with `tsc -b`; tests run the built output.** The scenario tests spawn `apps/runtime/dist/main.js` and `apps/cli/dist/main.js`, the same files `factory start` runs. Vitest's global setup runs the build first, so `pnpm test` works from a clean clone.
- **`packages/home`** holds the factory-home file layout shared by the CLI and the runtime: paths, the token, `config.json`, and the `runtime.json` pidfile. It has no database access, so the CLI stays a pure API client.
- **Factory home files.** `FACTORY_HOME` (default `~/.factory`, mode 0700) holds `token` (0600, 32 random bytes in hex), `config.json` (`workspaceRoot`, `port`), `runtime.json` (pid, host, port, start time, version), `factory.db`, and `logs/runtime.log`. `factory init` never overwrites an existing token.
- **Port.** The default is 7420. `FACTORY_PORT` overrides it, and `0` picks a free port (tests use this). The runtime writes its real port to `runtime.json`, and the CLI reads it from there. The host is always `127.0.0.1`.
- **Every route needs the token, including status.** There is no unauthenticated health endpoint. Tokens are compared as SHA-256 digests with `timingSafeEqual`. A missing, malformed or wrong token always gets `401`.
- **Stopping.** `factory stop` calls the authenticated `POST /v1/shutdown`. It never sends a signal to a pid it could not confirm over the API is our runtime (pid reuse). The runtime also shuts down cleanly on SIGTERM/SIGINT: it closes the server, checkpoints the WAL, and removes `runtime.json`.
- **`factory status` exit codes:** 0 running, 3 not running (LSB convention), 1 when the process exists but doesn't respond.
- **First table: `events`.** It is the only table this ticket needs. The runtime appends `runtime.started` / `runtime.stopped` (actor `system:runtime`). Later tickets add their own tables as new migrations. `pnpm lint` fails when `schema.ts` drifts from the migrations.
