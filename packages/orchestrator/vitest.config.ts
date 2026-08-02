import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Measure the source tree only — not the built dist/, scripts, examples,
      // or barrel/type files that have no testable logic.
      include: ['src/**'],
      exclude: [
        'src/index.ts',
        'src/internal.ts',
        'src/**/index.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      // Regression ratchet: thresholds sit a few points below measured coverage
      // so a meaningful drop fails CI, but normal churn doesn't. Raise these as
      // coverage improves; never lower them to make a red build pass.
      thresholds: {
        statements: 97,
        functions: 96,
        branches: 95,
        lines: 97,
        'src/runner/**': {
          statements: 96,
          functions: 95,
          branches: 93,
        },
        'src/agent/**': {
          statements: 99,
          functions: 99,
          branches: 98,
        },
      },
    },
  },
});
