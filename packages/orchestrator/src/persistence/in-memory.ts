/**
 * In-Memory Persistence Implementations
 *
 * Zero-dependency implementations of all persistence interfaces.
 * Suitable for prototyping, testing, and lightweight deployments.
 *
 * Data is lost when the process exits — use the Drizzle/Postgres
 * implementations from `@cycgraph/orchestrator-postgres` for production.
 *
 * @module persistence/in-memory
 */

import type { Graph } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import { hydrateWorkflowState } from '../types/state.js';
import type { MCPServerEntry, MCPServerConfig } from '../types/tools.js';
import { MCPServerEntrySchema } from '../types/tools.js';
import { camelToSnakeDeep } from '../types/case-mapping.js';
import type {
  PersistenceProvider,
  AgentRegistry,
  AgentRegistryEntry,
  AgentRegistryInput,
  AgentRegistryConfig,
  MCPServerRegistry,
  UsageRecorder,
  UsageRecord,
  RetentionService,
  GraphRow,
  WorkflowRunRow,
  WorkflowEventRow,
  WorkflowStateJson,
  GraphDefinitionJson,
} from './interfaces.js';

// ─── InMemoryPersistenceProvider ────────────────────────────────────────

/** Statuses that indicate a workflow run has reached a terminal state. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

/**
 * In-memory persistence provider.
 *
 * Stores all data in `Map` instances. Primarily used for unit tests
 * and lightweight deployments where durability is not required.
 */
export class InMemoryPersistenceProvider implements PersistenceProvider {
  private readonly graphs = new Map<string, GraphRow>();
  private readonly runs = new Map<string, WorkflowRunRow>();
  private readonly states = new Map<string, { version: number; state: WorkflowState; stateJson: WorkflowStateJson; created_at: Date }[]>();
  private readonly events = new Map<string, WorkflowEventRow[]>();

  // ── Graph Operations ──

  /** Save or upsert a graph definition. Preserves original `created_at`. */
  async saveGraph(graph: Graph): Promise<void> {
    const now = new Date();
    const existing = this.graphs.get(graph.id);
    const definition: GraphDefinitionJson = {
      id: graph.id,
      name: graph.name,
      nodes: graph.nodes as unknown[],
      edges: graph.edges as unknown[],
      start_node: graph.start_node,
      end_nodes: graph.end_nodes,
      description: graph.description,
    };
    this.graphs.set(graph.id, {
      id: graph.id,
      name: graph.name,
      description: graph.description ?? null,
      definition,
      version: '1.0.0',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
  }

  /** Load a graph by ID. Returns `null` if not found. */
  async loadGraph(graph_id: string): Promise<Graph | null> {
    const row = this.graphs.get(graph_id);
    return row ? (row.definition as unknown as Graph) : null;
  }

  /** List graphs ordered by `updated_at` descending (newest first). */
  async listGraphs(opts: { limit?: number; offset?: number } = {}): Promise<GraphRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return [...this.graphs.values()]
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(offset, offset + limit);
  }

  // ── Workflow Run Operations ──

  /** Save or upsert a workflow run record. Preserves original `created_at`. */
  async saveWorkflowRun(state: WorkflowState): Promise<void> {
    const isTerminal = TERMINAL_STATUSES.has(state.status);
    const existing = this.runs.get(state.run_id);
    this.runs.set(state.run_id, {
      id: state.run_id,
      workflow_id: null,
      graph_id: state.workflow_id,
      status: state.status,
      created_at: existing?.created_at ?? state.created_at ?? new Date(),
      parent_run_id: null,
      completed_at: isTerminal ? new Date() : null,
      archived_at: existing?.archived_at ?? null,
    });
  }

  /** Load a workflow run by ID. Returns `null` if not found. */
  async loadWorkflowRun(run_id: string): Promise<WorkflowRunRow | null> {
    return this.runs.get(run_id) ?? null;
  }

  /** List workflow runs ordered by `created_at` descending (newest first). */
  async listWorkflowRuns(opts: { limit?: number; offset?: number } = {}): Promise<WorkflowRunRow[]> {
    const { limit = 100, offset = 0 } = opts;
    return [...this.runs.values()]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(offset, offset + limit);
  }

  /** Update only the status of a run. Returns `0` if run not found, `1` on success. */
  async updateRunStatus(runId: string, status: string): Promise<number> {
    const run = this.runs.get(runId);
    if (!run) return 0;
    this.runs.set(runId, {
      ...run,
      status,
      completed_at: TERMINAL_STATUSES.has(status) ? new Date() : null,
    });
    return 1;
  }

  // ── Workflow State Operations ──

  /**
   * Save a state snapshot with an auto-incremented version.
   *
   * The state is deep-cloned via JSON round-trip to prevent external
   * mutation from affecting stored data.
   */
  async saveWorkflowState(state: WorkflowState): Promise<void> {
    const existing = this.states.get(state.run_id) ?? [];
    const maxVersion = existing.reduce((max, s) => Math.max(max, s.version), 0);
    const stateJson: WorkflowStateJson = {
      workflow_id: state.workflow_id,
      run_id: state.run_id,
      status: state.status,
      current_node: state.current_node,
      memory: state.memory,
      goal: state.goal,
      constraints: state.constraints,
      iteration_count: state.iteration_count,
      visited_nodes: state.visited_nodes,
      supervisor_history: state.supervisor_history,
      total_tokens_used: state.total_tokens_used,
      max_token_budget: state.max_token_budget,
      started_at: state.started_at,
      created_at: state.created_at,
      updated_at: state.updated_at,
      retry_count: state.retry_count,
      max_retries: state.max_retries,
      last_error: state.last_error,
      waiting_for: state.waiting_for,
      waiting_since: state.waiting_since,
      waiting_timeout_at: state.waiting_timeout_at,
      max_execution_time_ms: state.max_execution_time_ms,
      max_iterations: state.max_iterations,
      compensation_stack: state.compensation_stack,
    };
    existing.push({
      version: maxVersion + 1,
      state: JSON.parse(JSON.stringify(state)),
      stateJson,
      created_at: new Date(),
    });
    this.states.set(state.run_id, existing);
  }

  /** Load the latest state snapshot for a run (for crash recovery). */
  async loadLatestWorkflowState(run_id: string): Promise<WorkflowState | null> {
    const existing = this.states.get(run_id);
    if (!existing || existing.length === 0) return null;
    const sorted = [...existing].sort((a, b) => b.version - a.version);
    // The stored snapshot is a JSON clone (Dates are strings) — hydrate at
    // the load boundary, matching the Postgres adapter's behavior.
    return hydrateWorkflowState(sorted[0].state);
  }

  /** Load a lightweight state version history for a run. */
  async loadWorkflowStateHistory(
    run_id: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ version: number; status: string; current_node: string | null; created_at: Date; total_tokens_used: number | null }[]> {
    const { limit = 50, offset = 0 } = opts;
    const existing = this.states.get(run_id) ?? [];
    return [...existing]
      .sort((a, b) => a.version - b.version)
      .slice(offset, offset + limit)
      .map(s => ({
        version: s.version,
        status: s.state.status,
        current_node: s.state.current_node ?? null,
        created_at: s.created_at,
        total_tokens_used: s.state.total_tokens_used ?? null,
      }));
  }

  /** Load full state JSON at a specific version. */
  async loadWorkflowStateAtVersion(run_id: string, version: number): Promise<WorkflowStateJson | null> {
    const existing = this.states.get(run_id) ?? [];
    const entry = existing.find(s => s.version === version);
    return entry?.stateJson ?? null;
  }

  // ── Atomic Snapshot ──

  /** Atomically save both the workflow run record and state snapshot. */
  async saveWorkflowSnapshot(state: WorkflowState): Promise<void> {
    await this.saveWorkflowRun(state);
    await this.saveWorkflowState(state);
  }

  // ── Event Queries ──

  /** Load raw event rows for a run, ordered by `sequence_id` ascending. */
  async loadEvents(run_id: string): Promise<WorkflowEventRow[]> {
    return (this.events.get(run_id) ?? [])
      .sort((a, b) => a.sequence_id - b.sequence_id);
  }

  // ── Test Utilities ──

  /** Clear all stored data (for test teardown). */
  clear(): void {
    this.graphs.clear();
    this.runs.clear();
    this.states.clear();
    this.events.clear();
  }
}

// ─── InMemoryAgentRegistry ──────────────────────────────────────────────

/**
 * In-memory agent registry.
 *
 * Pre-populate with {@link register} for testing.
 */
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, AgentRegistryEntry>();

  /** Load an agent config by ID. Returns `null` if not registered. */
  async loadAgent(id: string): Promise<AgentRegistryEntry | null> {
    return this.agents.get(id) ?? null;
  }

  /**
   * Register an agent config and return its ID.
   *
   * If the input includes an `id`, it is used as-is (backwards compatible).
   * Otherwise, a UUID is auto-generated via `crypto.randomUUID()`.
   */
  register(entry: AgentRegistryConfig): string {
    // Remap camelCase authoring input to the snake_case wire shape. The remap
    // is idempotent, so snake_case callers keep working.
    const wire = camelToSnakeDeep(entry) as AgentRegistryInput & { id?: string };
    const id = wire.id ?? crypto.randomUUID();
    const full: AgentRegistryEntry = {
      description: null,
      temperature: 0.7,
      max_steps: 10,
      ...wire,
      id,
    };
    this.agents.set(id, full);
    return id;
  }

  /** Update an existing agent's configuration. Throws if not found. */
  async updateAgent(id: string, updates: Partial<AgentRegistryConfig>): Promise<void> {
    const existing = this.agents.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    const wire = camelToSnakeDeep(updates) as Partial<AgentRegistryInput>;
    this.agents.set(id, { ...existing, ...wire, id });
  }

  /** List registered agents with optional pagination. */
  async listAgents(opts: { limit?: number; offset?: number } = {}): Promise<AgentRegistryEntry[]> {
    const { limit = 100, offset = 0 } = opts;
    return [...this.agents.values()].slice(offset, offset + limit);
  }

  /** Delete an agent by ID. Returns `true` if it existed. */
  async deleteAgent(id: string): Promise<boolean> {
    return this.agents.delete(id);
  }

  /** Clear all registered agents. */
  clear(): void {
    this.agents.clear();
  }
}

// ─── InMemoryMCPServerRegistry ──────────────────────────────────────────

/**
 * In-memory MCP server registry.
 *
 * Pre-populate with {@link register} for testing or lightweight deployments.
 */
export class InMemoryMCPServerRegistry implements MCPServerRegistry {
  private readonly servers = new Map<string, MCPServerEntry>();

  /**
   * Register or update an MCP server entry.
   *
   * SECURITY: the entry is re-validated through {@link MCPServerEntrySchema}
   * before it is stored. The registry is a trusted boundary — the stdio
   * command allowlist and the URL SSRF guard are only enforced if every
   * write actually parses, so we never trust a caller's `MCPServerEntry`
   * (TypeScript types are compile-time only).
   */
  async saveServer(entry: MCPServerConfig): Promise<void> {
    // Remap camelCase authoring input to snake_case (idempotent) before the
    // security-critical schema validation.
    const validated = MCPServerEntrySchema.parse(camelToSnakeDeep(entry));
    this.servers.set(validated.id, validated);
  }

  /** Load a server by ID. Returns `null` if not found. */
  async loadServer(id: string): Promise<MCPServerEntry | null> {
    const entry = this.servers.get(id);
    if (!entry) return null;
    // Re-validate on read as defense against direct map tampering.
    return MCPServerEntrySchema.parse(entry);
  }

  /** List all registered servers. */
  async listServers(): Promise<MCPServerEntry[]> {
    return [...this.servers.values()];
  }

  /** Remove a server by ID. Returns `true` if it existed. */
  async deleteServer(id: string): Promise<boolean> {
    return this.servers.delete(id);
  }

  /** Convenience alias for saveServer (test helper). Validates like saveServer. */
  register(entry: MCPServerConfig): void {
    const validated = MCPServerEntrySchema.parse(camelToSnakeDeep(entry));
    this.servers.set(validated.id, validated);
  }

  /** Clear all registered servers. */
  clear(): void {
    this.servers.clear();
  }
}

// ─── InMemoryUsageRecorder ──────────────────────────────────────────────

/**
 * In-memory usage recorder.
 *
 * Stores records in a public `records` array for inspection in tests.
 * Each record is shallow-cloned on write to prevent mutation.
 */
export class InMemoryUsageRecorder implements UsageRecorder {
  readonly records: UsageRecord[] = [];

  /** Save a usage record (shallow-cloned to prevent mutation). */
  async saveUsageRecord(record: UsageRecord): Promise<void> {
    this.records.push({ ...record });
  }

  /** Clear all stored records. */
  clear(): void {
    this.records.length = 0;
  }
}

// ─── InMemoryRetentionService ───────────────────────────────────────────

/**
 * No-op retention service for in-memory deployments.
 *
 * All operations return zero — no data is ever archived or deleted
 * since in-memory data is transient by nature.
 */
export class InMemoryRetentionService implements RetentionService {
  async archiveCompletedWorkflows(): Promise<number> {
    return 0;
  }

  async deleteWarmData(): Promise<number> {
    return 0;
  }

  async getStorageStats(): Promise<{ hot_runs: number; warm_runs: number; cold_runs: number }> {
    return { hot_runs: 0, warm_runs: 0, cold_runs: 0 };
  }
}
