import { defineConfig } from 'vitest/config';

// This suite deletes table contents as it runs. A DATABASE_URL pointing
// anywhere but a local instance is almost certainly a production
// database inherited from the environment — refuse it outright rather
// than wipe it. CYCGRAPH_TEST_REMOTE_DB=1 overrides deliberately.
const url = process.env.DATABASE_URL;
if (url !== undefined && url !== '' && process.env.CYCGRAPH_TEST_REMOTE_DB !== '1') {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to run the orchestrator-postgres test suite against non-local host '${host}': `
      + 'the suite deletes table contents. Point DATABASE_URL at a local instance, '
      + 'or set CYCGRAPH_TEST_REMOTE_DB=1 to override deliberately.');
  }
}

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
