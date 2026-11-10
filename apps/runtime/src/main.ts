/**
 * Runtime process entry (composition root). Started in the background by
 * `factory start`, or directly by the scenario tests.
 *
 * Environment: FACTORY_HOME (default ~/.factory), FACTORY_PORT (overrides the
 * configured port; 0 picks a free one).
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { appendEvent, openDatabase } from '@factory/db';
import {
  RUNTIME_HOST,
  ensureHomeDirs,
  globalConcurrency,
  isProcessAlive,
  readConfig,
  readRuntimeRecord,
  readToken,
  removeRuntimeRecord,
  resolveHome,
  writeRuntimeRecord,
} from '@factory/home';
import {
  ClaudeCodeHarness,
  FakeHarness,
  FakeScriptError,
  loadFakeScript,
  redactingHarness,
  type AgentHarness,
  type ClaudeCodeBilling,
} from '@factory/harness';
import { API_KEY_MISSING, createRedactor, secretsFromEnv, type Billing } from '@factory/domain';
import { createApp, type RuntimeStatus } from './app.js';
import { InboxService } from './inbox.js';
import { ArtifactStore } from './artifacts.js';
import { runDoctor } from './doctor.js';
import { JobService } from './jobs.js';
import { jobLogs } from './logs.js';
import { Outbox } from './outbox.js';
import { RepositoryService } from './repositories.js';
import { StageScheduler } from './scheduler.js';
import { CRASH_POINTS, TaskScheduler } from './execution.js';
import { recoverTasks } from './recovery.js';

const ACTOR = 'system:runtime';

function log(message: string): void {
  process.stderr.write(`factory runtime: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`factory runtime: ${message}\n`);
  process.exit(1);
}

const home = resolveHome();
const config = readConfig(home);
const token = readToken(home);
if (config === undefined || token === undefined) {
  fail(`factory home ${home.root} is not initialized. Run: factory init`);
}
ensureHomeDirs(home);

/**
 * Secret values never reach history (ADR-0011): the values of the runtime's
 * secret-named variables and the factory's own token, plus known secret
 * patterns, are redacted from every database write, Artifact, Harness prompt
 * and output, and from this process's own output (the runtime log).
 */
const redact = createRedactor([
  ...secretsFromEnv(process.env),
  { name: 'FACTORY_TOKEN', value: token },
]);
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = (chunk: unknown, ...rest: unknown[]) =>
    write(
      typeof chunk === 'string'
        ? redact(chunk)
        : chunk instanceof Uint8Array
          ? redact(Buffer.from(chunk).toString('utf8'))
          : chunk,
      ...rest,
    );
}

// Node would print an uncaught error from native code, past the redacted streams.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err: unknown) => {
    process.stderr.write(
      `factory runtime: ${event}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}

const existing = readRuntimeRecord(home);
if (existing !== undefined && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
  fail(`a runtime is already running for ${home.root} (pid ${String(existing.pid)})`);
}

const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const portEnv = process.env['FACTORY_PORT'];
const requestedPort = portEnv === undefined || portEnv === '' ? config.port : Number(portEnv);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  fail(`invalid port: ${String(portEnv)}`);
}

/**
 * API-key billing is a permission expansion (ADR-0015): the runtime's key
 * reaches every Claude Code Harness Run. Without a key it can't be honoured.
 */
function claudeCodeBilling(billing: Billing): ClaudeCodeBilling {
  if (billing === 'subscription') return { kind: 'subscription' };
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (apiKey === '') fail(`harness 'claude-code': ${API_KEY_MISSING}`);
  return { kind: 'api_key', apiKey };
}

/** The Harness comes from runtime configuration only; there is no other switch. */
function configuredHarness(): AgentHarness | undefined {
  const harness = config?.harness;
  if (harness === undefined) return undefined;
  if (harness.id === 'claude-code') {
    return redactingHarness(
      new ClaudeCodeHarness({
        command: harness.command,
        ...(harness.model === undefined ? {} : { model: harness.model }),
        env: process.env,
        billing: claudeCodeBilling(harness.billing),
        ...(harness.prices === undefined ? {} : { prices: harness.prices }),
      }),
      redact,
    );
  }
  try {
    // The Run counts survive a restart, so a restarted runtime goes on with the next response.
    return redactingHarness(
      new FakeHarness(loadFakeScript(harness.script), `${harness.script}.runs.json`),
      redact,
    );
  } catch (err) {
    if (err instanceof FakeScriptError) fail(`harness 'fake': ${err.message}`);
    throw err;
  }
}
const harness = configuredHarness();
const detection = await harness?.detect();
// A configured Harness that can't be driven is a configuration error: no Run would be honest.
if (harness !== undefined && detection !== undefined) {
  if (!detection.installed)
    fail(`harness '${harness.id}' is not installed: ${detection.problems.join('; ')}`);
  if (detection.problems.length > 0) {
    fail(
      `harness '${harness.id}' ${detection.version ?? ''} can't be used: ${detection.problems.join('; ')}`,
    );
  }
  if (detection.credentials === 'absent') {
    log(`warning: harness '${harness.id}' reports no login; its Runs will fail until there is one`);
  }
}

const database = openDatabase(home.dbPath, { redact });
const startedAt = new Date();
let state: RuntimeStatus['state'] = 'running';
let port = 0;

const outbox = new Outbox(database.db);
const artifacts = new ArtifactStore(database.db, home.root, redact);
const holder = `runtime:${String(process.pid)}`;

/**
 * Crash recovery (ADR-0012), before anything is scheduled and before the API
 * listens: every Task a previous runtime left in progress is re-attached,
 * resumed, retried or blocked. Only with a Harness: without one nothing runs.
 */
const recovered =
  harness === undefined
    ? []
    : await recoverTasks({
        db: database.db,
        holder,
        spoolRoot: home.spoolDir,
        onCommit: () => undefined,
        log,
      });

/** Test-only fault injection (ADR-0012); an unknown point is refused, never ignored. */
const crashEnv = process.env['FACTORY_TEST_CRASH_AT'];
const crashAt = CRASH_POINTS.find((p) => p === crashEnv);
if (crashEnv !== undefined && crashAt === undefined) {
  fail(`unknown FACTORY_TEST_CRASH_AT: ${crashEnv}`);
}

const scheduler = new StageScheduler({
  db: database.db,
  harness,
  artifacts,
  spoolRoot: home.spoolDir,
  onCommit: () => {
    notify();
  },
  log: (message) => process.stderr.write(`factory runtime: ${message}\n`),
});
const tasks = new TaskScheduler({
  db: database.db,
  harness,
  harnessVersion: detection?.version ?? null,
  globalConcurrency: globalConcurrency(config),
  artifacts,
  workspaceRoot: config.workspaceRoot,
  runtimeEnv: process.env,
  spoolRoot: home.spoolDir,
  recovered,
  ...(crashAt === undefined ? {} : { crashAt }),
  onCommit: () => {
    notify();
  },
  log,
});
if (tasks.leaseHolder !== holder) throw new Error('lease holders disagree');
const notify = () => {
  outbox.notify();
  scheduler.wake();
  tasks.wake();
};

const app = createApp({
  token,
  status: () => ({
    state,
    pid: process.pid,
    version,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
    host: RUNTIME_HOST,
    port,
    home: home.root,
    workspaceRoot: config.workspaceRoot,
    database: { journalMode: database.journalMode, migrations: database.appliedMigrations },
    harness:
      harness === undefined || detection === undefined
        ? null
        : {
            id: harness.id,
            version: detection.version,
            installed: detection.installed,
            credentials: detection.credentials,
            billing: config.harness?.id === 'claude-code' ? config.harness.billing : null,
          },
  }),
  doctor: () =>
    runDoctor(
      process.env,
      config.harness?.id === 'claude-code' ? config.harness.command : 'claude',
      config.harness?.id === 'claude-code' ? config.harness.billing : undefined,
    ),
  repositories: new RepositoryService(database.db, config.workspaceRoot, notify),
  jobs: new JobService(database.db, notify, async (jobId) => {
    await Promise.all([scheduler.cancelJob(jobId), tasks.cancelJob(jobId)]);
  }),
  inbox: new InboxService(
    database.db,
    artifacts,
    notify,
    config.harness?.id === 'claude-code' ? config.harness.billing : null,
  ),
  artifacts,
  logs: (jobId) => jobLogs(database.db, artifacts, jobId),
  outbox,
  requestShutdown: () => {
    shutdown('api');
  },
});

// No createServer option is passed, so serve() returns a plain node:http Server.
const server = serve({ fetch: app.fetch, hostname: RUNTIME_HOST, port: requestedPort }, (info) => {
  port = info.port;
  database.db.transaction((tx) => {
    appendEvent(tx, {
      entityKind: 'runtime',
      entityId: 'runtime',
      type: 'runtime.started',
      actor: ACTOR,
      payload: { pid: process.pid, version, port },
    });
  });
  outbox.start();
  scheduler.start();
  tasks.start();
  writeRuntimeRecord(home, {
    pid: process.pid,
    host: RUNTIME_HOST,
    port,
    startedAt: startedAt.toISOString(),
    version,
  });
  process.stdout.write(
    `factory runtime ${version} listening on http://${RUNTIME_HOST}:${String(port)} (pid ${String(process.pid)})\n`,
  );
}) as Server;

server.on('error', (err) => {
  database.close();
  fail(`cannot listen on ${RUNTIME_HOST}:${String(requestedPort)}: ${err.message}`);
});

function shutdown(reason: string): void {
  if (state === 'stopping') return;
  state = 'stopping';
  process.stdout.write(`factory runtime stopping (${reason})\n`);
  const force = setTimeout(() => {
    server.closeAllConnections();
  }, 3_000);
  force.unref();
  // Ends every SSE stream; events written from here on are released at the next start.
  outbox.close();
  // A Harness Run in flight is cancelled; its Stage Run is resumed at the next start.
  // So is a developer Harness Run or verification command; its Attempt is recovered at the next start.
  const stopped = Promise.all([scheduler.close(), tasks.close()]);
  server.close(() => {
    void stopped.then(() => {
      finish(reason);
    });
  });
  server.closeIdleConnections();
}

function finish(reason: string): void {
  database.db.transaction((tx) => {
    appendEvent(tx, {
      entityKind: 'runtime',
      entityId: 'runtime',
      type: 'runtime.stopped',
      actor: ACTOR,
      payload: { reason },
    });
  });
  database.close();
  const record = readRuntimeRecord(home);
  if (record?.pid === process.pid) removeRuntimeRecord(home);
  process.stdout.write('factory runtime stopped\n');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
