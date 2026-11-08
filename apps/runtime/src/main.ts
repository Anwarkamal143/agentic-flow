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
  isProcessAlive,
  readConfig,
  readRuntimeRecord,
  readToken,
  removeRuntimeRecord,
  resolveHome,
  writeRuntimeRecord,
} from '@factory/home';
import { createApp, type RuntimeStatus } from './app.js';
import { runDoctor } from './doctor.js';
import { RepositoryService } from './repositories.js';

const ACTOR = 'system:runtime';

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

const database = openDatabase(home.dbPath);
const startedAt = new Date();
let state: RuntimeStatus['state'] = 'running';
let port = 0;

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
  }),
  doctor: () => runDoctor(process.env),
  repositories: new RepositoryService(database.db, config.workspaceRoot),
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
  server.close(() => {
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
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
