import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Every test file talks to the SAME Postgres database and truncates all
    // tables in beforeEach. Running files in parallel workers means one file's
    // truncate wipes another's rows mid-test (orphaned FKs, short result sets).
    // Force sequential file execution so the shared DB isn't a race.
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    // Skip tests when DATABASE_URL is not available (CI-friendly)
    ...(process.env.DATABASE_URL ? {} : { skip: true }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
