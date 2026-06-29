/**
 * Node Executor Context
 *
 * Shared types for all node executor functions. Defines the dependency
 * injection interface ({@link ExecutorDependencies}) and the context
 * bag ({@link NodeExecutorContext}) passed to every executor.
 *
 * This module decouples node executors from the `GraphRunner` import
 * tree, enabling clean unit testing via mock dependencies.
 *
 * @module runner/node-executors/context
 */

import type { GraphNode } from '../../types/graph.js';
import type { Graph } from '../../types/graph.js';
import type { WorkflowState, Action, StateView, TaintMetadata } from '../../types/state.js';
import type { ToolSource } from '../../types/tools.js';
import type { SecurityPolicy } from '../security-policy.js';
import type { ToolResolver } from '../../mcp/connection-manager.js';
import type { ModelResolver, ModelResolutionResult, ModelTier } from '../../agent/model-resolver.js';
import type { ContextCompressor, ContextCompressionMetrics } from '../../agent/context-compressor.js';
import type { MemoryRetriever } from '../../agent/memory-retriever.js';
import type { MemoryWriter } from '../../agent/memory-writer.js';
import type { FactSanitizer } from '../../agent/fact-sanitizer.js';
import type { FitnessFunction } from '../../agent/fitness-function.js';
import type { RateLimiter } from '../../agent/rate-limiter.js';

/**
 * Raw tool definition — description + parameters without an execute function.
 */
export interface RawToolDefinition {
  /** Human-readable tool description. */
  description: string;
  /** JSON Schema or Zod schema for the tool's input parameters. */
  parameters: unknown;
}

/**
 * Resolved tool — a tool definition that includes an execute function.
 * Returned by `resolveTools` from the MCPConnectionManager.
 */
export interface ResolvedTool extends RawToolDefinition {
  /** Execute callback provided by the MCP client or built-in implementation. */
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Tainted tool result shape from MCP tool execution.
 */
export interface TaintedToolResultShape {
  /** The actual tool return value. */
  result: unknown;
  /** Taint metadata to merge into the taint registry. */
  taint: Record<string, unknown>;
}

/**
 * Agent config shape (subset needed by executors).
 */
export interface AgentConfigShape {
  /** Structured tool source declarations. */
  tools: ToolSource[];
  /** Memory keys the agent may write. */
  write_keys: string[];
  /** LLM provider (e.g. `'anthropic'`). */
  provider: string;
  /** Static fallback model identifier. */
  model: string;
  /** Capability tier preference for budget-aware model resolution. */
  model_preference?: ModelTier;
  [key: string]: unknown;
}

/**
 * Injected dependencies for node executors.
 *
 * All external runtime functions are provided here so that tests
 * can mock them at the GraphRunner level without node executors
 * needing their own imports.
 */
export interface ExecutorDependencies {
  /** Execute an agent LLM call and return the resulting action. */
  executeAgent: (
    agent_id: string,
    stateView: StateView,
    tools: Record<string, unknown>,
    attempt: number,
    options?: {
      temperature_override?: number;
      node_id?: string;
      abortSignal?: AbortSignal;
      onToken?: (token: string) => void;
      onToolCall?: (event: { toolName: string; toolCallId: string; args: unknown }) => void;
      onToolCallComplete?: (event: { toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string }) => void;
      drainTaintEntries?: (tools?: Record<string, unknown>) => Map<string, TaintMetadata>;
      /** Override the model from agent config (used by budget-aware model resolution). */
      model_override?: string;
      /** Context compressor for memory serialization in prompts. */
      contextCompressor?: ContextCompressor;
      /** Callback fired when context compression runs. */
      onContextCompressed?: (metrics: ContextCompressionMetrics) => void;
      /** Memory retriever for injecting relevant facts into prompts. */
      memoryRetriever?: MemoryRetriever;
      /** Per-node retrieval directive (paired with `memoryRetriever`). */
      memory_query?: {
        text?: string;
        entityIds?: string[];
        tags?: string[];
        maxFacts?: number;
      };
    },
  ) => Promise<Action>;

  /** Execute a supervisor routing decision. */
  executeSupervisor: (
    node: GraphNode,
    stateView: StateView,
    supervisorHistory: Array<{
      supervisor_id: string;
      delegated_to: string;
      reasoning: string;
      iteration: number;
      timestamp: Date;
    }>,
    attempt: number,
    options?: {
      abortSignal?: AbortSignal;
      model_override?: string;
      /** Context compressor for memory serialization in prompts. */
      contextCompressor?: ContextCompressor;
      /** Callback fired when context compression runs. */
      onContextCompressed?: (metrics: ContextCompressionMetrics) => void;
      /** Memory retriever for injecting relevant facts into the routing prompt. */
      memoryRetriever?: MemoryRetriever;
      /** Per-node retrieval directive (paired with `memoryRetriever`). */
      memory_query?: {
        text?: string;
        entityIds?: string[];
        tags?: string[];
        maxFacts?: number;
      };
    },
  ) => Promise<Action>;

  /** Evaluate output quality via an LLM-as-judge. */
  evaluateQualityExecutor: (
    evaluatorAgentId: string,
    goal: string,
    data: unknown,
    instruction?: string,
  ) => Promise<{ score: number; reasoning: string; tokens_used: number }>;

  /**
   * Extract a bounded list of atomic facts from source text via an LLM.
   * Used by the reflection node's `llm` extractor variant.
   */
  extractFactsExecutor: (
    extractorAgentId: string,
    source: unknown,
    max_facts?: number,
    instruction?: string,
  ) => Promise<{ facts: string[]; reasoning?: string; tokens_used: number }>;

  /**
   * Resolve structured tool sources into AI SDK tool objects.
   * Returns a merged record of tool name → resolved tool (with execute).
   * Handles built-in tools, MCP server connections, and taint wrapping.
   */
  resolveTools: (sources: ToolSource[], agentId?: string) => Promise<Record<string, unknown>>;

  /** Load an agent's configuration. */
  loadAgent: (agentId: string) => Promise<AgentConfigShape>;

  /** Get the taint registry from workflow memory. */
  getTaintRegistry: (memory: Record<string, unknown>) => Record<string, unknown>;

  /**
   * Drain accumulated MCP taint entries after agent execution. Pass the
   * toolset from the paired `resolveTools()` call to drain only that
   * execution's entries (race-free under concurrent sub-executions).
   */
  drainTaintEntries?: (tools?: Record<string, unknown>) => Map<string, TaintMetadata>;
}

/**
 * Context bag passed to every node executor function.
 *
 * Provides read access to runner state and injected dependencies,
 * without coupling executors to GraphRunner's import tree.
 */
export interface NodeExecutorContext {
  /** Current workflow state (read-only snapshot for idempotency keys, etc.). */
  state: WorkflowState;
  /** The graph being executed. */
  graph: Graph;
  /** Load a graph by ID (needed by the subgraph executor). */
  loadGraphFn?: (graphId: string) => Promise<Graph | null>;
  /**
   * The tool resolver instance (from GraphRunnerOptions). Exposed so the
   * subgraph executor can propagate it into the child runner — otherwise a
   * subgraph would silently run with built-in tools only.
   */
  toolResolver?: ToolResolver;
  /** Create a filtered state view for a node. */
  createStateView: (node: GraphNode) => StateView;
  /** Injected runtime dependencies. */
  deps: ExecutorDependencies;
  /** Budget-aware model resolver (from GraphRunnerOptions). */
  modelResolver?: ModelResolver;
  /** Context compressor for memory serialization in prompts (from GraphRunnerOptions). */
  contextCompressor?: ContextCompressor;
  /** Memory retriever for injecting relevant facts into prompts (from GraphRunnerOptions). */
  memoryRetriever?: MemoryRetriever;
  /** Taint-aware security policy (from GraphRunnerOptions) — propagated into subgraph child runners. */
  securityPolicy?: SecurityPolicy;
  /** Memory writer for persisting facts produced by reflection nodes (from GraphRunnerOptions). */
  memoryWriter?: MemoryWriter;
  /** Optional pre-write hook applied to reflection facts (from GraphRunnerOptions). */
  factSanitizer?: FactSanitizer;
  /** What to do when factSanitizer throws: 'drop' (fail closed) or 'pass'. */
  factSanitizerFailMode?: 'drop' | 'pass';
  /** Optional deterministic fitness evaluator for evolution nodes (from GraphRunnerOptions). */
  fitnessFunction?: FitnessFunction;
  /** Optional rate-limiting hook awaited before every LLM call (from GraphRunnerOptions). */
  rateLimiter?: RateLimiter;
  /** Callback fired when context compression runs on a prompt's memory section. */
  onContextCompressed?: (event: { tokensIn: number; tokensOut: number; reductionPercent: number; durationMs: number }, nodeId: string) => void;
  /** Remaining workflow budget in USD, or `undefined` if unlimited (static snapshot — prefer getRemainingBudgetUsd). */
  remainingBudgetUsd?: number;
  /** Lazy budget getter — reads current state at call time (avoids TOCTOU). */
  getRemainingBudgetUsd?: () => number | undefined;
  /** Abort signal for workflow cancellation — propagated to LLM calls. */
  abortSignal?: AbortSignal;
  /** Token streaming callback — fires for each text delta with the originating node ID. */
  onToken?: (token: string, nodeId: string) => void;
  /** Tool call start callback — fires when a tool begins executing. */
  onToolCall?: (event: { toolName: string; toolCallId: string; args: unknown }, nodeId: string) => void;
  /** Tool call finish callback — fires when a tool completes. */
  onToolCallComplete?: (event: { toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string }, nodeId: string) => void;
  /** Model resolution callback — fires when a model is dynamically resolved for an agent. */
  onModelResolved?: (event: { agentId: string; originalModel: string; resolution: ModelResolutionResult }, nodeId: string) => void;
}
