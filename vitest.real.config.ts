import { defineConfig } from 'vitest/config';

/** The `[real]` tests (`pnpm test:real`): real Harnesses, the network, minutes per test. Never in CI. */
export default defineConfig({
  test: {
    include: ['tests/real/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 45 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
