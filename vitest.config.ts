import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The `[real]` tests run only on demand: `pnpm test:real` (vitest.real.config.ts).
    exclude: [...configDefaults.exclude, 'tests/real/**'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
