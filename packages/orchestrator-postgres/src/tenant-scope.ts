/**
 * Tenant Scope — per-request tenant-scoped adapter bundle.
 *
 * The control-plane seam: given a {@link TenantContext} (resolved from an API
 * key by the HTTP layer, or read from `job.tenant_id` by a worker), build the
 * complete set of adapters already bound to that tenant. Every read/write
 * through a scope is isolated — the app-level `tenant_id` filter today, and
 * Postgres RLS once `APP_DATABASE_URL` points at the `cycgraph_app` role.
 *
 * The engine stays tenant-agnostic: a worker wires `scope.persistence` /
 * `scope.eventLog` into `GraphRunnerOptions` exactly as it would the
 * single-tenant adapters — the tenant boundary is entirely inside the scope.
 *
 * Two scopes, matching the two planes (see {@link module:tenancy}):
 *   - {@link createTenantScope} — the tenant plane (RLS-subject).
 *   - {@link createPlatformScope} — the cross-tenant platform plane (queue,
 *     retention); these take NO tenant and run as the owner.
 *
 * @example Worker loop
 * ```ts
 * const platform = createPlatformScope();
 * const job = await platform.queue.dequeue(workerId);
 * if (job) {
 *   const scope = createTenantScope(
 *     { tenant_id: job.tenant_id! },
 *     { fencing: { run_id: job.run_id, epoch: job.claim_epoch! } },
 *   );
 *   const runner = new GraphRunner(graph, state, {
 *     persistenceProvider: scope.persistence,
 *     eventLogWriter: scope.eventLog,
 *     usageRecorder: scope.usage,
 *     // …memoryRetriever/memoryWriter built over scope.memoryStore/Index/outcomeLedger
 *   });
 * }
 * ```
 *
 * @module @cycgraph/orchestrator-postgres/tenant-scope
 */

import type { TenantContext } from './tenancy.js';
import { DrizzlePersistenceProvider, type RunClaim } from './drizzle-persistence.js';
import { DrizzleEventLogWriter } from './drizzle-event-log.js';
import { DrizzleUsageRecorder } from './drizzle-usage.js';
import { DrizzleAgentRegistry } from './drizzle-agent-registry.js';
import { DrizzleMCPServerRegistry } from './drizzle-mcp-registry.js';
import { DrizzleMemoryStore } from './drizzle-memory-store.js';
import { DrizzleMemoryIndex } from './drizzle-memory-index.js';
import { DrizzleOutcomeLedger } from './drizzle-outcome-ledger.js';
import { DrizzleWorkflowQueue } from './drizzle-queue.js';
import { DrizzleRetentionService } from './drizzle-retention.js';

/** Every tenant-scoped adapter, bound to one tenant. */
export interface TenantScope {
  readonly tenant: TenantContext;
  readonly persistence: DrizzlePersistenceProvider;
  readonly eventLog: DrizzleEventLogWriter;
  readonly usage: DrizzleUsageRecorder;
  readonly agents: DrizzleAgentRegistry;
  readonly mcpServers: DrizzleMCPServerRegistry;
  readonly memoryStore: DrizzleMemoryStore;
  readonly memoryIndex: DrizzleMemoryIndex;
  readonly outcomeLedger: DrizzleOutcomeLedger;
}

export interface CreateTenantScopeOptions {
  /**
   * Run fencing claim for this request — flows into the persistence provider
   * and event-log writer so a reclaimed worker's stale writes are rejected.
   * Supplied by a worker from the dequeued job's `run_id` + `claim_epoch`.
   */
  fencing?: RunClaim;
  /** Checkpoint retention window for the event-log writer (default 3). */
  retainCheckpoints?: number;
}

/**
 * Build the tenant-plane adapter bundle for `tenant`. Pure construction — no
 * I/O — so it is cheap to call once per request.
 */
export function createTenantScope(
  tenant: TenantContext,
  opts: CreateTenantScopeOptions = {},
): TenantScope {
  const { fencing, retainCheckpoints } = opts;
  return {
    tenant,
    persistence: new DrizzlePersistenceProvider({ tenant, fencing }),
    eventLog: new DrizzleEventLogWriter({ tenant, fencing, retain_checkpoints: retainCheckpoints }),
    usage: new DrizzleUsageRecorder({ tenant }),
    agents: new DrizzleAgentRegistry({ tenant }),
    mcpServers: new DrizzleMCPServerRegistry({ tenant }),
    memoryStore: new DrizzleMemoryStore({ tenant }),
    memoryIndex: new DrizzleMemoryIndex({ tenant }),
    outcomeLedger: new DrizzleOutcomeLedger({ tenant }),
  };
}

/** The cross-tenant platform-plane adapters (run as the owner, no tenant). */
export interface PlatformScope {
  readonly queue: DrizzleWorkflowQueue;
  readonly retention: DrizzleRetentionService;
}

/** Build the platform-plane adapter bundle (queue + retention). */
export function createPlatformScope(): PlatformScope {
  return {
    queue: new DrizzleWorkflowQueue(),
    retention: new DrizzleRetentionService(),
  };
}
