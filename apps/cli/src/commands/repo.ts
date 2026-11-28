import { resolve } from 'node:path';
import {
  chooseProject,
  formatCoordinates,
  MergeMethodSchema,
  SetupCommandSchema,
  MergePolicySchema,
  parseCoordinates,
  type ProjectSummary,
  type RegisterRepositoryInput,
  type RegisterRepositoryResult,
  type ApplyProfileDetectionInput,
  type DetectedProfile,
  type ProfileChange,
  type ProfileDetection,
  type ProfileUpdate,
  type SetProfileFieldInput,
  type RepositoryInspection,
  type Repository,
  type SetIntakeLabelInput,
} from '@factory/domain';
import { resolveHome } from '@factory/home';
import { findRuntime } from '../client.js';
import { ask } from '../prompt.js';
import { client } from './job.js';
import { EXIT_NOT_RUNNING } from './lifecycle.js';

/** Cloning a large repository can take a while; the runtime does it inside the request. */
const REGISTER_TIMEOUT_MS = 10 * 60_000;

export interface RepoAddOptions {
  path: string;
  /** An existing Project's name or id; unset: the only Project. */
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
  /** `--intake-label`: opts the Repository into GitHub Issues intake (#112). */
  intakeLabel: string | undefined;
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

  // A Project is named, or the only one; never created here (ADR-0055).
  const chosen = chooseProject(
    await client.json<ProjectSummary[]>('GET', '/v1/projects'),
    opts.project,
  );
  if (!chosen.ok) {
    process.stderr.write(`factory: ${chosen.message}\nNothing registered.\n`);
    return 1;
  }
  const project = chosen.project.name;
  const inspection = await client.json<RepositoryInspection>('POST', '/v1/repositories/inspect', {
    body: { path },
  });
  const { detected } = inspection;
  // --test-command / --typecheck-command replace a detected command; an empty value removes it.
  const flags: Record<string, string | undefined> = {
    test: opts.testCommand?.trim(),
    typecheck: opts.typecheckCommand?.trim(),
  };
  const commands = Object.fromEntries(
    [...new Set([...Object.keys(detected.commands), 'test', 'typecheck'])].flatMap((name) => {
      const flag = flags[name];
      const command =
        flag === undefined
          ? detected.commands[name]
          : flag === ''
            ? undefined
            : { run: flag, acceptsArgs: false };
      return command === undefined ? [] : [[name, command] as const];
    }),
  );
  const profile: DetectedProfile = { ...detected, commands };
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
      `Repository Profile (detected from the files of ${inspection.name}'s HEAD; nothing is saved until you confirm):\n` +
      profileLines(profile, {
        test: opts.testCommand === undefined ? 'detected' : 'from --test-command',
        typecheck: opts.typecheckCommand === undefined ? 'detected' : 'from --typecheck-command',
      }) +
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
    const answer = (await ask('Save this profile and register the Repository? [y/N] '))?.trim();
    if (answer === undefined || !/^y(es)?$/i.test(answer)) {
      process.stderr.write(
        'Nothing registered. To change a command, re-run with --test-command or --typecheck-command; any field can be changed after registering, with factory repo profile set.\n',
      );
      return 1;
    }
  }

  const input: RegisterRepositoryInput = {
    path,
    project,
    profile,
    ...(opts.github === undefined ? {} : { github: opts.github.trim() }),
    ...(opts.requiredChecks.length === 0 ? {} : { requiredChecks: opts.requiredChecks }),
    ...(setup === undefined ? {} : { setup: setup.data }),
    mergePolicy: mergePolicy.data,
    mergeMethod: mergeMethod.data,
    ...(opts.intakeLabel === undefined ? {} : { intakeLabel: opts.intakeLabel }),
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
      `  issue intake:   ${intakeLine(repository)}\n` +
      `Your checkout was not modified.\n`,
  );
  return 0;
}

/**
 * The detectable profile fields, one per line, as `repo add` and `repo
 * profile` show them. `origins` names where a command came from (default
 * `detected`).
 */
export function profileLines(
  profile: DetectedProfile,
  origins: Partial<Record<string, string>> = {},
): string {
  const lines = [`  package manager: ${profile.packageManager ?? 'none (no package.json)'}`];
  const names = Object.keys(profile.commands).sort();
  if (names.length === 0)
    lines.push('  commands:  none detected (add one with factory repo profile set)');
  else lines.push('  commands:');
  for (const name of names) {
    const command = profile.commands[name];
    if (command === undefined) continue;
    lines.push(
      `    ${`${name}:`.padEnd(11)}${command.run} (${origins[name] ?? 'detected'}${command.acceptsArgs ? '; accepts arguments' : ''})`,
    );
  }
  lines.push(
    profile.ciFiles.length === 0
      ? '  CI files:  none'
      : `  CI files:  ${profile.ciFiles
          .map(
            (f) =>
              `${f.path} (candidate checks: ${f.checks.length === 0 ? 'none found' : f.checks.join(', ')})`,
          )
          .join('; ')}`,
    `  instruction files: ${
      profile.instructionFiles.length === 0
        ? 'none'
        : `${profile.instructionFiles.join(', ')} (listed, never written)`
    }`,
    `  Sensitive Paths (no Task may write them): ${profile.sensitivePaths.join(', ')}`,
  );
  return lines.join('\n') + '\n';
}

function shownValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function changeLines(changes: readonly ProfileChange[]): string {
  return changes
    .map((c) => `  ${c.field}:\n    - ${shownValue(c.from)}\n    + ${shownValue(c.to)}\n`)
    .join('');
}

/**
 * `factory repo profile detect <repo> [--yes]`: Profile Detection over the
 * source's HEAD again, shown as a diff against the saved profile; saved only
 * once confirmed. The setup command and required checks are kept as they are.
 */
export async function repoProfileDetect(ref: string, opts: { yes: boolean }): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const path = `/v1/repositories/${encodeURIComponent(ref)}/profile/detect`;
  const detection = await api.json<ProfileDetection>('POST', path);
  const { repository } = detection;
  process.stdout.write(
    `Repository ${repository.name} (${repository.id}): Profile Detection proposes\n` +
      profileLines(detection.detected),
  );
  if (detection.changes.length === 0) {
    process.stdout.write('The saved profile already matches; nothing to change.\n');
    return 0;
  }
  process.stdout.write(
    `Changes to the saved profile (setup and required checks are kept):\n${changeLines(detection.changes)}`,
  );
  if (!opts.yes) {
    const answer = (await ask('Save these changes? [y/N] '))?.trim();
    if (answer === undefined || !/^y(es)?$/i.test(answer)) {
      process.stderr.write('Nothing changed.\n');
      return 1;
    }
  }
  const body: ApplyProfileDetectionInput = {
    detected: detection.detected,
    basis: detection.current.confirmedAt,
  };
  await api.json<ProfileUpdate>(
    'POST',
    `/v1/repositories/${encodeURIComponent(repository.id)}/profile/apply`,
    { body },
  );
  process.stdout.write(
    `Saved the detected profile of ${repository.name}. Jobs already created keep the configuration they froze.\n`,
  );
  return 0;
}

/** `factory repo profile set <repo> <key> <value>`: one field; the runtime validates it. */
/** Whether, and with which label, the Repository takes in GitHub issues. */
function intakeLine(repository: Repository): string {
  return repository.intakeLabel === null
    ? 'off'
    : `open issues labeled '${repository.intakeLabel}' become Inbox items "Start a Job from ${repository.github === null ? '?' : formatCoordinates(repository.github)}#N?"`;
}

/** `factory repo intake set <repo> <label>` / `repo intake off <repo>` (#112). */
export async function repoIntakeSet(ref: string, label: string | null): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: SetIntakeLabelInput = { label };
  const repository = await api.json<Repository>(
    'POST',
    `/v1/repositories/${encodeURIComponent(ref)}/intake`,
    { body },
  );
  process.stdout.write(
    `Repository ${repository.name}: issue intake ${intakeLine(repository)}` +
      (label === null ? '; its open intake items were cancelled\n' : '\n'),
  );
  return 0;
}

export async function repoProfileSet(ref: string, key: string, value: string): Promise<number> {
  const api = client();
  if (api === undefined) return EXIT_NOT_RUNNING;
  const body: SetProfileFieldInput = { key, value };
  const update = await api.json<ProfileUpdate>(
    'POST',
    `/v1/repositories/${encodeURIComponent(ref)}/profile/set`,
    { body },
  );
  process.stdout.write(
    update.changes.length === 0
      ? `Repository ${update.repository.name}: ${key} unchanged.\n`
      : `Repository ${update.repository.name}:\n${changeLines(update.changes)}` +
          'Jobs already created keep the configuration they froze; new Jobs use this profile.\n',
  );
  return 0;
}
