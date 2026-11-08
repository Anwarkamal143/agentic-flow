import { resolve } from 'node:path';
import type {
  RegisterRepositoryInput,
  RegisterRepositoryResult,
  RepositoryCommands,
  RepositoryInspection,
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
      `Commands${inspection.packageManager === null ? '' : ` (package manager: ${inspection.packageManager})`}:\n` +
      `  test:      ${label('test', opts.testCommand)}\n` +
      `  typecheck: ${label('typecheck', opts.typecheckCommand)}\n`,
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

  const input: RegisterRepositoryInput = { path, project, commands };
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
      `Your checkout was not modified.\n`,
  );
  return 0;
}

function override(flag: string | undefined, detected: string | null): string | null {
  if (flag === undefined) return detected;
  return flag.trim() === '' ? null : flag.trim();
}
