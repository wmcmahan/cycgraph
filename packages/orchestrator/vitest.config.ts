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
        'src/schemas.ts',
        'src/**/index.ts',
        'src/**/*.d.ts',
        // Wire schemas (were src/types/**): declarative Zod, excluded from coverage.
        'src/state/state.ts',
        'src/graph/graph.ts',
        'src/tools/schema.ts',
        'src/authoring/bundle-schema.ts',
        'src/persistence/event.ts',
        'src/utils/case-mapping.ts',
      ],
      thresholds: {
        statements: 97,
        functions: 96,
        branches: 95,
        lines: 97,
        'src/execution/**': {
          statements: 96,
          functions: 95,
          branches: 93,
        },
        'src/agents/**': {
          statements: 99,
          functions: 99,
          branches: 98,
        },
      },
    },
  },
});
