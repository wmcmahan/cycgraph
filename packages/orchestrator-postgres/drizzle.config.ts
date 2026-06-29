import { defineConfig } from 'drizzle-kit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve paths relative to THIS config file, not the caller's CWD — so the
// root `db:push:engine` script (which passes --config=node_modules/.../drizzle.config.ts)
// finds the schema even when run from the consuming repo.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: join(here, 'src/schema.ts'),
  out: join(here, 'drizzle'),
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres',
  },
});
