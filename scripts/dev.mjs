#!/usr/bin/env node
/**
 * `pnpm dev`: the runtime and the dashboard (`next dev`) together, against
 * the factory home (FACTORY_HOME, default ~/.factory), which must be
 * initialized (`factory init`). A runtime that is already running is used
 * as it is and left running; one started here is stopped on exit.
 * The dashboard listens on 127.0.0.1:${FACTORY_DASHBOARD_PORT:-7421}.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../apps/cli/dist/main.js', import.meta.url));
const EXIT_NOT_RUNNING = 3;

function factory(args) {
  return spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: root }).status;
}

const wasRunning =
  spawnSync(process.execPath, [cli, 'status'], { stdio: 'ignore', cwd: root }).status !==
  EXIT_NOT_RUNNING;
const startStatus = factory(['start']);
if (startStatus !== 0) process.exit(startStatus ?? 1);
const ownRuntime = !wasRunning;

const dashboard = spawn('pnpm', ['--filter', '@factory/dashboard', 'dev'], {
  stdio: 'inherit',
  cwd: root,
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  if (dashboard.exitCode === null) dashboard.kill('SIGTERM');
  if (ownRuntime) factory(['stop']);
  process.exit(code);
}

process.on('SIGINT', () => {
  stop(0);
});
process.on('SIGTERM', () => {
  stop(0);
});
dashboard.on('exit', (code) => {
  stop(code ?? 0);
});
