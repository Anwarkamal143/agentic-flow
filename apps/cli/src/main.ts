#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MergePolicySchema } from '@factory/domain';
import { activity, DEFAULT_TAIL_LINES } from './commands/activity.js';
import { doctor } from './commands/doctor.js';
import {
  inboxAnswer,
  inboxDecide,
  inboxDefer,
  inboxList,
  inboxShow,
  planShow,
} from './commands/inbox.js';
import { init } from './commands/init.js';
import { jobCancel, jobCreate, jobList, jobReplan, jobShow } from './commands/job.js';
import { logs } from './commands/logs.js';
import { planEdit, planRaw, planRequestChanges } from './commands/plan.js';
import { projectConfigSet, projectCreate, projectList, projectShow } from './commands/project.js';
import { repoAdd } from './commands/repo.js';
import { start, status, stop } from './commands/lifecycle.js';

const USAGE = `Usage: factory <command> [options]

Commands:
  init [--workspace-root <dir>]   Create the factory home, API token and config
  start                           Start the runtime in the background (localhost only)
  status [--json]                 Report whether the runtime is running
  stop                            Stop the runtime cleanly
  doctor [--json]                 Check tools and credential presence (via the runtime)
  project create <name> [--json] Create a Project (the only way one comes to exist)
  project list [--json]           List Projects with their Repositories and active Jobs
  project show <project> [--json] Show a Project: the config set on it, its Repositories
                                  and active Jobs
  project config set <project> <key> <value>
                                  Set one Project config key (dotted when nested, for
                                  example concurrency.perJob); new Jobs use it, Jobs
                                  already created keep their frozen configuration
  repo add <path> [--project <name>] [--test-command <cmd>]
           [--typecheck-command <cmd>] [--github <owner/name>]
           [--required-check <name>]... [--merge-policy never_auto|human_approval]
           [--merge-method merge|squash|rebase] [--setup <cmd>] [--yes]
                                  Register a Repository in an existing Project (unset:
                                  the only Project; an unknown one is refused): make its
                                  Factory Clone and save its confirmed commands (your
                                  checkout is never modified);
                                  --setup runs in each Worktree before the Harness and
                                  verification (for example "npm ci")
  job create --title <text> [--project <id|name>] [--repo <id|name>]
             [--description <text>] [--per-repository <n>] [--per-job <n>]
             [--merge-policy <policy>]
                                  Create a Job (unset --project: the only Project;
                                  unset --repo: the Project's only Repository); the
                                  concurrency flags override its Task limits, and
                                  --merge-policy may only make the Repository's stricter
  job list [--json]               List Jobs, newest first
  job show <id> [--json]          Show a Job: status, Stages, Workflow Snapshot, config
  job cancel <id> [--reason <text>]
                                  Cancel a Job, stopping its running work
  job replan <id> --feedback <text>
                                  Ask for a Replan during execution: nothing new is
                                  dispatched, planning starts once no Attempt is in
                                  flight, and unaffected Tasks keep their work
  logs <job> [--json]             Show the (redacted) Harness and verification output
                                  of a Job's Attempts
  plan show <job> [--json|--raw]  Show the Job's Plan for approval: Specification, DAG,
                                  parallel waves, risks, decision points, estimate
                                  (--raw: the Plan itself, as JSON for plan edit)
  plan edit <job> --file <plan.json>
                                  Replace the waiting Plan with yours (a Plan Edit:
                                  validated, not a Replan)
  plan request-changes <job> --feedback <text>
                                  Send the waiting Plan back to the planner (a Replan,
                                  capped by maxReplans)
  inbox [--all] [--json]          List open Inbox Items (--all: every item, deferred too)
  inbox show <id> [--json]        Show an Inbox Item, its version and options
  inbox decide <id> <option> --expect-version <n> [--subject <ref>] [--comment <text>] [--grant <n>]
                                  Decide an item (a stale version or subject is refused)
  inbox answer <id> (--answer [<q>=]<text>... | --file <answers.json>) [--expect-version <n>]
                                  Answer a Question (an option or free text per question);
                                  a fresh Attempt continues the Task with the answers.
                                  A cleanup Approval: --answer worktrees=discard|keep,
                                  pull_request=close|keep, remote_branch=delete|keep
  inbox defer <id> | undefer <id> Hide an item from the default view, or show it again
  activity [--lines <n>] [--json] What is running now: each running Attempt with its
                                  Harness, model, Repository, tier, heartbeat, ports and
                                  the redacted tail of its output (default 20 lines)

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
          github: { type: 'string' },
          'required-check': { type: 'string', multiple: true },
          'merge-policy': { type: 'string' },
          'merge-method': { type: 'string' },
          setup: { type: 'string' },
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
        github: values.github,
        requiredChecks: values['required-check'] ?? [],
        mergePolicy: values['merge-policy'],
        mergeMethod: values['merge-method'],
        setup: values.setup,
        yes: values.yes === true,
      });
    }
    case 'project':
      return project(rest);
    case 'job':
      return job(rest);
    case 'inbox':
      return inbox(rest);
    case 'plan':
      return plan(rest);
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
    case 'activity': {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: 'boolean' }, lines: { type: 'string' } },
      });
      const lines = values.lines === undefined ? DEFAULT_TAIL_LINES : Number(values.lines);
      if (!Number.isInteger(lines) || lines < 0) {
        process.stderr.write(`factory: --lines takes a whole number\n\n${USAGE}`);
        return 2;
      }
      return activity({ json: values.json === true, lines });
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

function project(argv: string[]): Promise<number> | number {
  const [sub, ...args] = argv;
  if (sub === 'config') {
    const [action, ...setArgs] = args;
    const { positionals } = parseArgs({ args: setArgs, allowPositionals: true, options: {} });
    const [ref, key, value, ...extra] = positionals;
    if (action !== 'set' || ref === undefined || key === undefined || value === undefined) {
      process.stderr.write(`factory: project config set takes <project> <key> <value>\n\n${USAGE}`);
      return 2;
    }
    if (extra.length > 0) {
      process.stderr.write(`factory: project config set takes one value; quote it\n`);
      return 2;
    }
    return projectConfigSet(ref, key, value);
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const json = values.json === true;
  switch (sub) {
    case 'create':
    case 'show': {
      const [ref, ...extra] = positionals;
      if (ref === undefined || extra.length > 0) {
        process.stderr.write(`factory: project ${sub} takes exactly one Project\n\n${USAGE}`);
        return 2;
      }
      return sub === 'create' ? projectCreate(ref, { json }) : projectShow(ref, { json });
    }
    case 'list':
      if (positionals.length > 0) {
        process.stderr.write(`factory: project list takes no arguments\n\n${USAGE}`);
        return 2;
      }
      return projectList({ json });
    default:
      process.stderr.write(`factory: unknown project command '${sub ?? ''}'\n\n${USAGE}`);
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
          project: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          'per-repository': { type: 'string' },
          'per-job': { type: 'string' },
          'merge-policy': { type: 'string' },
        },
      });
      if (values.title === undefined) {
        process.stderr.write(`factory: job create needs --title\n\n${USAGE}`);
        return 2;
      }
      const perRepository = limitFlag('--per-repository', values['per-repository']);
      const perJob = limitFlag('--per-job', values['per-job']);
      if (perRepository === null || perJob === null) return 2;
      const mergePolicy =
        values['merge-policy'] === undefined
          ? undefined
          : MergePolicySchema.safeParse(values['merge-policy']);
      if (mergePolicy?.success === false) {
        process.stderr.write(
          `factory: --merge-policy takes ${MergePolicySchema.options.join(' or ')} (auto_if_low_risk_and_green is not available until Phase E)\n\n${USAGE}`,
        );
        return 2;
      }
      return jobCreate({
        ...(mergePolicy === undefined ? {} : { mergePolicy: mergePolicy.data }),
        project: values.project,
        repo: values.repo,
        title: values.title,
        description: values.description,
        concurrency: {
          ...(perRepository === undefined ? {} : { perRepository }),
          ...(perJob === undefined ? {} : { perJob }),
        },
      });
    }
    case 'list': {
      const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
      return jobList({ json: values.json === true });
    }
    case 'replan': {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { feedback: { type: 'string' } },
      });
      const [id, ...extra] = positionals;
      if (id === undefined || extra.length > 0) {
        process.stderr.write(`factory: job replan takes exactly one Job id\n\n${USAGE}`);
        return 2;
      }
      if (values.feedback === undefined || values.feedback.trim() === '') {
        process.stderr.write(`factory: job replan needs --feedback <text>\n`);
        return 2;
      }
      return jobReplan(id, { feedback: values.feedback });
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

function plan(argv: string[]): Promise<number> | number {
  const [sub, ...subArgs] = argv;
  const { values, positionals } = parseArgs({
    args: subArgs,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      raw: { type: 'boolean' },
      file: { type: 'string' },
      feedback: { type: 'string' },
    },
  });
  const [id, ...extra] = positionals;
  if (id === undefined || extra.length > 0) {
    process.stderr.write(`factory: plan ${sub ?? ''} takes exactly one Job id\n\n${USAGE}`);
    return 2;
  }
  switch (sub) {
    case 'show':
      return values.raw === true ? planRaw(id) : planShow(id, { json: values.json === true });
    case 'edit':
      if (values.file === undefined) {
        process.stderr.write(`factory: plan edit needs --file <plan.json>\n`);
        return 2;
      }
      return planEdit(id, { file: values.file });
    case 'request-changes':
      if (values.feedback === undefined || values.feedback.trim() === '') {
        process.stderr.write(`factory: plan request-changes needs --feedback <text>\n`);
        return 2;
      }
      return planRequestChanges(id, { feedback: values.feedback });
    default:
      process.stderr.write(`factory: unknown plan command '${sub ?? ''}'\n\n${USAGE}`);
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
      grant: { type: 'string' },
      answer: { type: 'string', multiple: true },
      file: { type: 'string' },
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
    case 'answer': {
      if (id === undefined || extra.length > 0) {
        process.stderr.write(`factory: inbox answer takes exactly one item id\n\n${USAGE}`);
        return 2;
      }
      const answers = values.answer ?? [];
      if (answers.length > 0 === (values.file !== undefined)) {
        process.stderr.write(
          `factory: inbox answer needs --answer <text>... or --file <path>, not both\n`,
        );
        return 2;
      }
      const raw = values['expect-version'];
      const version = Number(raw);
      if (raw !== undefined && (!Number.isInteger(version) || version < 0)) {
        process.stderr.write(`factory: --expect-version needs a whole number, not '${raw}'\n`);
        return 2;
      }
      return inboxAnswer(id, {
        answers,
        file: values.file,
        expectVersion: raw === undefined ? undefined : version,
      });
    }
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
      const grant = values.grant === undefined ? undefined : Number(values.grant);
      if (grant !== undefined && !Number.isInteger(grant)) {
        process.stderr.write(
          `factory: --grant needs a whole number, not '${String(values.grant)}'\n`,
        );
        return 2;
      }
      return inboxDecide(id, option, {
        expectVersion: version,
        subject: values.subject,
        comment: values.comment,
        grant,
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

/** A concurrency limit flag: `undefined` when absent, `null` (reported) when not a whole number. */
function limitFlag(flag: string, raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    process.stderr.write(`factory: ${flag} needs a whole number, not '${raw}'\n`);
    return null;
  }
  return Number(raw);
}
