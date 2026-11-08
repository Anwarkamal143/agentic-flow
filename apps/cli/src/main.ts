#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { repoAdd } from './commands/repo.js';
import { start, status, stop } from './commands/lifecycle.js';

const USAGE = `Usage: factory <command> [options]

Commands:
  init [--workspace-root <dir>]   Create the factory home, API token and config
  start                           Start the runtime in the background (localhost only)
  status [--json]                 Report whether the runtime is running
  stop                            Stop the runtime cleanly
  doctor [--json]                 Check tools and credential presence (via the runtime)
  repo add <path> [--project <name>] [--test-command <cmd>]
           [--typecheck-command <cmd>] [--yes]
                                  Register a Repository: make its Factory Clone and save
                                  its confirmed commands (your checkout is never modified)

Environment:
  FACTORY_HOME   factory home directory (default ~/.factory)
  FACTORY_PORT   override the configured runtime port (0 = any free port)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init': {
      const { values } = parseArgs({
        args: rest,
        options: { 'workspace-root': { type: 'string' } },
      });
      return init({ workspaceRoot: values['workspace-root'] });
    }
    case 'start':
      parseArgs({ args: rest, options: {} });
      return start();
    case 'status': {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
      return status({ json: values.json === true });
    }
    case 'stop':
      parseArgs({ args: rest, options: {} });
      return stop();
    case 'doctor': {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
      return doctor({ json: values.json === true });
    }
    case 'repo': {
      const [sub, ...subArgs] = rest;
      if (sub !== 'add') {
        process.stderr.write(`factory: unknown repo command '${sub ?? ''}'\n\n${USAGE}`);
        return 2;
      }
      const { values, positionals } = parseArgs({
        args: subArgs,
        allowPositionals: true,
        options: {
          project: { type: 'string' },
          'test-command': { type: 'string' },
          'typecheck-command': { type: 'string' },
          yes: { type: 'boolean', short: 'y' },
        },
      });
      const [path, ...extra] = positionals;
      if (path === undefined || extra.length > 0) {
        process.stderr.write(`factory: repo add takes exactly one path\n\n${USAGE}`);
        return 2;
      }
      return repoAdd({
        path,
        project: values.project,
        testCommand: values['test-command'],
        typecheckCommand: values['typecheck-command'],
        yes: values.yes === true,
      });
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`factory: unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`factory: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
