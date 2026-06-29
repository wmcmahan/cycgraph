/**
 * Persistence Interfaces
 *
 * Defines the contracts for all storage backends used by the orchestrator.
 * The orchestrator depends only on these interfaces — concrete implementations
 * (Drizzle/Postgres, in-memory, etc.) are injected at startup.
 *
 * Design principle: "Batteries included, but swappable."
 *
 * @module persistence/interfaces
 */

import type { Graph } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import type { MCPServerEntry, MCPServerConfig, ToolSource } from '../types/tools.js';
import type { Camelize } from '../types/case-mapping.js';
import type { ModelTier } from '../agent/model-resolver.js';

/** JSON-serializable value. Structurally compatible with AI SDK's `JSONValue`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ─── JSON-safe types (DB-agnostic) ──────────────────────────────────────

/**
 * JSON-safe shape for graph definitions.
 *
 * Kept deliberately loose (index signature) to avoid coupling to any ORM.
 */
export interface GraphDefinitionJson {
  /** Unique graph identifier. */
  id: string;
  /** Human-readable graph name. */
  name: string;
  /** Serialized node definitions. */
  nodes: unknown[];
  /** Serialized edge definitions. */
  edges: unknown[];
  /** ID of the first node to execute. */
  start_node: string;
  /** Terminal node IDs (empty for supervisor-driven graphs). */
  end_nodes: string[];
  /** Additional properties for forward-compatibility. */
  [key: string]: unknown;
}

/**
 * JSON-safe shape for workflow state snapshots.
 *
 * Stored as a versioned record for crash recovery and state history.
 */
export interface WorkflowStateJson {
  /** Graph that this run belongs to. */
  workflow_id: string;
  /** Unique run identifier. */
  run_id: string;
  /** Current workflow status. */
  status: string;
  /** Node currently being executed (`undefined` before first step). */
  current_node?: string;
  /** Key-value memory shared between nodes. */
  memory: Record<string, unknown>;
  /** Additional properties for forward-compatibility. */
  [key: string]: unknown;
}

/**
 * Row shape returned by workflow run queries.
 */
export interface WorkflowRunRow {
  /** Unique run identifier. */
  id: string;
  /** Logical workflow ID (nullable for ad-hoc runs). */
  workflow_id: string | null;
  /** Graph that this run executes. */
  graph_id: string;
  /** Current run status (e.g. `"running"`, `"completed"`, `"failed"`). */
  status: string;
  /** When the run was created. */
  created_at: Date;
  /** Parent run ID for sub-workflow runs. */
  parent_run_id: string | null;
  /** When the run reached a terminal status (`null` if still running). */
  completed_at: Date | null;
  /** When the run was archived by the retention service (`null` if hot). */
  archived_at: Date | null;
}

/**
 * Row shape returned by workflow event queries.
 */
export interface WorkflowEventRow {
  /** Unique event identifier. */
  id: string;
  /** Run this event belongs to. */
  run_id: string;
  /** Monotonically increasing sequence within the run. */
  sequence_id: number;
  /** Event category (e.g. `"node_started"`, `"node_completed"`). */
  event_type: string;
  /** Node that produced this event (`null` for run-level events). */
  node_id: string | null;
  /** Serialized action payload. */
  action: unknown;
  /** Internal event type for the graph runner (e.g. `"dispatch"`). */
  internal_type: string | null;
  /** Internal payload for the graph runner. */
  internal_payload: unknown;
  /** When the event was recorded. */
  created_at: Date;
}

/**
 * Row shape for graph records.
 */
export interface GraphRow {
  /** Unique graph identifier. */
  id: string;
  /** Human-readable graph name. */
  name: string;
  /** Optional description. */
  description: string | null;
  /** Full graph definition as JSON. */
  definition: GraphDefinitionJson;
  /** Semantic version string. */
  version: string | null;
  /** When the graph was first created. */
  created_at: Date;
  /** When the graph was last modified. */
  updated_at: Date;
}

// ─── PersistenceProvider ────────────────────────────────────────────────

/**
 * Primary persistence interface for workflow state management.
 *
 * Covers graphs, workflow runs, and workflow state snapshots.
 * All methods are async to support both in-memory and database backends.
 */
export interface PersistenceProvider {
  // ── Graph Operations ──

  /** Save or upsert a graph definition. */
  saveGraph(graph: Graph): Promise<void>;

  /** Load a graph by ID. Returns `null` if not found. */
  loadGraph(graph_id: string): Promise<Graph | null>;

  /** List graphs ordered by `updated_at` descending. */
  listGraphs(opts?: { limit?: number; offset?: number }): Promise<GraphRow[]>;

  /** Delete a graph by ID. Returns `true` if it existed. */
  deleteGraph(graph_id: string): Promise<boolean>;

  // ── Workflow Run Operations ──

  /** Save or upsert a workflow run record from the current state. */
  saveWorkflowRun(state: WorkflowState): Promise<void>;

  /** Load a workflow run by ID. Returns `null` if not found. */
  loadWorkflowRun(run_id: string): Promise<WorkflowRunRow | null>;

  /** List workflow runs ordered by `created_at` descending. */
  listWorkflowRuns(opts?: { limit?: number; offset?: number }): Promise<WorkflowRunRow[]>;

  /** Update only the status of a run. Returns rows affected (`0` or `1`). */
  updateRunStatus(runId: string, status: string): Promise<number>;

  // ── Workflow State Operations ──

  /** Save a state snapshot with auto-incremented version. */
  saveWorkflowState(state: WorkflowState): Promise<void>;

  /** Load the latest state snapshot for crash recovery. */
  loadLatestWorkflowState(run_id: string): Promise<WorkflowState | null>;

  /** Load state version history (lightweight summary per version). */
  loadWorkflowStateHistory(
    run_id: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{
    version: number;
    status: string;
    current_node: string | null;
    created_at: Date;
    total_tokens_used: number | null;
  }[]>;

  /** Load full state JSON at a specific version. */
  loadWorkflowStateAtVersion(run_id: string, version: number): Promise<WorkflowStateJson | null>;

  // ── Atomic Snapshot ──

  /**
   * Atomically save both the workflow run record and state snapshot.
   *
   * Implementations MUST wrap both operations in a transaction to
   * prevent inconsistent state if one fails (e.g., crash between
   * `saveWorkflowRun` and `saveWorkflowState`).
   *
   * The GraphRunner always uses this method for state persistence.
   */
  saveWorkflowSnapshot(state: WorkflowState): Promise<void>;

  // ── Event Queries ──

  /** Load raw event rows for a run (for API endpoints). */
  loadEvents(run_id: string): Promise<WorkflowEventRow[]>;
}

// ─── AgentRegistry ──────────────────────────────────────────────────────

/**
 * Entry returned by the agent registry.
 *
 * Represents a single agent's full configuration as stored in the database.
 */
export interface AgentRegistryEntry {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable agent name. */
  name: string;
  /** Optional description of the agent's purpose. */
  description: string | null;
  /** LLM model identifier (e.g. `"claude-sonnet-4-6"`). */
  model: string;
  /** LLM provider (`"openai"` | `"anthropic"` | `"groq"`). */
  provider: string;
  /** System prompt that defines the agent's behaviour. */
  system_prompt: string;
  /** Sampling temperature (0–1). */
  temperature: number;
  /** Maximum tool-call steps. */
  max_steps: number;
  /** Structured tool source declarations. */
  tools: ToolSource[];
  /** Provider-specific options, namespaced by provider name. */
  provider_options?: Record<string, Record<string, JsonValue>> | null;
  /**
   * Capability tier preference for budget-aware model resolution.
   *
   * When set (and a `ModelResolver` is configured on the runner),
   * the engine resolves to a concrete model at runtime based on
   * remaining budget. When absent, `model` is used directly.
   */
  model_preference?: ModelTier;
  /** Zero-trust permissions (deny-all when `null`). */
  permissions: {
    /** Whether the agent runs in a sandboxed environment. */
    sandbox?: boolean;
    /** Memory keys the agent may read. */
    read_keys: string[];
    /** Memory keys the agent may write. */
    write_keys: string[];
    /** Per-run cost budget in USD. */
    budget_usd?: number;
  } | null;
}

/**
 * Input shape for registering a new agent.
 *
 * The `id` is auto-generated by the registry. Fields with documented
 * defaults (`description`, `temperature`, `max_steps`) are optional; the
 * registry fills them in when storing the entry.
 */
export type AgentRegistryInput = Omit<
  AgentRegistryEntry,
  'id' | 'description' | 'temperature' | 'max_steps'
> & {
  /** Optional description of the agent's purpose. Defaults to `null`. */
  description?: string | null;
  /** Sampling temperature (0–1). Defaults to `0.7`. */
  temperature?: number;
  /** Maximum tool-call steps. Defaults to `10`. */
  max_steps?: number;
};

/**
 * camelCase authoring shape for {@link AgentRegistry.register}, derived from
 * the snake_case {@link AgentRegistryInput} wire type. This is the public,
 * documented way to register an agent (`systemPrompt`, `maxSteps`,
 * `permissions.readKeys`, …). Stored entries and `loadAgent` results remain
 * snake_case.
 */
export type AgentRegistryConfig = Camelize<AgentRegistryInput>;

/**
 * Registry for loading agent configurations.
 *
 * Decouples the agent factory from any specific database or config store.
 */
export interface AgentRegistry {
  /** Load an agent by ID. Returns `null` if not found. */
  loadAgent(id: string): Promise<AgentRegistryEntry | null>;

  /** Register an agent config (camelCase) and return its auto-generated ID. */
  register(entry: AgentRegistryConfig): string | Promise<string>;

  /** Update an existing agent's configuration (camelCase fields). */
  updateAgent?(id: string, updates: Partial<AgentRegistryConfig>): Promise<void>;

  /** List registered agents with optional pagination. */
  listAgents?(opts?: { limit?: number; offset?: number }): Promise<AgentRegistryEntry[]>;

  /** Delete an agent by ID. Returns `true` if it existed. */
  deleteAgent?(id: string): Promise<boolean>;
}

// ─── MCPServerRegistry ──────────────────────────────────────────────────

/**
 * Registry for trusted MCP server configurations.
 *
 * This is the security boundary between agent configs (which reference
 * servers by ID) and actual transport configurations (which contain
 * connection details and secrets). Only administrators should be able
 * to create or modify entries.
 */
export interface MCPServerRegistry {
  /** Register or update an MCP server entry (camelCase authoring shape). */
  saveServer(entry: MCPServerConfig): Promise<void>;

  /** Load a server by ID. Returns `null` if not found. */
  loadServer(id: string): Promise<MCPServerEntry | null>;

  /** List all registered servers. */
  listServers(): Promise<MCPServerEntry[]>;

  /** Remove a server by ID. Returns `true` if it existed. */
  deleteServer(id: string): Promise<boolean>;
}

// ─── UsageRecorder ──────────────────────────────────────────────────────

/**
 * Record shape for per-run cost and token usage tracking.
 */
export interface UsageRecord {
  /** Run that incurred the usage. */
  run_id: string;
  /** API key used for the request (if applicable). */
  api_key_id?: string;
  /** Graph that was executed. */
  graph_id: string;
  /** Number of prompt tokens consumed. */
  input_tokens: number;
  /** Number of completion tokens consumed. */
  output_tokens: number;
  /** Estimated cost in USD. */
  cost_usd: number;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
}

/**
 * Records per-run cost and token usage for billing and observability.
 */
export interface UsageRecorder {
  /** Persist a usage record. */
  saveUsageRecord(record: UsageRecord): Promise<void>;
}

// ─── RetentionService ───────────────────────────────────────────────────

/**
 * Manages workflow data lifecycle across Hot → Warm → Cold tiers.
 *
 * Hot: active or recently completed runs.
 * Warm: archived runs kept for debugging/auditing.
 * Cold: deleted or moved to long-term storage.
 */
export interface RetentionService {
  /** Archive completed workflows older than the configured cutoff. */
  archiveCompletedWorkflows(): Promise<number>;

  /** Delete warm data older than the retention period. */
  deleteWarmData(): Promise<number>;

  /** Get per-tier run counts. */
  getStorageStats(): Promise<{
    hot_runs: number;
    warm_runs: number;
    cold_runs: number;
  }>;
}
