#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { doctor } from './commands/doctor.js';
import { inboxDecide, inboxDefer, inboxList, inboxShow, planShow } from './commands/inbox.js';
import { init } from './commands/init.js';
import { jobCancel, jobCreate, jobList, jobShow } from './commands/job.js';
import { logs } from './commands/logs.js';
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
  job create --repo <id|name> --title <text> [--description <text>]
                                  Create a Job for a registered Repository
  job list [--json]               List Jobs, newest first
  job show <id> [--json]          Show a Job: status, Stages, Workflow Snapshot, config
  job cancel <id> [--reason <text>]
                                  Cancel a Job, stopping its running work
  logs <job> [--json]             Show the (redacted) Harness and verification output
                                  of a Job's Attempts
  plan show <job> [--json]        Show the Job's Plan for approval: Specification, DAG,
                                  parallel waves, risks, decision points, estimate
  inbox [--all] [--json]          List open Inbox Items (--all: every item, deferred too)
  inbox show <id> [--json]        Show an Inbox Item, its version and options
  inbox decide <id> <option> --expect-version <n> [--subject <ref>] [--comment <text>]
                                  Decide an item (a stale version or subject is refused)
  inbox defer <id> | undefer <id> Hide an item from the default view, or show it again

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
    case 'job':
      return job(rest);
    case 'inbox':
      return inbox(rest);
    case 'plan': {
      const [sub, ...subArgs] = rest;
      const { values, positionals } = parseArgs({
        args: subArgs,
        allowPositionals: true,
        options: { json: { type: 'boolean' } },
      });
      const [id, ...extra] = positionals;
      if (sub !== 'show' || id === undefined || extra.length > 0) {
        process.stderr.write(`factory: plan show takes exactly one Job id\n\n${USAGE}`);
        return 2;
      }
      return planShow(id, { json: values.json === true });
    }
    case 'logs': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { json: { type: 'boolean' } },
      });
      const [id, ...extra] = positionals;
      if (id === undefined || extra.length > 0) {
        process.stderr.write(`factory: logs takes exactly one Job id\n\n${USAGE}`);
        return 2;
      }
      return logs(id, { json: values.json === true });
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

function job(argv: string[]): Promise<number> | number {
  const [sub, ...args] = argv;
  switch (sub) {
    case 'create': {
      const { values } = parseArgs({
        args,
        options: {
          repo: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
        },
      });
      if (values.repo === undefined || values.title === undefined) {
        process.stderr.write(`factory: job create needs --repo and --title\n\n${USAGE}`);
        return 2;
      }
      return jobCreate({ repo: values.repo, title: values.title, description: values.description });
    }
    case 'list': {
      const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
      return jobList({ json: values.json === true });
    }
    case 'show':
    case 'cancel': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { json: { type: 'boolean' }, reason: { type: 'string' } },
      });
      const [id, ...extra] = positionals;
      if (id === undefined || extra.length > 0) {
        process.stderr.write(`factory: job ${sub} takes exactly one Job id\n\n${USAGE}`);
        return 2;
      }
      return sub === 'show'
        ? jobShow(id, { json: values.json === true })
        : jobCancel(id, { reason: values.reason });
    }
    default:
      process.stderr.write(`factory: unknown job command '${sub ?? ''}'\n\n${USAGE}`);
      return 2;
  }
}

function inbox(argv: string[]): Promise<number> | number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      'expect-version': { type: 'string' },
      subject: { type: 'string' },
      comment: { type: 'string' },
    },
  });
  const [sub, id, ...extra] = positionals;
  const json = values.json === true;
  switch (sub) {
    case undefined:
      return inboxList({ all: values.all === true, json });
    case 'show':
    case 'defer':
    case 'undefer':
      if (id === undefined || extra.length > 0) {
        process.stderr.write(`factory: inbox ${sub} takes exactly one item id\n\n${USAGE}`);
        return 2;
      }
      return sub === 'show' ? inboxShow(id, { json }) : inboxDefer(id, sub === 'defer');
    case 'decide': {
      const [option, ...more] = extra;
      const version = Number(values['expect-version']);
      if (id === undefined || option === undefined || more.length > 0) {
        process.stderr.write(`factory: inbox decide takes an item id and an option\n\n${USAGE}`);
        return 2;
      }
      if (values['expect-version'] === undefined || !Number.isInteger(version) || version < 0) {
        process.stderr.write(
          `factory: inbox decide needs --expect-version <n> (the version 'inbox show' printed)\n`,
        );
        return 2;
      }
      return inboxDecide(id, option, {
        expectVersion: version,
        subject: values.subject,
        comment: values.comment,
      });
    }
    default:
      process.stderr.write(`factory: unknown inbox command '${sub}'\n\n${USAGE}`);
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
