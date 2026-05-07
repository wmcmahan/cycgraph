/**
 * Graph Definition Types
 *
 * Zod schemas and TypeScript types for the workflow graph structure:
 * nodes, edges, conditions, and all node-specific configuration schemas
 * (supervisor, approval, annealing, map-reduce, voting, swarm, evolution).
 *
 * These schemas are validated at graph load time by the {@link GraphRunner}
 * and at design time by the architect tools.
 *
 * @module types/graph
 */

import { z } from 'zod';
import { ToolSourceSchema } from './tools.js';

// ─── Node Types ─────────────────────────────────────────────────────

/** All supported graph node types. */
export const NodeTypeSchema = z.enum([
  'agent',
  'tool',
  'subgraph',
  'synthesizer',
  'router',
  'supervisor',
  'map',
  'voting',
  'approval',
  'evolution',
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

// ─── Edges & Conditions ─────────────────────────────────────────────

/**
 * Conditional edge routing logic.
 *
 * - `always`      — unconditional (default)
 * - `conditional` — evaluated via a filtrex expression against workflow memory
 * - `map`         — used by map-reduce fan-out nodes
 */
export const EdgeConditionSchema = z.object({
  /** Routing strategy. */
  type: z.enum(['always', 'conditional', 'map']),
  /** Filtrex expression (e.g. `"memory.decision == 'A'"`). Required for `conditional`. */
  condition: z.string().optional(),
  /** Expected value for simple equality checks. */
  value: z.unknown().optional(),
});

export type EdgeCondition = z.infer<typeof EdgeConditionSchema>;

/**
 * Directed edge connecting two graph nodes.
 */
export const GraphEdgeSchema = z.object({
  /** Unique edge identifier (auto-generated if omitted). */
  id: z.string().default(() => crypto.randomUUID()),
  /** Source node ID. */
  source: z.string(),
  /** Target node ID. */
  target: z.string(),
  /** Routing condition (defaults to `always`). */
  condition: EdgeConditionSchema.default({ type: 'always' }),
  /** Arbitrary metadata for tooling and debugging. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ─── Failure Policy ─────────────────────────────────────────────────

/**
 * Node failure policy (resilience configuration).
 *
 * Controls retry behaviour, backoff strategy, and optional circuit
 * breaker for nodes that call unreliable external services.
 */
export const FailurePolicySchema = z.object({
  /** Maximum retry attempts before the node fails. */
  max_retries: z.number().default(3),
  /** Backoff strategy between retries. */
  backoff_strategy: z.enum(['linear', 'exponential', 'fixed']).default('exponential'),
  /** Initial delay between retries in milliseconds. */
  initial_backoff_ms: z.number().default(1000),
  /** Maximum delay between retries in milliseconds. */
  max_backoff_ms: z.number().default(60000),

  /** Circuit breaker (trip after repeated failures, auto-recover). */
  circuit_breaker: z.object({
    /** Whether the circuit breaker is enabled. */
    enabled: z.boolean().default(false),
    /** Open the circuit after this many consecutive failures. */
    failure_threshold: z.number().default(5),
    /** Close the circuit after this many consecutive successes. */
    success_threshold: z.number().default(2),
    /** Half-open probe timeout in milliseconds. */
    timeout_ms: z.number().default(60000),
  }).optional(),

  /** Per-node execution timeout in milliseconds. */
  timeout_ms: z.number().optional(),
});

export type FailurePolicy = z.infer<typeof FailurePolicySchema>;

// ─── Supervisor ─────────────────────────────────────────────────────

/**
 * Supervisor node configuration.
 *
 * Controls how the supervisor LLM routes work between managed sub-nodes.
 */
export const SupervisorConfigSchema = z.object({
  /** Agent ID for the LLM that makes routing decisions. Optional — falls back to `node.agent_id`. */
  agent_id: z.string().optional(),
  /** Node IDs this supervisor can delegate work to. */
  managed_nodes: z.array(z.string()),
  /** Max routing iterations before forced completion (loop guard). */
  max_iterations: z.number().default(10),
  /** JSONPath expression that, when truthy, signals completion. */
  completion_condition: z.string().optional(),
});

export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

// ─── Approval Gate (HITL) ───────────────────────────────────────────

/**
 * Approval gate configuration (Human-in-the-Loop).
 *
 * Pauses workflow execution until a human reviewer approves or rejects.
 */
export const ApprovalGateConfigSchema = z.object({
  /** Type of approval required. */
  approval_type: z.enum(['human_review']).default('human_review'),
  /** Message shown to the reviewer. */
  prompt_message: z.string().default('Please review and approve this workflow step.'),
  /** Memory keys the reviewer should see (`['*']` = all). */
  review_keys: z.array(z.string()).default(['*']),
  /** Timeout before auto-rejection (default: 24 hours). */
  timeout_ms: z.number().default(86_400_000),
  /** Node to route to on rejection (if unset, workflow fails). */
  rejection_node_id: z.string().optional(),
});

export type ApprovalGateConfig = z.infer<typeof ApprovalGateConfigSchema>;

// ─── Self-Annealing ─────────────────────────────────────────────────

/**
 * Self-annealing loop configuration.
 *
 * Iteratively improves output quality by decreasing LLM temperature
 * and re-evaluating until a quality threshold is met.
 */
export const AnnealingConfigSchema = z.object({
  /** Agent ID for the evaluator (if unset, uses `score_path` extraction). */
  evaluator_agent_id: z.string().optional(),
  /** JSONPath to extract a numeric score from agent output. */
  score_path: z.string().default('$.score'),
  /** Quality threshold (0–1) to stop iteration. */
  threshold: z.number().min(0).max(1).default(0.8),
  /** Maximum annealing iterations. */
  max_iterations: z.number().min(1).default(5),
  /** Starting temperature for LLM generation. */
  initial_temperature: z.number().min(0).max(2).default(1.0),
  /** Ending temperature (converges toward this). */
  final_temperature: z.number().min(0).max(2).default(0.2),
  /** Stop if score improvement is less than this delta. */
  diminishing_returns_delta: z.number().min(0).default(0.02),
});

export type AnnealingConfig = z.infer<typeof AnnealingConfigSchema>;

// ─── Map-Reduce ─────────────────────────────────────────────────────

/**
 * Map-Reduce configuration.
 *
 * Fan-out to parallel workers, then fan-in via an optional synthesizer.
 */
export const MapReduceConfigSchema = z.object({
  /** Node ID of the worker to fan out to. */
  worker_node_id: z.string(),
  /** JSONPath to extract the items array from memory. */
  items_path: z.string().optional(),
  /** Static items array (alternative to `items_path`). */
  static_items: z.array(z.unknown()).optional(),
  /** Node ID of the synthesizer to fan results into. */
  synthesizer_node_id: z.string().optional(),
  /** How to handle worker errors. */
  error_strategy: z.enum(['fail_fast', 'best_effort']).default('best_effort'),
  /** Maximum concurrent workers. */
  max_concurrency: z.number().min(1).default(5),
  /** Per-task timeout in milliseconds (guards against hung LLM calls). */
  task_timeout_ms: z.number().min(1).optional(),
});

export type MapReduceConfig = z.infer<typeof MapReduceConfigSchema>;

// ─── Voting / Consensus ─────────────────────────────────────────────

/**
 * Voting/Consensus configuration.
 *
 * Multiple agents vote independently, and a strategy aggregates results.
 */
export const VotingConfigSchema = z.object({
  /** Agent IDs that will vote. */
  voter_agent_ids: z.array(z.string()).min(1),
  /** Aggregation strategy. */
  strategy: z.enum(['majority_vote', 'weighted_vote', 'llm_judge']).default('majority_vote'),
  /** Memory key where each voter writes their vote. */
  vote_key: z.string().default('vote'),
  /** Minimum number of votes required for quorum. */
  quorum: z.number().min(1).optional(),
  /** Agent ID for the `llm_judge` strategy. */
  judge_agent_id: z.string().optional(),
  /** Per-agent weights for the `weighted_vote` strategy. */
  weights: z.record(z.string(), z.number()).optional(),
  /** Per-task timeout in milliseconds (guards against hung LLM calls). */
  task_timeout_ms: z.number().min(1).optional(),
});

export type VotingConfig = z.infer<typeof VotingConfigSchema>;

// ─── Swarm ──────────────────────────────────────────────────────────

/**
 * Swarm configuration.
 *
 * Peer agents hand off work to each other until the task is complete.
 */
export const SwarmConfigSchema = z.object({
  /** Node IDs of peer agents in the swarm. */
  peer_nodes: z.array(z.string()),
  /** Maximum handoffs before forcing completion. */
  max_handoffs: z.number().min(1).default(10),
  /** How peers are selected for handoff. */
  handoff_mode: z.enum(['agent_choice']).default('agent_choice'),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

// ─── Evolution (DGM) ────────────────────────────────────────────────

/**
 * Evolution (Darwinian Graph Mutation) configuration.
 *
 * Population-based selection: generate N candidates, score with a
 * fitness evaluator, select the best, and breed the next generation.
 */
export const EvolutionConfigSchema = z.object({
  /** Number of candidates per generation. */
  population_size: z.number().min(2).default(5),
  /** Agent ID that generates candidate solutions. */
  candidate_agent_id: z.string(),
  /** Agent ID for the fitness evaluator. */
  evaluator_agent_id: z.string(),
  /** Selection strategy for choosing parents. */
  selection_strategy: z.enum(['rank', 'tournament', 'roulette']).default('rank'),
  /** Top candidates preserved unchanged across generations (elitism). */
  elite_count: z.number().min(0).default(1),
  /** Maximum number of generations. */
  max_generations: z.number().min(1).default(10),
  /** Fitness score (0–1) for early exit. */
  fitness_threshold: z.number().min(0).max(1).default(0.9),
  /** Stop if no improvement for this many consecutive generations. */
  stagnation_generations: z.number().min(1).default(3),
  /** Starting temperature (diversity). */
  initial_temperature: z.number().min(0).max(2).default(1.0),
  /** Ending temperature (exploitation). */
  final_temperature: z.number().min(0).max(2).default(0.3),
  /** Tournament size for `tournament` strategy. */
  tournament_size: z.number().min(2).default(3),
  /** Max concurrent candidate evaluations. */
  max_concurrency: z.number().min(1).default(5),
  /** How to handle candidate generation errors. */
  error_strategy: z.enum(['fail_fast', 'best_effort']).default('best_effort'),
  /** Custom instruction passed to the fitness evaluator. */
  evaluation_criteria: z.string().optional(),
  /** Per-task timeout in milliseconds (guards against hung LLM calls). */
  task_timeout_ms: z.number().min(1).optional(),
});

export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

// ─── Subgraph ───────────────────────────────────────────────────────

/**
 * Subgraph configuration (nested workflow composition).
 *
 * Allows a node to execute an entire sub-workflow, mapping memory
 * keys between parent and child scopes.
 */
export const SubgraphConfigSchema = z.object({
  /** ID of the graph to embed. */
  subgraph_id: z.string(),
  /** Parent → child memory key mapping. */
  input_mapping: z.record(z.string(), z.string()).default({}),
  /** Child → parent memory key mapping. */
  output_mapping: z.record(z.string(), z.string()).default({}),
  /** Maximum iterations for the sub-workflow. */
  max_iterations: z.number().min(1).default(50),
});

export type SubgraphConfig = z.infer<typeof SubgraphConfigSchema>;

// ─── Graph Node ─────────────────────────────────────────────────────

/**
 * Graph node configuration.
 *
 * The `type` field determines which optional config block is required.
 * Permissions (`read_keys` / `write_keys`) enforce the zero-trust
 * security model at the node level.
 */
export const GraphNodeSchema = z.object({
  /** Unique node identifier. */
  id: z.string(),
  /** Node execution type. */
  type: NodeTypeSchema,

  // ── Type-specific config ──
  /** Agent ID (for `agent` nodes). */
  agent_id: z.string().optional(),
  /** Tool sources for this node. Overrides agent config tools when set. */
  tools: z.array(ToolSourceSchema).optional(),
  /** Tool ID (for `tool` nodes). */
  tool_id: z.string().optional(),
  /** Subgraph ID (for `subgraph` nodes). */
  subgraph_id: z.string().optional(),
  /** Subgraph config (for `subgraph` nodes). */
  subgraph_config: SubgraphConfigSchema.optional(),
  /** Supervisor config (for `supervisor` nodes). */
  supervisor_config: SupervisorConfigSchema.optional(),
  /** Approval gate config (for `approval` nodes). */
  approval_config: ApprovalGateConfigSchema.optional(),
  /** Self-annealing config (for `agent` nodes with iterative refinement). */
  annealing_config: AnnealingConfigSchema.optional(),
  /** Map-reduce config (for `map` nodes). */
  map_reduce_config: MapReduceConfigSchema.optional(),
  /** Voting config (for `voting` nodes). */
  voting_config: VotingConfigSchema.optional(),
  /** Swarm config (for swarm-mode nodes). */
  swarm_config: SwarmConfigSchema.optional(),
  /** Evolution config (for `evolution` nodes). */
  evolution_config: EvolutionConfigSchema.optional(),

  // ── Security ──
  /** Memory keys this node may read (`['*']` = all). */
  read_keys: z.array(z.string()).default(['*']),
  /** Memory keys this node may write (empty = deny-all). */
  write_keys: z.array(z.string()).default([]),
  /**
   * Default memory key for orchestrator-managed text output.
   *
   * When an agent produces text without calling `save_to_memory`, the
   * orchestrator routes the response to this key. Required when the node
   * has multiple `write_keys` and `save_to_memory` is not in the tools
   * array. Must be a member of `write_keys`. Not needed for single-key
   * agents (the orchestrator infers the target automatically).
   */
  default_write_key: z.string().optional(),

  // ── Resilience ──
  /** Retry and backoff configuration. */
  failure_policy: FailurePolicySchema.default({
    max_retries: 3,
    backoff_strategy: 'exponential' as const,
    initial_backoff_ms: 1000,
    max_backoff_ms: 60000,
  }),
  /** Whether this node pushes a compensating action for saga rollback. */
  requires_compensation: z.boolean().default(false),

  // ── Metadata ──
  /** Arbitrary metadata for tooling and debugging. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ─── Graph ──────────────────────────────────────────────────────────

/**
 * Complete graph definition.
 *
 * Validated at load time by the {@link GraphRunner}. The `start_node`
 * must reference a node in `nodes`, and all `end_nodes` must be
 * reachable from `start_node` via `edges`.
 */
export const GraphSchema = z.object({
  /** Unique graph identifier (auto-generated if omitted). */
  id: z.string().default(() => crypto.randomUUID()),
  /** Human-readable graph name. */
  name: z.string(),
  /** Description of what this graph does. */
  description: z.string(),

  // ── Structure ──
  /** All nodes in the graph. */
  nodes: z.array(GraphNodeSchema),
  /** Directed edges between nodes. */
  edges: z.array(GraphEdgeSchema),

  // ── Entry / Exit ──
  /** ID of the first node to execute. */
  start_node: z.string(),
  /** Terminal node IDs. */
  end_nodes: z.array(z.string()),

  /**
   * When `true`, reject routing decisions that reference tainted memory keys.
   * Default is warning-only (false).
   */
  strict_taint: z.boolean().default(false),
});

/** Fully-populated graph definition (output of {@link GraphSchema.parse}). */
export type Graph = z.infer<typeof GraphSchema>;

/**
 * Input shape for constructing a graph.
 *
 * Fields with Zod defaults (`id`) are optional.
 * Use with {@link createGraph} for the simplest construction path.
 */
export type GraphInput = z.input<typeof GraphSchema>;

/**
 * Create a Graph with auto-generated defaults.
 *
 * Parses the input through {@link GraphSchema}, filling in `id`
 * via `crypto.randomUUID()` when omitted.
 */
export function createGraph(input: GraphInput): Graph {
  return GraphSchema.parse(input);
}
