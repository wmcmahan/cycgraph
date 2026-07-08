import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Regression ratchet: floors sit a few points below measured coverage
      // (86/82/96/89 as of 2026-07) so a meaningful drop fails CI while normal
      // churn doesn't. Raise as coverage improves; never lower to pass a build.
      thresholds: {
        statements: 82,
        branches: 76,
        functions: 90,
        lines: 84,
      },
    },
  },
});
