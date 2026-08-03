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
      include: ['src/**'],
      exclude: [
        'src/index.ts',
        'src/internal.ts',
        'src/**/index.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
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
