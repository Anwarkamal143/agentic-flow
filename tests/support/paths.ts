import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const cliEntry = fileURLToPath(new URL('../../apps/cli/dist/main.js', import.meta.url));
export const runtimeEntry = fileURLToPath(
  new URL('../../apps/runtime/dist/main.js', import.meta.url),
);
