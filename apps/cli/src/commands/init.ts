import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DEFAULT_PORT,
  createToken,
  ensureHomeDirs,
  readConfig,
  readToken,
  resolveHome,
  writeConfig,
} from '@factory/home';

export async function init(opts: { workspaceRoot: string | undefined }): Promise<number> {
  const home = resolveHome();
  const existing = readConfig(home);
  if (existing !== undefined && readToken(home) !== undefined) {
    process.stdout.write(
      `Factory home already initialized: ${home.root}\n` +
        `  workspace root: ${existing.workspaceRoot}\n` +
        `Nothing changed.\n`,
    );
    return 0;
  }

  const fallback = join(home.root, 'workspace');
  const answer = opts.workspaceRoot ?? (await ask(`Workspace root [${fallback}]: `));
  const workspaceRoot = resolve(
    answer === undefined || answer.trim() === '' ? fallback : answer.trim(),
  );

  ensureHomeDirs(home);
  mkdirSync(workspaceRoot, { recursive: true });
  if (!existsSync(home.tokenPath)) createToken(home);
  writeConfig(home, { version: 1, workspaceRoot, port: existing?.port ?? DEFAULT_PORT });

  process.stdout.write(
    `Initialized factory home: ${home.root}\n` +
      `  token:          ${home.tokenPath} (mode 0600; keep it private)\n` +
      `  workspace root: ${workspaceRoot}\n` +
      `Next: factory start\n`,
  );
  return 0;
}

/** Reads one line from stdin. Resolves undefined if stdin ends first. */
async function ask(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(prompt);
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}
