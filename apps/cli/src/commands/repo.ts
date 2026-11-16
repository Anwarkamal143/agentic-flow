import { resolve } from 'node:path';
import {
  formatCoordinates,
  MergeMethodSchema,
  SetupCommandSchema,
  MergePolicySchema,
  parseCoordinates,
  type RegisterRepositoryInput,
  type RegisterRepositoryResult,
  type RepositoryCommands,
  type RepositoryInspection,
} from '@factory/domain';
import { resolveHome } from '@factory/home';
import { findRuntime } from '../client.js';
import { ask } from '../prompt.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

/** Cloning a large repository can take a while; the runtime does it inside the request. */
const REGISTER_TIMEOUT_MS = 10 * 60_000;

export interface RepoAddOptions {
  path: string;
  project: string | undefined;
  /** Overrides for the detected commands. An empty string means "no command". */
  testCommand: string | undefined;
  typecheckCommand: string | undefined;
  /** `owner/name`: the Repository's GitHub coordinates, over any its origin URL gives. */
  github: string | undefined;
  /** The Merge Gate's required checks (`--required-check`, repeatable); empty: every check. */
  requiredChecks: string[];
  /**
   * `--setup`: the command the factory runs in each Worktree before the
   * Harness and verification (ADR-0047). Only ever from this flag.
   */
  setup: string | undefined;
  /** `--merge-policy` (default `never_auto`) and `--merge-method` (default `merge`); the runtime validates them. */
  mergePolicy: string | undefined;
  mergeMethod: string | undefined;
  /** Confirms the shown commands without prompting. */
  yes: boolean;
}

/**
 * `factory repo add <path>`: the runtime inspects the path (read-only) and
 * proposes commands, the operator confirms them, then the runtime makes the
 * Factory Clone and saves the Repository.
 */
export async function repoAdd(opts: RepoAddOptions): Promise<number> {
  const found = findRuntime(resolveHome());
  if (found.kind === 'not_running') {
    process.stderr.write('Runtime: not running. Run: factory start\n');
    return EXIT_NOT_RUNNING;
  }
  const { client } = found;
  const path = resolve(opts.path);
  const mergePolicy = MergePolicySchema.safeParse(opts.mergePolicy ?? 'never_auto');
  if (!mergePolicy.success) {
    process.stderr.write(
      `factory: --merge-policy takes ${MergePolicySchema.options.join(' or ')} (auto_if_low_risk_and_green is not available until Phase E)\n`,
    );
    return 2;
  }
  const mergeMethod = MergeMethodSchema.safeParse(opts.mergeMethod ?? 'merge');
  if (!mergeMethod.success) {
    process.stderr.write(`factory: --merge-method takes ${MergeMethodSchema.options.join(', ')}\n`);
    return 2;
  }
  const setup = opts.setup === undefined ? undefined : SetupCommandSchema.safeParse(opts.setup);
  if (setup !== undefined && !setup.success) {
    process.stderr.write(
      'factory: --setup takes one non-empty line of at most 1000 characters (for example --setup "npm ci")\n',
    );
    return 2;
  }
  const github = opts.github === undefined ? undefined : parseCoordinates(opts.github);
  if (github !== undefined && !github.ok) {
    process.stderr.write(`factory: --github: ${github.error}\n`);
    return 2;
  }

  const inspection = await client.json<RepositoryInspection>('POST', '/v1/repositories/inspect', {
    body: { path },
  });
  const project = opts.project ?? inspection.name;
  const commands: RepositoryCommands = {
    test: override(opts.testCommand, inspection.detectedCommands.test),
    typecheck: override(opts.typecheckCommand, inspection.detectedCommands.typecheck),
  };

  const label = (key: keyof RepositoryCommands, flag: string | undefined) =>
    `${commands[key] ?? 'none'}${flag === undefined ? (commands[key] === null ? ' (not detected)' : ' (detected)') : ` (from --${key}-command)`}`;
  process.stdout.write(
    `Repository: ${inspection.name} (${inspection.source})\n` +
      `  project:   ${project}\n` +
      `  origin:    ${
        inspection.remoteUrl === null
          ? 'none; the Factory Clone will be made from this path'
          : `${inspection.remoteUrl}; the Factory Clone will be made from it, reusing local objects`
      }\n` +
      `  GitHub:    ${
        github !== undefined
          ? `${formatCoordinates(github.coordinates)} (from --github)`
          : inspection.github === null
            ? 'none (no github.com origin; set one with --github owner/name)'
            : `${formatCoordinates(inspection.github)} (from the origin URL)`
      }\n` +
      `Commands${inspection.packageManager === null ? '' : ` (package manager: ${inspection.packageManager})`}:\n` +
      `  test:      ${label('test', opts.testCommand)}\n` +
      `  typecheck: ${label('typecheck', opts.typecheckCommand)}\n` +
      `  setup:     ${
        setup === undefined
          ? 'none (the factory installs nothing in a Worktree; set one with --setup)'
          : `${setup.data} (from --setup; run by the factory in each Worktree before the Harness and verification, lifecycle scripts off, the shared cache; on this machine, with network access)`
      }\n` +
      `Merge Gate checks: ${
        opts.requiredChecks.length === 0
          ? 'every check on the PR head (none required by name)'
          : `only ${opts.requiredChecks.join(', ')} (from --required-check)`
      }\n` +
      `Merge Policy: ${mergePolicy.data}${
        mergePolicy.data === 'never_auto'
          ? ' (the factory never merges; a human merges on GitHub)'
          : ' (the factory merges after your Inbox approval)'
      }; merge method: ${mergeMethod.data}\n`,
  );

  if (!opts.yes) {
    const answer = (await ask('Save these commands and register the Repository? [y/N] '))?.trim();
    if (answer === undefined || !/^y(es)?$/i.test(answer)) {
      process.stderr.write(
        'Nothing registered. To change a command, re-run with --test-command or --typecheck-command.\n',
      );
      return 1;
    }
  }

  const input: RegisterRepositoryInput = {
    path,
    project,
    commands,
    ...(opts.github === undefined ? {} : { github: opts.github.trim() }),
    ...(opts.requiredChecks.length === 0 ? {} : { requiredChecks: opts.requiredChecks }),
    ...(setup === undefined ? {} : { setup: setup.data }),
    mergePolicy: mergePolicy.data,
    mergeMethod: mergeMethod.data,
  };
  const result = await client.json<RegisterRepositoryResult>('POST', '/v1/repositories', {
    body: input,
    timeoutMs: REGISTER_TIMEOUT_MS,
  });
  const { repository } = result;
  process.stdout.write(
    `Registered ${repository.name} (${repository.id}) in Project ${result.project.name}\n` +
      `  Factory Clone:  ${repository.clonePath}\n` +
      `  cloned from:    ${
        result.cloneMethod === 'path'
          ? repository.source
          : `${repository.remoteUrl ?? ''} (reusing objects from ${repository.source})`
      }\n` +
      `  default branch: ${repository.defaultBranch}\n` +
      `  GitHub:         ${repository.github === null ? 'none' : formatCoordinates(repository.github)}\n` +
      `Your checkout was not modified.\n`,
  );
  return 0;
}

function override(flag: string | undefined, detected: string | null): string | null {
  if (flag === undefined) return detected;
  return flag.trim() === '' ? null : flag.trim();
}
