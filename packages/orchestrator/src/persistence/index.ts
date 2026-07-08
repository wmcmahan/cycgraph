/**
 * Persistence Module — Public API
 *
 * Explicit named re-exports (NOT `export *`) so a new symbol added to any
 * leaf file does NOT silently enter the package's public/semver surface —
 * adding one here is a deliberate act. See the root `src/index.ts` note.
 *
 * @module persistence
 */

// ─── Interfaces (types only) ───────────────────────────────────────────
export type {
  JsonValue,
  GraphDefinitionJson,
  WorkflowStateJson,
  WorkflowRunRow,
  WorkflowEventRow,
  GraphRow,
  PersistenceProvider,
  AgentRegistryEntry,
  AgentRegistryInput,
  AgentRegistryConfig,
  AgentRegistry,
  MCPServerRegistry,
  UsageRecord,
  UsageRecorder,
  RetentionService,
} from './interfaces.js';

// ─── In-memory implementations ─────────────────────────────────────────
export {
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  InMemoryUsageRecorder,
  InMemoryRetentionService,
} from './in-memory.js';

// ─── Delta tracker ─────────────────────────────────────────────────────
export { StateDeltaTracker } from './delta-tracker.js';
export type { StatePatch, DeltaResult, StateDeltaTrackerOptions } from './delta-tracker.js';

// ─── Durable job queue ─────────────────────────────────────────────────
export { WorkflowJobStatusSchema, WorkflowJobSchema } from './queue-interfaces.js';
export type {
  WorkflowJobStatus,
  WorkflowJob,
  EnqueueJobInput,
  QueueDepth,
  WorkflowQueue,
} from './queue-interfaces.js';
export { InMemoryWorkflowQueue, retryBackoffDelayMs } from './in-memory-queue.js';
export type { WorkflowQueueOptions } from './in-memory-queue.js';

// ─── Errors ────────────────────────────────────────────────────────────
export { StaleClaimError } from './errors.js';
