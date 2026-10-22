import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every file resets the same claims_test schema.
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
