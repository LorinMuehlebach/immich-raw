import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some tests encode or decode whole images; with the files running in parallel on a busy
    // machine they pass in 5-20 s, so the default 5 s fails them at random.
    testTimeout: 60_000,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'notices.test.ts'],
  },
});
