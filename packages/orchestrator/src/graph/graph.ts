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
 * @module graph/graph
 */

import { z } from 'zod';
import { ToolSourceInputSchema } from '../tools/schema.js';
import { type Camelize, camelToSnakeDeep } from '../utils/case-mapping.js';

// The schemas here define the wire format: snake_case keys persisted to the
// DB and exchanged with the architect. `Camelize<>` derives the camelCase
// authoring types from them, and `createGraph` remaps before validation.

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
  'verifier',
  'reflection',
  'a2a',
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

// ─── Edges & Conditions ─────────────────────────────────────────────

/**
 * Conditional edge routing logic.
 *
 * - `always`      — unconditional (default)
 * - `conditional` — evaluated via a filtrex expression against workflow memory
 *
 * Map-reduce fan-out is config-driven (`map_reduce_config.worker_node_id`),
 * not edge-driven — a map node's worker needs no inbound edge at all.
 */
export const EdgeConditionSchema = z.object({
  /** Routing strategy. */
  type: z.enum(['always', 'conditional']),
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
  /**
   * Maximum retry attempts before the node fails. Bounded to [0, 10]: each
   * attempt is an LLM call, so an unbounded value is a budget-exhaustion
   * lever for an untrusted graph.
   */
  max_retries: z.number().int().min(0).max(10).default(3),
  /** Backoff strategy between retries. */
  backoff_strategy: z.enum(['linear', 'exponential', 'fixed']).default('exponential'),
  /** Initial delay between retries in milliseconds. Bounded so a pathological value can't stall the scheduler. */
  initial_backoff_ms: z.number().int().min(0).max(600_000).default(1000),
  /** Maximum delay between retries in milliseconds. */
  max_backoff_ms: z.number().int().min(0).max(3_600_000).default(60000),

  /** Circuit breaker (trip after repeated failures, auto-recover). */
  circuit_breaker: z.object({
    /** Whether the circuit breaker is enabled. */
    enabled: z.boolean().default(false),
    /** Open the circuit after this many consecutive failures. */
    failure_threshold: z.number().int().min(1).max(1000).default(5),
    /** Close the circuit after this many consecutive successes. */
    success_threshold: z.number().int().min(1).max(1000).default(2),
    /** Half-open probe timeout in milliseconds. */
    timeout_ms: z.number().int().min(0).max(3_600_000).default(60000),
  }).optional(),

  /** Per-node execution timeout in milliseconds. */
  timeout_ms: z.number().int().positive().max(86_400_000).optional(),
});

export type FailurePolicy = z.infer<typeof FailurePolicySchema>;

// ─── Node Budget ────────────────────────────────────────────────────

/**
 * Per-node resource caps, enforced after each successful node execution.
 * Exceeding one throws `NodeBudgetExceededError` without retry, since a
 * retry compounds the spend.
 *
 * The workflow-level `budget_usd` / `max_token_budget` guard the run as a
 * whole; this guards one node from consuming all of it.
 */
export const NodeBudgetSchema = z.object({
  /** Cap on tokens used by this node's execution (single attempt). */
  max_tokens: z.number().int().positive().optional(),
  /** Cap on USD spent by this node's execution (single attempt). */
  max_cost_usd: z.number().positive().optional(),
});

export type NodeBudget = z.infer<typeof NodeBudgetSchema>;

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
  managed_nodes: z.array(z.string()).max(200),
  /** Max routing iterations before forced completion (loop guard). Capped to bound runaway LLM spend. */
  max_iterations: z.number().int().min(1).max(1000).default(10),
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
  /** Timeout before auto-rejection (default: 24 hours, max: 30 days). Must be positive — a non-positive value would put the deadline in the past and auto-reject immediately. */
  timeout_ms: z.number().int().positive().max(2_592_000_000).default(86_400_000),
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
  max_iterations: z.number().int().min(1).max(1000).default(5),
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
 * Hard ceiling on items a single map node may fan out over.
 * `max_concurrency` bounds how many run at once, but without a count cap an
 * `items_path` resolving to a huge array still issues one LLM call per item.
 */
export const MAX_MAP_ITEMS = 1000;

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
  static_items: z.array(z.unknown()).max(MAX_MAP_ITEMS).optional(),
  /** Node ID of the synthesizer to fan results into. */
  synthesizer_node_id: z.string().optional(),
  /** How to handle worker errors. */
  error_strategy: z.enum(['fail_fast', 'best_effort']).default('best_effort'),
  /** Maximum concurrent workers. Capped to bound parallel LLM fan-out. */
  max_concurrency: z.number().int().min(1).max(50).default(5),
  /**
   * Hard cap on total items fanned out, from `static_items` or a resolved
   * `items_path`. Defaults to and cannot exceed {@link MAX_MAP_ITEMS};
   * exceeding it fails the node.
   */
  max_items: z.number().int().min(1).max(MAX_MAP_ITEMS).default(MAX_MAP_ITEMS),
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
  /** Agent IDs that will vote. Capped to bound parallel LLM fan-out. */
  voter_agent_ids: z.array(z.string()).min(1).max(50),
  /** Aggregation strategy. */
  strategy: z.enum(['majority_vote', 'weighted_vote', 'llm_judge']).default('majority_vote'),
  /** Memory key where each voter writes their vote. */
  vote_key: z.string().default('vote'),
  /** Minimum number of votes required for quorum. */
  quorum: z.number().int().min(1).optional(),
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
  peer_nodes: z.array(z.string()).max(1000),
  /** Maximum handoffs before forcing completion. Each handoff is an LLM turn, so it's capped. */
  max_handoffs: z.number().int().min(1).max(1000).default(10),
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
  /** Number of candidates per generation. Capped to bound per-generation LLM fan-out. */
  population_size: z.number().int().min(2).max(100).default(5),
  /** Agent ID that generates candidate solutions. */
  candidate_agent_id: z.string(),
  /**
   * Agent ID for the LLM-as-judge fitness evaluator. Optional when
   * `GraphRunnerOptions.fitnessFunction` is supplied — that callback
   * is used instead. One of the two must be configured; otherwise the
   * executor throws `NodeConfigError` at runtime.
   */
  evaluator_agent_id: z.string().optional(),
  /** Selection strategy for choosing parents. */
  selection_strategy: z.enum(['rank', 'tournament', 'roulette']).default('rank'),
  /** Top candidates preserved unchanged across generations (elitism). */
  elite_count: z.number().int().min(0).max(100).default(1),
  /** Maximum number of generations. Capped to bound total LLM spend (population × generations × 2). */
  max_generations: z.number().int().min(1).max(100).default(10),
  /**
   * Fitness score for early exit: the loop stops once the best candidate
   * meets or exceeds it. Fitness is conventionally in `[0, 1]`, so a
   * threshold above `1.0` disables early exit and runs all generations.
   */
  fitness_threshold: z.number().min(0).default(0.9),
  /** Stop if no improvement for this many consecutive generations. */
  stagnation_generations: z.number().int().min(1).max(100).default(3),
  /** Starting temperature (diversity). */
  initial_temperature: z.number().min(0).max(2).default(1.0),
  /** Ending temperature (exploitation). */
  final_temperature: z.number().min(0).max(2).default(0.3),
  /** Tournament size for `tournament` strategy. */
  tournament_size: z.number().int().min(2).max(100).default(3),
  /** Max concurrent candidate evaluations. Capped to bound parallel LLM fan-out. */
  max_concurrency: z.number().int().min(1).max(50).default(5),
  /** How to handle candidate generation errors. */
  error_strategy: z.enum(['fail_fast', 'best_effort']).default('best_effort'),
  /** Custom instruction passed to the fitness evaluator. */
  evaluation_criteria: z.string().optional(),
  /** Per-task timeout in milliseconds (guards against hung LLM calls). */
  task_timeout_ms: z.number().min(1).optional(),
});

export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

// ─── Verifier ───────────────────────────────────────────────────────

/** Common fields shared by every verifier variant. */
const VerifierCommonFields = {
  /**
   * Memory key prefix for the verification result. Defaults to
   * `${node.id}_verification`. The verifier writes:
   *   - `${result_key}`        → `VerificationResult` object
   *   - `${result_key}_passed` → boolean (for ergonomic edge conditions)
   *
   * Both keys are implied write grants — the node does not need to list
   * them in `write_keys` (see `security/effective-permissions.ts`).
   */
  result_key: z.string().optional(),
  /**
   * When `true`, the verifier throws on failure to trigger node-level retry
   * via `failure_policy`. When `false` (default), the verifier always
   * succeeds and downstream edges should route on the `_passed` memory key.
   */
  throw_on_fail: z.boolean().default(false),
  /** Human-readable description of what this verifier checks. */
  description: z.string().optional(),
} as const;

/**
 * LLM-as-judge verifier: an evaluator agent scores the target memory key
 * and the verifier passes when the score meets `pass_threshold`.
 */
export const VerifierLLMJudgeConfigSchema = z.object({
  type: z.literal('llm_judge'),
  /** Memory key whose value will be evaluated. */
  target_key: z.string(),
  /** Agent ID for the LLM-as-judge evaluator. */
  evaluator_agent_id: z.string(),
  /** Pass if the evaluator's score (0–1) is ≥ this threshold. */
  pass_threshold: z.number().min(0).max(1).default(0.8),
  /** Custom instruction passed to the evaluator. */
  evaluation_criteria: z.string().optional(),
  ...VerifierCommonFields,
});

export type VerifierLLMJudgeConfig = z.infer<typeof VerifierLLMJudgeConfigSchema>;

/**
 * Expression verifier: a filtrex expression evaluated against workflow
 * memory. Passes when the expression is truthy. Deterministic and free —
 * no LLM call.
 *
 * @example
 *   { type: 'expression', expression: 'length(memory.draft) > 100' }
 */
export const VerifierExpressionConfigSchema = z.object({
  type: z.literal('expression'),
  /** Filtrex expression evaluated against `{ memory, goal }`. Passes when truthy. */
  expression: z.string(),
  ...VerifierCommonFields,
});

export type VerifierExpressionConfig = z.infer<typeof VerifierExpressionConfigSchema>;

/**
 * JSONPath assertion verifier: extracts a value from a memory key via
 * JSONPath, then evaluates a deterministic assertion against it.
 * Deterministic and free — no LLM call.
 *
 * @example
 *   {
 *     type: 'jsonpath',
 *     target_key: 'extracted_invoice',
 *     path: '$.line_items[*].amount',
 *     assertion: { op: 'gt', value: 0 },
 *   }
 */
export const VerifierJsonPathAssertionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists') }),
  z.object({ op: z.literal('equals'), value: z.unknown() }),
  // Pattern length is bounded to limit ReDoS surface; the matched value is
  // also length-capped at runtime (see safeRegexTest in verifier.ts).
  z.object({ op: z.literal('matches'), pattern: z.string().max(1000) }),
  z.object({ op: z.literal('gt'), value: z.number() }),
  z.object({ op: z.literal('gte'), value: z.number() }),
  z.object({ op: z.literal('lt'), value: z.number() }),
  z.object({ op: z.literal('lte'), value: z.number() }),
]);

export type VerifierJsonPathAssertion = z.infer<typeof VerifierJsonPathAssertionSchema>;

export const VerifierJsonPathConfigSchema = z.object({
  type: z.literal('jsonpath'),
  /** Memory key whose value will be queried. */
  target_key: z.string(),
  /** JSONPath expression evaluated against `memory[target_key]`. */
  path: z.string(),
  /** Assertion applied to the first extracted value. */
  assertion: VerifierJsonPathAssertionSchema,
  ...VerifierCommonFields,
});

export type VerifierJsonPathConfig = z.infer<typeof VerifierJsonPathConfigSchema>;

/**
 * Verifier node configuration (discriminated union over verification flavour).
 *
 * Every verifier writes a structured outcome to memory. Downstream edges
 * route on the `_passed` boolean, or the verifier throws on failure to
 * trigger `failure_policy` retry when `throw_on_fail` is set.
 */
export const VerifierConfigSchema = z.discriminatedUnion('type', [
  VerifierLLMJudgeConfigSchema,
  VerifierExpressionConfigSchema,
  VerifierJsonPathConfigSchema,
]);

export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;

/**
 * Structured verification outcome written to memory at `result_key`.
 *
 * Variant-specific fields (`score`, `extracted_value`) are present only
 * for the variants that produce them.
 */
export const VerificationResultSchema = z.object({
  /** Verifier variant that produced this result. */
  type: z.enum(['llm_judge', 'expression', 'jsonpath']),
  /** Whether the verification passed. */
  passed: z.boolean(),
  /** Human-readable explanation of the outcome. */
  reasoning: z.string(),
  /** LLM judge score (0–1). Present only for `llm_judge`. */
  score: z.number().optional(),
  /** Threshold the score was compared against. Present only for `llm_judge`. */
  threshold: z.number().optional(),
  /** Value pulled out by the JSONPath query. Present only for `jsonpath`. */
  extracted_value: z.unknown().optional(),
  /** ISO timestamp at which the verification ran. */
  evaluated_at: z.string(),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ─── Reflection ─────────────────────────────────────────────────────

/**
 * Rule-based reflection extractor: derives `SemanticFacts` from memory
 * values using the deterministic `RuleBasedExtractor` from
 * `@cycgraph/memory`. No LLM call — free and predictable.
 */
export const ReflectionRuleBasedExtractorSchema = z.object({
  type: z.literal('rule_based'),
  /** Minimum length (in characters) for an extracted sentence to qualify as a fact. */
  min_sentence_length: z.number().int().min(1).default(15),
});

export type ReflectionRuleBasedExtractor = z.infer<typeof ReflectionRuleBasedExtractorSchema>;

/**
 * LLM reflection extractor: an evaluator-style agent distills lessons from
 * the source memory values.
 */
export const ReflectionLLMExtractorSchema = z.object({
  type: z.literal('llm'),
  /** Agent ID for the LLM extractor (typically an evaluator agent). */
  agent_id: z.string(),
  /** Custom instruction passed to the extractor (overrides the default lesson-distillation prompt). */
  instruction: z.string().optional(),
  /**
   * Soft cap on facts the LLM may return; the extractor trims to this
   * before persistence.
   */
  max_facts: z.number().int().min(1).max(50).default(10),
});

export type ReflectionLLMExtractor = z.infer<typeof ReflectionLLMExtractorSchema>;

/**
 * Reflection node configuration.
 *
 * Runs after productive work, distills the outcome into `SemanticFacts`,
 * and writes them via the injected `MemoryWriter`. Future runs retrieve
 * them by tag through `memoryRetriever`.
 */
export const ReflectionConfigSchema = z.object({
  /**
   * Memory keys whose values feed into the extractor. The reflection
   * node reads `state.memory[k]` for each `k` in `source_keys` (must be
   * declared in the node's `read_keys`) and concatenates the values into
   * the extractor input.
   */
  source_keys: z.array(z.string()).min(1),

  /** Extraction strategy: deterministic rule-based or LLM-driven. */
  extractor: z.discriminatedUnion('type', [
    ReflectionRuleBasedExtractorSchema,
    ReflectionLLMExtractorSchema,
  ]),

  /**
   * Tags applied to every fact written by this node. Used by
   * `memoryRetriever` queries to scope retrieval to lessons from a
   * specific graph or domain (e.g. `['lesson', 'graph:research-v1']`).
   */
  tags: z.array(z.string()).default([]),

  /**
   * Memory keys whose values name entities the produced facts relate to.
   * The reflection executor links facts to these entities via the
   * knowledge graph so the lessons are reachable by entity-driven
   * retrieval (`MemoryQuery.entity_ids`).
   */
  entity_keys: z.array(z.string()).optional(),

  /**
   * Memory key where a summary of the reflection (count of facts
   * written, tags applied) is written for downstream nodes and tests.
   * Defaults to `{node.id}_reflection`.
   */
  result_key: z.string().optional(),
});

export type ReflectionConfig = z.infer<typeof ReflectionConfigSchema>;

/** Summary of a reflection node's output, written to memory at `result_key`. */
export const ReflectionResultSchema = z.object({
  /** Extractor variant that produced the facts. */
  extractor_type: z.enum(['rule_based', 'llm']),
  /** IDs of the facts written to the memory store. */
  fact_ids: z.array(z.string()),
  /** Tags applied to every written fact. */
  tags: z.array(z.string()),
  /** ISO timestamp at which reflection ran. */
  reflected_at: z.string(),
});

export type ReflectionResult = z.infer<typeof ReflectionResultSchema>;

// ─── Memory Query (per-node retrieval directive) ────────────────────

/**
 * Per-node memory retrieval directive.
 *
 * When set on a node, the runner calls the injected `memoryRetriever`
 * with this query before building the agent's prompt, and renders the
 * results into a `## Relevant Memory` section ahead of the regular
 * workflow-state memory block.
 *
 * Routing:
 *  - `tags` alone → tag-only retrieval (e.g. lessons from this graph)
 *  - `entity_ids` → subgraph extraction around those entities
 *  - `text` → semantic search (requires an embedding-capable retriever)
 *  - If `text` and `entity_ids` are both omitted, the runtime defaults
 *    `text` to the workflow `goal` so RAG-style use cases need zero config.
 */
export const MemoryQuerySchema = z.object({
  /** Natural-language query (semantic search). Defaults to the workflow goal when omitted. */
  text: z.string().optional(),
  /** Seed entity IDs for knowledge-graph subgraph extraction. */
  entity_ids: z.array(z.string()).optional(),
  /** Restrict matches to facts carrying at least one of these tags. */
  tags: z.array(z.string()).optional(),
  /** Soft cap on facts injected into the prompt. */
  max_facts: z.number().int().min(1).max(100).optional(),
  /**
   * Treat retrieved content as UNTRUSTED (e.g. RAG over user-uploaded or
   * web documents). When true and facts are injected, the agent's outputs are
   * marked tainted (`source: 'retrieval'`) so a poisoned document can't drive a
   * downstream sensitive action ungated. Leave false for trusted internal
   * knowledge / the agent's own reflection memory.
   */
  untrusted: z.boolean().optional(),
});

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

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
  max_iterations: z.number().int().min(1).max(10000).default(50),
});

export type SubgraphConfig = z.infer<typeof SubgraphConfigSchema>;

/**
 * Configuration for an `a2a` node: delegate a unit of work to a remote
 * agent over the Agent2Agent protocol.
 *
 * Shaped like {@link SubgraphConfigSchema}: both map memory across a
 * delegation boundary. A subgraph child inherits the parent's remaining
 * budget and capability ceiling; a remote agent inherits neither.
 */
export const A2AConfigSchema = z.object({
  /**
   * Registry id of the remote server. Never a URL: endpoints and
   * credentials live in the trusted A2A server registry so a graph cannot
   * name an arbitrary host.
   */
  server_id: z.string().min(1),
  /**
   * Which advertised skill this node intends to invoke. Recorded for
   * readers and tooling; not sent on the wire.
   */
  skill_id: z.string().optional(),
  /** Parent memory key → remote message part. */
  input_mapping: z.record(z.string(), z.string()).default({}),
  /** Remote artifact name → parent memory key. */
  output_mapping: z.record(z.string(), z.string()).default({}),
  /**
   * Per-node override of how long to wait for the task to reach a terminal
   * state. Falls back to the registry entry's `task_timeout_ms`.
   */
  max_wait_ms: z.number().int().positive().max(86_400_000).optional(),
});

export type A2AConfig = z.infer<typeof A2AConfigSchema>;

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
  tools: z.array(ToolSourceInputSchema).optional(),
  /** Tool ID (for `tool` nodes). */
  tool_id: z.string().optional(),
  /** Subgraph ID (for `subgraph` nodes). */
  subgraph_id: z.string().optional(),
  /** Subgraph config (for `subgraph` nodes). */
  subgraph_config: SubgraphConfigSchema.optional(),
  /** Remote-agent config (for `a2a` nodes). */
  a2a_config: A2AConfigSchema.optional(),
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
  /** Verifier config (for `verifier` nodes). */
  verifier_config: VerifierConfigSchema.optional(),
  /** Reflection config (for `reflection` nodes). */
  reflection_config: ReflectionConfigSchema.optional(),
  /**
   * Memory retrieval directive. When set, the runner calls the injected
   * `memoryRetriever` before building the agent prompt and renders the
   * results into a `## Relevant Memory` section. See {@link MemoryQuerySchema}.
   */
  memory_query: MemoryQuerySchema.optional(),

  // ── Security ──
  /**
   * Memory keys this node may read. Defaults to `[]` (least privilege): a
   * node sees only `goal` / `constraints` plus the keys it explicitly lists.
   * Use `['*']` to grant full memory access (a validation warning flags it,
   * since it defeats state slicing). Supports dot-notation for nested keys.
   */
  read_keys: z.array(z.string()).max(1000).default([]),
  /** Memory keys this node may write (empty = deny-all). */
  write_keys: z.array(z.string()).max(1000).default([]),
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
  /**
   * Per-node resource caps (tokens / cost). Enforced after each successful
   * node execution — exceeding a cap persists a failed state and throws
   * `NodeBudgetExceededError` with no retry (`failure_policy` is bypassed).
   */
  budget: NodeBudgetSchema.optional(),
  /** Whether this node pushes a compensating action for saga rollback. */
  requires_compensation: z.boolean().default(false),

  // ── Metadata ──
  /** Arbitrary metadata for tooling and debugging. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ─── Graph ──────────────────────────────────────────────────────────

// ── Graph interface (composition contract) ──────────────────────────
// The memory keys a graph expects seeded and the keys it produces: its
// public signature at a delegation boundary. Mappings are checked against
// it at authoring time, values against the schemas at run time. `schema`
// holds raw JSON Schema and is opaque to case mapping.

/** Caps interface records so an untrusted graph can't declare unbounded keys. */
const MAX_INTERFACE_KEYS = 1000;
const withinInterfaceCap = (value: Record<string, unknown>) =>
  Object.keys(value).length <= MAX_INTERFACE_KEYS;

/** Declaration of one graph input key. */
export const GraphInputDeclSchema = z.object({
  /** JSON Schema for the value seeded under this key. */
  schema: z.record(z.string(), z.unknown()),
  /** Whether the key must be provided (mapped or seeded). */
  required: z.boolean().default(true),
  /** Human-readable description of the key. */
  description: z.string().optional(),
});

/** Declaration of one graph output key. */
export const GraphOutputDeclSchema = z.object({
  /** JSON Schema for the value the graph produces under this key. */
  schema: z.record(z.string(), z.unknown()),
  /** Human-readable description of the key. */
  description: z.string().optional(),
});

export type GraphInputDecl = z.infer<typeof GraphInputDeclSchema>;
export type GraphOutputDecl = z.infer<typeof GraphOutputDeclSchema>;

/**
 * Complete graph definition.
 *
 * Validated at load time by the {@link GraphRunner}. The `start_node` must
 * reference a node in `nodes`, and all `end_nodes` must be reachable from
 * `start_node` via `edges`.
 */
export const GraphSchema = z.object({
  /** Unique graph identifier (auto-generated if omitted). */
  id: z.string().default(() => crypto.randomUUID()),
  /** Human-readable graph name. */
  name: z.string(),
  /** Description of what this graph does. */
  description: z.string(),

  // ── Interface (optional — absent stays absent on the wire) ──
  /** Memory keys this graph expects seeded, with value schemas. */
  inputs: z.record(z.string(), GraphInputDeclSchema).refine(withinInterfaceCap, {
    message: `inputs may declare at most ${MAX_INTERFACE_KEYS} keys`,
  }).optional(),
  /** Memory keys this graph produces, with value schemas. */
  outputs: z.record(z.string(), GraphOutputDeclSchema).refine(withinInterfaceCap, {
    message: `outputs may declare at most ${MAX_INTERFACE_KEYS} keys`,
  }).optional(),

  // ── Structure ──
  // Capped so an untrusted graph can't force O(N+E) validation over an
  // unbounded structure before any publish gate runs.
  /** All nodes in the graph. */
  nodes: z.array(GraphNodeSchema).max(10_000),
  /** Directed edges between nodes. */
  edges: z.array(GraphEdgeSchema).max(10_000),

  // ── Entry / Exit ──
  /** ID of the first node to execute. */
  start_node: z.string(),
  /** Terminal node IDs. */
  end_nodes: z.array(z.string()).max(10_000),

  /**
   * When `true`, reject routing decisions that reference tainted memory keys.
   * Default is warning-only (false).
   */
  strict_taint: z.boolean().default(false),
});

/** Fully-populated graph definition (output of {@link GraphSchema.parse}). */
export type Graph = z.infer<typeof GraphSchema>;

/**
 * Wire-format input shape for constructing a graph (snake_case).
 *
 * Fields with Zod defaults (`id`) are optional. This is the on-the-wire
 * shape; for idiomatic TypeScript authoring prefer {@link GraphConfig}.
 */
export type GraphInput = z.input<typeof GraphSchema>;

/**
 * camelCase authoring type for a single node, derived from
 * {@link GraphNodeSchema}. This is the public Node interface; snake_case
 * remains the wire format.
 */
export type NodeConfig = Camelize<z.input<typeof GraphNodeSchema>>;

/** camelCase authoring type for a full graph. Accepted by {@link createGraph}. */
export type GraphConfig = Camelize<GraphInput>;

/** Deep-remaps camelCase authoring input to wire format, then validates. */
const GraphAuthoringSchema = z
  .any()
  .transform((value) => camelToSnakeDeep(value))
  .pipe(GraphSchema);

/**
 * Create a Graph from camelCase authoring input ({@link GraphConfig}),
 * auto-generating `id` when omitted. Every field is camelCase, including
 * nested config blocks. For snake_case wire input use `GraphSchema.parse`;
 * the remap is idempotent, so wire-format objects are tolerated here too.
 */
export function createGraph(input: GraphConfig): Graph {
  return GraphAuthoringSchema.parse(input);
}
