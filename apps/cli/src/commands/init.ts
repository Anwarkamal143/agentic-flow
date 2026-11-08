import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PORT,
  createToken,
  ensureHomeDirs,
  readConfig,
  readToken,
  resolveHome,
  writeConfig,
} from '@factory/home';
import { ask } from '../prompt.js';

export async function init(opts: { workspaceRoot: string | undefined }): Promise<number> {
  const home = resolveHome();
  const existing = readConfig(home);
  if (existing !== undefined && readToken(home) !== undefined) {
    if (
      opts.workspaceRoot !== undefined &&
      resolve(opts.workspaceRoot) !== existing.workspaceRoot
    ) {
      process.stderr.write(
        `Factory home ${home.root} is already initialized with workspace root ` +
          `${existing.workspaceRoot}; refusing to change it to ${resolve(opts.workspaceRoot)}.\n`,
      );
      return 1;
    }
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
  writeConfig(home, {
    ...existing,
    version: 1,
    workspaceRoot,
    port: existing?.port ?? DEFAULT_PORT,
  });

  process.stdout.write(
    `Initialized factory home: ${home.root}\n` +
      `  token:          ${home.tokenPath} (mode 0600; keep it private)\n` +
      `  workspace root: ${workspaceRoot}\n` +
      `Next: factory start\n`,
  );
  return 0;
}
