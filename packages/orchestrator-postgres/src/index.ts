/**
 * @cycgraph/orchestrator-postgres
 *
 * Official PostgreSQL adapter for @cycgraph/orchestrator.
 * Provides Drizzle ORM implementations of all persistence interfaces.
 *
 * @example
 * ```ts
 * import { getDb, closeDb, DrizzlePersistenceProvider, DrizzleAgentRegistry } from '@cycgraph/orchestrator-postgres';
 * import { configureAgentFactory, GraphRunner } from '@cycgraph/orchestrator';
 *
 * await getDb();
 * configureAgentFactory(new DrizzleAgentRegistry());
 * const persistence = new DrizzlePersistenceProvider();
 * ```
 */

// Connection management
export { db, getDb, getPool, closeDb, getPoolMetrics } from './connection.js';
export type { PoolMetrics } from './connection.js';

// Schema + types
export * from './schema.js';

// Persistence adapters
export { DrizzlePersistenceProvider, toWorkflowStateJson } from './drizzle-persistence.js';
export { DrizzleEventLogWriter } from './drizzle-event-log.js';
export { DrizzleUsageRecorder } from './drizzle-usage.js';
export { DrizzleRetentionService } from './drizzle-retention.js';
export { DrizzleAgentRegistry } from './drizzle-agent-registry.js';
export { DrizzleMCPServerRegistry } from './drizzle-mcp-registry.js';
export { DrizzleMemoryStore } from './drizzle-memory-store.js';
export { DrizzleMemoryIndex } from './drizzle-memory-index.js';
export { DrizzleWorkflowQueue } from './drizzle-queue.js';
export type { DrizzlePersistenceProviderOptions, RunClaim } from './drizzle-persistence.js';
export type { DrizzleEventLogWriterOptions } from './drizzle-event-log.js';

// Run fencing
export { createFencedRunnerOptions } from './fencing.js';
