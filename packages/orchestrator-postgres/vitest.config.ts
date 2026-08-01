import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    ...(process.env.DATABASE_URL ? {} : { skip: true }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      ...(process.env.DATABASE_URL
        ? {
          thresholds: {
            statements: 92,
            branches: 85,
            functions: 93,
            lines: 92,
          },
        }
        : {}),
    },
  },
});
