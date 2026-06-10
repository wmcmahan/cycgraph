/**
 * Test Setup for orchestrator-postgres
 *
 * Connects to the Docker Compose Postgres instance (port 5433)
 * and provides helpers for table truncation between tests.
 *
 * Tests are skipped automatically when DATABASE_URL is not set.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../src/connection.js';
import {
  graphs,
  workflow_runs,
  workflow_states,
  workflow_events,
  workflow_checkpoints,
  workflow_jobs,
  agents,
  memory_entity_facts,
  memory_facts,
  memory_relationships,
  memory_episodes,
  memory_themes,
  memory_entities,
} from '../src/schema.js';
import { beforeAll, afterAll, beforeEach } from 'vitest';

/** All engine tables, in safe truncation order (respecting FK constraints). */
const TRUNCATABLE_TABLES = [
  // Memory tables (FK order)
  memory_entity_facts,
  memory_facts,
  memory_relationships,
  memory_episodes,
  memory_themes,
  memory_entities,
  // Engine tables
  workflow_jobs,
  workflow_checkpoints,
  workflow_events,
  workflow_states,
  workflow_runs,
  graphs,
  agents,
] as const;

/**
 * Check if the database is available for testing.
 * Returns false when DATABASE_URL is not set.
 */
export function isDatabaseAvailable(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Standard test lifecycle hooks for database tests.
 *
 * Call this at the top of each test file:
 * ```ts
 * import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
 * import { describe } from 'vitest';
 *
 * describe.skipIf(!isDatabaseAvailable())('MyTests', () => {
 *   setupDatabaseTests();
 *   // ... tests
 * });
 * ```
 */
export function setupDatabaseTests(): void {
  beforeAll(async () => {
    await getDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeDb();
  });
}

/**
 * Truncate all engine tables (CASCADE) to ensure a clean state.
 */
async function truncateAllTables(): Promise<void> {
  const db = await getDb();
  for (const table of TRUNCATABLE_TABLES) {
    await db.delete(table);
  }
}

/**
 * Insert a minimal `graphs` + `workflow_runs` row so a `run_id` satisfies the
 * `workflow_events` / `workflow_states` / `workflow_checkpoints` foreign keys.
 *
 * In production the queue creates the run row before any events are appended;
 * unit tests of the event log / persistence must replicate that. Idempotent
 * (safe to call once per run id). Returns the seeded run id.
 */
export async function seedRun(runId: string): Promise<string> {
  const db = await getDb();
  const graphId = randomUUID();
  await db
    .insert(graphs)
    .values({ id: graphId, name: 'test-graph', definition: { nodes: [], edges: [] } as never })
    .onConflictDoNothing();
  await db
    .insert(workflow_runs)
    .values({ id: runId, graph_id: graphId, status: 'running' })
    .onConflictDoNothing();
  return runId;
}

export { getDb, closeDb };
