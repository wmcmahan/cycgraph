import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // The example suites under examples/ are written the way a consumer
      // writes them — importing the package by name, which resolves through
      // `dist/`. Tests must not depend on a build artifact (and must measure
      // src), so the self-reference is pinned to the source barrel here.
      {
        find: /^@cycgraph\/orchestrator$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
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
