/**
 * The Repository Profile, v2 (ADR-0051, ADR-0060), and Profile Detection: a
 * deterministic inspection of a snapshot of a Repository's files, no LLM.
 * Detection only proposes; a human confirms every value before it is saved,
 * and the setup command is never detected (ADR-0047). Repository content is
 * untrusted, so a malformed file means "nothing detected", never an error.
 * Pure: the runtime gathers the snapshot, without writing anything.
 */
import { z } from 'zod';
import { SetupCommandSchema } from './setup.js';

export const PackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

const legacyCommand = z.string().trim().min(1).max(1000).nullable();

/** The v1 profile's two commands (`null`: none). Read only to upgrade a v1 profile or snapshot. */
export const RepositoryCommandsSchema = z.object({ test: legacyCommand, typecheck: legacyCommand });
export type RepositoryCommands = z.infer<typeof RepositoryCommandsSchema>;

/** A profile command's name: `test`, `typecheck`, `lint`, `build`, or one a human adds. */
export const ProfileCommandNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9:_-]{0,39}$/,
    'must be lowercase letters, digits, ":", "_" or "-", starting with a letter',
  );

/** One named command. `acceptsArgs`: a Task may append validated arguments (ADR-0051). */
export const ProfileCommandSchema = z.object({
  run: SetupCommandSchema,
  acceptsArgs: z.boolean(),
});
export type ProfileCommand = z.infer<typeof ProfileCommandSchema>;

const namedCommands = z
  .record(ProfileCommandNameSchema, ProfileCommandSchema)
  .refine((c) => Object.keys(c).length <= 30, 'at most 30 commands');

/** The v1 `{test, typecheck}` shape as named commands: each non-null one, no arguments. */
export function namedFromLegacy(commands: RepositoryCommands): Record<string, ProfileCommand> {
  return Object.fromEntries(
    (['test', 'typecheck'] as const).flatMap((name) => {
      const run = commands[name];
      return run === null ? [] : [[name, { run, acceptsArgs: false }]];
    }),
  );
}

/** Named commands; the v1 `{test, typecheck}` shape (in old profiles and snapshots) is upgraded. */
export const ProfileCommandsSchema = z.preprocess((value) => {
  const legacy = RepositoryCommandsSchema.strict().safeParse(value);
  return legacy.success ? namedFromLegacy(legacy.data) : value;
}, namedCommands);
export type ProfileCommands = z.infer<typeof ProfileCommandsSchema>;

const repoPath = z.string().trim().min(1).max(500);

/** A CI workflow file and the check names its jobs would report: candidates for `requiredChecks`. */
export const CiFileSchema = z.object({
  path: repoPath,
  checks: z.array(z.string().min(1).max(200)).max(100),
});
export type CiFile = z.infer<typeof CiFileSchema>;

/** The files agents take as the Repository's own rules. Listed, never written. */
export const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'] as const;

/**
 * The fixed Sensitive Paths every profile starts with (picomatch globs, as
 * the path-scope Gate reads them). Every instruction file found is added.
 */
export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
  '.env*',
  '**/.env*',
  '.github/workflows/**',
  'infra/**',
  '**/*.pem',
  '**/*.key',
];

const pathList = z.array(repoPath).max(200);

const ProfileV2Schema = z.object({
  version: z.literal(2),
  /** `detected`: from Profile Detection, confirmed by a human; `not_detected`: upgraded from v1. */
  detection: z.enum(['detected', 'not_detected']),
  packageManager: PackageManagerSchema.nullable(),
  commands: ProfileCommandsSchema,
  ciFiles: z.array(CiFileSchema).max(50),
  instructionFiles: pathList,
  sensitivePaths: pathList,
  /**
   * The checks the Merge Gate counts (#58): when set, only these, and each
   * must report (never passed by the grace window). Unset or empty: every
   * check on the PR head. Human-set; CI files only propose candidates.
   */
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /**
   * The setup command the factory runs in each Worktree before the Harness
   * Run and verification (ADR-0047). Set by a human only, never detected.
   * Unset: no setup runs.
   */
  setup: SetupCommandSchema.optional(),
  confirmedBy: z.string(),
  confirmedAt: z.string(),
});

const ProfileV1Schema = z.object({
  version: z.literal(1),
  packageManager: PackageManagerSchema.nullable(),
  commands: RepositoryCommandsSchema,
  requiredChecks: z.array(z.string()).optional(),
  setup: z.string().optional(),
  confirmedBy: z.string(),
  confirmedAt: z.string(),
});

/**
 * What the factory knows about how to work in a Repository. A v1 profile
 * (from before Phase D) is read as v2 without detection: marked
 * `not_detected`, with the default Sensitive Paths (ADR-0051).
 */
export const RepositoryProfileSchema = z.preprocess((value) => {
  const v1 = ProfileV1Schema.safeParse(value);
  if (!v1.success) return value;
  const { version: _v, commands, ...rest } = v1.data;
  return {
    ...rest,
    version: 2,
    detection: 'not_detected',
    commands: namedFromLegacy(commands),
    ciFiles: [],
    instructionFiles: [],
    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
  };
}, ProfileV2Schema);
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

/** What Profile Detection proposes: the detectable fields of a profile. */
export const DetectedProfileSchema = ProfileV2Schema.pick({
  packageManager: true,
  commands: true,
  ciFiles: true,
  instructionFiles: true,
  sensitivePaths: true,
});
export type DetectedProfile = z.infer<typeof DetectedProfileSchema>;

/** The Repository's tracked paths, plus the contents of the files `profileDetectionReads` names. */
export interface FileSnapshot {
  paths: readonly string[];
  /** Path → content; a file too large or unreadable is left out. */
  files: Readonly<Record<string, string>>;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The few files whose contents detection reads, of `paths`, sorted. */
export function profileDetectionReads(paths: readonly string[]): string[] {
  return paths.filter((p) => p === 'package.json' || WORKFLOW.test(p)).sort();
}

/** Proposes a profile from a snapshot. Deterministic; reads nothing but the snapshot. */
export function detectProfile(snapshot: FileSnapshot): DetectedProfile {
  const paths = new Set(snapshot.paths);
  const manifest = parseManifest(snapshot.files['package.json']);
  const packageManager = paths.has('package.json')
    ? packageManagerOf(paths, manifest?.packageManager)
    : null;
  const commands =
    packageManager === null || manifest === undefined
      ? {}
      : commandsOf(packageManager, manifest.scripts);
  const ciFiles = profileDetectionReads(snapshot.paths)
    .filter((p) => WORKFLOW.test(p))
    .map((path) => ({ path, checks: workflowChecks(snapshot.files[path] ?? '') }));
  const names: readonly string[] = INSTRUCTION_FILE_NAMES;
  const instructionFiles = [...paths]
    .filter((p) => names.includes(p.slice(p.lastIndexOf('/') + 1)))
    .sort();
  return {
    packageManager,
    commands,
    ciFiles,
    instructionFiles,
    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS, ...instructionFiles],
  };
}

interface Manifest {
  scripts: Record<string, unknown>;
  packageManager: unknown;
}

function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof pkg !== 'object' || pkg === null) return undefined;
  const { scripts, packageManager } = pkg as { scripts?: unknown; packageManager?: unknown };
  return {
    scripts:
      typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
        ? (scripts as Record<string, unknown>)
        : {},
    packageManager,
  };
}

function packageManagerOf(paths: ReadonlySet<string>, declared: unknown): PackageManager {
  if (typeof declared === 'string') {
    const name = PackageManagerSchema.safeParse(declared.split('@', 1)[0]);
    if (name.success) return name.data;
  }
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('yarn.lock')) return 'yarn';
  if (paths.has('bun.lock') || paths.has('bun.lockb')) return 'bun';
  return 'npm';
}

/** Each named command and the scripts that may provide it, first found wins. */
const COMMAND_SCRIPTS: readonly (readonly [string, readonly string[]])[] = [
  ['build', ['build']],
  ['lint', ['lint']],
  ['test', ['test']],
  ['typecheck', ['typecheck', 'type-check', 'tsc']],
];

function commandsOf(
  pm: PackageManager,
  scripts: Record<string, unknown>,
): Record<string, ProfileCommand> {
  const out: Record<string, ProfileCommand> = {};
  for (const [name, candidates] of COMMAND_SCRIPTS) {
    const script = candidates.find((s) => typeof scripts[s] === 'string');
    if (script === undefined) continue;
    const body = scripts[script] as string;
    if (name === 'test' && body.includes('no test specified')) continue; // npm's placeholder
    const run =
      name === 'test' && pm !== 'bun'
        ? `${pm} test`
        : `${pm === 'npm' ? 'npm run' : `${pm} run`} ${script}`;
    out[name] = { run, acceptsArgs: false };
  }
  return out;
}

const KEY_LINE = /^(\s*)("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

/**
 * The check names a GitHub Actions workflow's jobs report: each job's `name`,
 * else its id. A name built from an expression (`${{ … }}`) is left out: its
 * checks are named only at run time. A plain line reader, not a YAML parser:
 * a workflow it can't follow yields fewer candidates, never an error.
 */
function workflowChecks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs\s*:\s*(#.*)?$/.test(l));
  if (start === -1) return [];
  const checks: string[] = [];
  let jobIndent: number | undefined;
  let job: { id: string; name: string | undefined; propIndent: number | undefined } | undefined;
  const finish = () => {
    if (job === undefined) return;
    const check = job.name ?? job.id;
    if (!check.includes('${{') && !checks.includes(check)) checks.push(check);
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    jobIndent ??= indent;
    const key = KEY_LINE.exec(line);
    if (indent === jobIndent) {
      finish();
      job =
        key === null
          ? undefined
          : { id: unquote(key[2] ?? ''), name: undefined, propIndent: undefined };
      continue;
    }
    if (job === undefined || indent < jobIndent) continue;
    job.propIndent ??= indent;
    if (indent === job.propIndent && key !== null && key[2] === 'name') {
      const value = scalar(key[3] ?? '');
      if (value !== '') job.name = value;
    }
  }
  finish();
  return checks;
}

function unquote(text: string): string {
  return /^(".*"|'.*')$/.test(text) ? text.slice(1, -1) : text;
}

function scalar(text: string): string {
  const trimmed = text.trim();
  if (/^(".*"|'.*')$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, '');
}

/** One profile field a change sets: shown before a detection is confirmed, and recorded after. */
export const ProfileChangeSchema = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type ProfileChange = z.infer<typeof ProfileChangeSchema>;

const DIFF_FIELDS = [
  'detection',
  'packageManager',
  'commands',
  'ciFiles',
  'instructionFiles',
  'sensitivePaths',
  'requiredChecks',
  'setup',
] as const;

/** The fields that differ between two profiles (the confirmation stamp aside), with both values. */
export function profileDiff(before: RepositoryProfile, after: RepositoryProfile): ProfileChange[] {
  return DIFF_FIELDS.filter((f) => canonical(before[f]) !== canonical(after[f])).map((field) => ({
    field,
    from: before[field] ?? null,
    to: after[field] ?? null,
  }));
}

/** What saving `detected` over `current` changes, field by field (the diff to confirm). */
export function profileChanges(
  current: RepositoryProfile,
  detected: DetectedProfile,
): ProfileChange[] {
  return profileDiff(current, applyDetection(current, detected, current.confirmedBy, current.confirmedAt));
}

/** JSON with object keys sorted, so key order never reads as a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** `detected` saved over `current`, confirmed by `actor` at `at`; the human-set fields are kept. */
export function applyDetection(
  current: RepositoryProfile,
  detected: DetectedProfile,
  actor: string,
  at: string,
): RepositoryProfile {
  return RepositoryProfileSchema.parse({
    ...current,
    ...DetectedProfileSchema.parse(detected),
    detection: 'detected',
    confirmedBy: actor,
    confirmedAt: at,
  });
}

/** The keys `repo profile set` takes; `commands.<name>` and `commands.<name>.acceptsArgs` too. */
export const PROFILE_SET_KEYS = [
  'packageManager',
  'instructionFiles',
  'sensitivePaths',
  'requiredChecks',
  'setup',
] as const;

export type ProfileSetResult =
  | { ok: true; profile: RepositoryProfile }
  | { ok: false; code: 'unknown_profile_key' | 'invalid_profile_value'; message: string };

/**
 * `repo profile set <repo> <key> <value>`: one field, from the text the human
 * typed. Lists are JSON arrays; an empty value removes a command or the setup
 * command; `packageManager none` clears it. Detection status, CI files and the
 * confirmation stamp are not settable (the runtime stamps the confirmation).
 */
export function setProfileField(
  profile: RepositoryProfile,
  key: string,
  raw: string,
): ProfileSetResult {
  const invalid = (message: string): ProfileSetResult => ({
    ok: false,
    code: 'invalid_profile_value',
    message: `${key}: ${message}`,
  });
  const next = (patch: Partial<RepositoryProfile>): ProfileSetResult => {
    const parsed = RepositoryProfileSchema.safeParse({ ...profile, ...patch });
    return parsed.success
      ? { ok: true, profile: parsed.data }
      : invalid(parsed.error.issues.map((i) => i.message).join('; '));
  };
  const value = raw.trim();

  const command = /^commands\.([^.]+)(\.acceptsArgs)?$/.exec(key);
  if (command !== null) {
    const name = ProfileCommandNameSchema.safeParse(command[1]);
    if (!name.success) return invalid(name.error.issues.map((i) => i.message).join('; '));
    const commands = { ...profile.commands };
    const existing = commands[name.data];
    if (command[2] !== undefined) {
      if (existing === undefined)
        return invalid(`no command '${name.data}'; set its command first`);
      if (value !== 'true' && value !== 'false') return invalid('takes true or false');
      commands[name.data] = { ...existing, acceptsArgs: value === 'true' };
    } else if (value === '') {
      delete commands[name.data];
    } else {
      commands[name.data] = { run: value, acceptsArgs: existing?.acceptsArgs ?? false };
    }
    return next({ commands });
  }

  switch (key) {
    case 'packageManager': {
      if (value === 'none') return next({ packageManager: null });
      const pm = PackageManagerSchema.safeParse(value);
      return pm.success
        ? next({ packageManager: pm.data })
        : invalid(`takes ${PackageManagerSchema.options.join(', ')} or none`);
    }
    case 'setup': {
      if (value !== '') return next({ setup: value });
      const { setup: _s, ...rest } = profile;
      const parsed = RepositoryProfileSchema.safeParse(rest);
      return parsed.success ? { ok: true, profile: parsed.data } : invalid(parsed.error.message);
    }
    case 'instructionFiles':
    case 'sensitivePaths':
    case 'requiredChecks': {
      let list: unknown;
      try {
        list = JSON.parse(value);
      } catch {
        return invalid('takes a JSON array of strings, for example \'["infra/**"]\'');
      }
      if (!Array.isArray(list)) {
        return invalid('takes a JSON array of strings, for example \'["infra/**"]\'');
      }
      return next({ [key]: list });
    }
    default:
      return {
        ok: false,
        code: 'unknown_profile_key',
        message: `unknown profile key '${key}'. Keys: ${[...PROFILE_SET_KEYS, 'commands.<name>', 'commands.<name>.acceptsArgs'].join(', ')}`,
      };
  }
}

const RepositoryRefSchema = z.object({ id: z.string(), name: z.string() });

/** `POST /v1/repositories/:ref/profile/detect`: a read-only proposal and the diff to confirm. */
export const ProfileDetectionSchema = z.object({
  repository: RepositoryRefSchema,
  current: RepositoryProfileSchema,
  detected: DetectedProfileSchema,
  changes: z.array(ProfileChangeSchema),
});
export type ProfileDetection = z.infer<typeof ProfileDetectionSchema>;

/**
 * `POST /v1/repositories/:ref/profile/apply`: the detected fields as the human
 * confirmed them. `basis` is the shown profile's `confirmedAt`: a profile
 * changed since is refused, so a confirmation never lands on a newer profile.
 */
export const ApplyProfileDetectionInputSchema = z.object({
  detected: DetectedProfileSchema,
  basis: z.string().min(1),
});
export type ApplyProfileDetectionInput = z.infer<typeof ApplyProfileDetectionInputSchema>;

/** `POST /v1/repositories/:ref/profile/set` (`repo profile set`): one field, as typed. */
export const SetProfileFieldInputSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(10_000),
});
export type SetProfileFieldInput = z.infer<typeof SetProfileFieldInputSchema>;

/** What a profile change returns: the Repository's new profile and what changed. */
export const ProfileUpdateSchema = z.object({
  repository: RepositoryRefSchema,
  profile: RepositoryProfileSchema,
  changes: z.array(ProfileChangeSchema),
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
