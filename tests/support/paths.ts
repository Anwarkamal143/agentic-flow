import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const cliEntry = fileURLToPath(new URL('../../apps/cli/dist/main.js', import.meta.url));
export const runtimeEntry = fileURLToPath(
  new URL('../../apps/runtime/dist/main.js', import.meta.url),
);
export const tinyTsScript = fileURLToPath(
  new URL('../../fixtures/create-tiny-ts.mjs', import.meta.url),
);
export const dashboardDir = fileURLToPath(new URL('../../apps/dashboard', import.meta.url));
