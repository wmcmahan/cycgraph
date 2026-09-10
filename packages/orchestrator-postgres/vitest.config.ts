import { defineConfig } from 'vitest/config';

// This suite deletes table contents as it runs. A DATABASE_URL pointing
// anywhere but a local instance is almost certainly a production
// database inherited from the environment — refuse it outright rather
// than wipe it. CYCGRAPH_TEST_REMOTE_DB=1 overrides deliberately.
const url = process.env.DATABASE_URL;
if (url !== undefined && url !== '' && process.env.CYCGRAPH_TEST_REMOTE_DB !== '1') {
  // URL.hostname keeps the brackets of an IPv6 literal, and a libpq
  // keyword/value connstring ("host=... dbname=...") is not a URL at
  // all — an unparseable value has no host to vouch for and is refused.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = '(unparseable DATABASE_URL)';
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'];
  if (!local.includes(host)) {
    throw new Error(
      `Refusing to run the orchestrator-postgres test suite against non-local host '${host}': `
      + 'the suite deletes table contents. Point DATABASE_URL at a local instance in URL form, '
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
