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
import { type Camelize, camelToSnakeDeep } from './case-mapping.js';

// ─── camelCase authoring layer ──────────────────────────────────────
//
// The schemas in this file define the *wire format*: snake_case keys that
// are persisted to the DB, emitted/parsed by the architect, and read by the
// engine. That stays snake_case on purpose — see the DB `definition` jsonb
// column and `architect/prompts.ts`.
//
// Consumers author graphs in idiomatic camelCase TypeScript. The `Camelize<>`
// mapped type (see `./case-mapping.ts`) derives the camelCase authoring types
// directly from the snake schemas (so they never drift), and `createGraph`
// runs a deep camel→snake remap before validation.

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

// ─── Node Budget ────────────────────────────────────────────────────

/**
 * Per-node resource caps. Enforced after each successful node execution.
 *
 * When a cap is exceeded, the runner throws a `NodeBudgetExceededError`
 * that flows through the node's `failure_policy` like any other failure
 * — retries kick in if configured, otherwise the workflow fails fast.
 *
 * Separate from the workflow-level `budget_usd` / `max_token_budget` on
 * `WorkflowState`: those guard the run as a whole; this guards a single
 * node from eating the entire budget (e.g. a runaway annealing loop or
 * an oversized LLM reflection extraction).
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
  /** Maximum concurrent workers. Capped to bound parallel LLM fan-out. */
  max_concurrency: z.number().int().min(1).max(50).default(5),
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
  elite_count: z.number().min(0).default(1),
  /** Maximum number of generations. Capped to bound total LLM spend (population × generations × 2). */
  max_generations: z.number().int().min(1).max(100).default(10),
  /**
   * Fitness score for early exit. The evolution loop terminates as soon
   * as the best candidate's fitness meets or exceeds this value.
   *
   * Fitness itself is conventionally in `[0, 1]`. Set the threshold above
   * `1.0` (e.g. `1.5`) to disable early-fitness-exit entirely — useful when
   * you want the loop to run all `max_generations` regardless of how good
   * any single candidate is (for instrumentation, baselining, or proof-of-
   * iteration runs).
   */
  fitness_threshold: z.number().min(0).default(0.9),
  /** Stop if no improvement for this many consecutive generations. */
  stagnation_generations: z.number().int().min(1).max(100).default(3),
  /** Starting temperature (diversity). */
  initial_temperature: z.number().min(0).max(2).default(1.0),
  /** Ending temperature (exploitation). */
  final_temperature: z.number().min(0).max(2).default(0.3),
  /** Tournament size for `tournament` strategy. */
  tournament_size: z.number().min(2).default(3),
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

/**
 * Common fields shared by every verifier variant.
 *
 * `result_key` controls where the verification outcome lands in memory.
 * `throw_on_fail` opts into `failure_policy`-driven retry when verification
 * fails; the default is the explicit-edge-routing pattern where the verifier
 * always succeeds and downstream edges branch on the outcome.
 */
const VerifierCommonFields = {
  /**
   * Memory key prefix for the verification result. Defaults to
   * `${node.id}_verification`. The verifier writes:
   *   - `${result_key}`        → `VerificationResult` object
   *   - `${result_key}_passed` → boolean (for ergonomic edge conditions)
   *
   * Both keys must appear in the node's `write_keys`.
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
 *
 * Reuses the same `evaluateQualityExecutor` primitive that powers Evolution
 * fitness scoring and Annealing quality checks.
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
  z.object({ op: z.literal('matches'), pattern: z.string() }),
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
 * Compound-systems primitive: every verifier returns a structured outcome
 * (`{ passed, score?, reasoning, ... }`) written to memory. Downstream
 * edges route on the `_passed` boolean (option b — explicit edge routing),
 * or the verifier throws on failure to trigger `failure_policy` retry
 * (option a — opt in via `throw_on_fail: true`).
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
 * LLM reflection extractor: an evaluator-style agent distills lessons
 * from the source memory values. Uses the same `evaluator-executor`
 * primitive that powers verifier `llm_judge` and Evolution fitness.
 */
export const ReflectionLLMExtractorSchema = z.object({
  type: z.literal('llm'),
  /** Agent ID for the LLM extractor (typically an evaluator agent). */
  agent_id: z.string(),
  /** Custom instruction passed to the extractor (overrides the default lesson-distillation prompt). */
  instruction: z.string().optional(),
  /**
   * Soft cap on the number of facts the LLM may return. The extractor
   * trims the LLM's response to this value before persistence. Defaults
   * to 10 — small enough that a future retrieval can include them all
   * without blowing prompt budget.
   */
  max_facts: z.number().int().min(1).max(50).default(10),
});

export type ReflectionLLMExtractor = z.infer<typeof ReflectionLLMExtractorSchema>;

/**
 * Reflection node configuration.
 *
 * Compound-systems primitive: runs *after* productive work in a graph,
 * distills the run's outcome into `SemanticFacts`, and writes them to
 * the configured memory store via the injected `MemoryWriter`. Future
 * runs retrieve these facts (filtered by tags) through `memoryRetriever`
 * and compound knowledge over time.
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

/**
 * Summary of a reflection node's output, written to memory at
 * `result_key`. Phases 2/3 populate `fact_ids` with the IDs of the
 * facts written; phase 1 writes only the structural envelope.
 */
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
  read_keys: z.array(z.string()).default([]),
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
  /**
   * Per-node resource caps (tokens / cost). Enforced after each successful
   * node execution — exceeding a cap throws `NodeBudgetExceededError` and
   * engages `failure_policy` retry like any other failure.
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
 * Wire-format input shape for constructing a graph (snake_case).
 *
 * Fields with Zod defaults (`id`) are optional. This is the on-the-wire
 * shape; for idiomatic TypeScript authoring prefer {@link GraphConfig}.
 */
export type GraphInput = z.input<typeof GraphSchema>;

/**
 * camelCase authoring type for a single node, derived from
 * {@link GraphNodeSchema}. This is the public, documented Node interface
 * (see `docs/concepts/nodes`). Snake_case remains the wire/DB format —
 * `createGraph` remaps to it before validation.
 */
export type NodeConfig = Camelize<z.input<typeof GraphNodeSchema>>;

/** camelCase authoring type for a full graph. Accepted by {@link createGraph}. */
export type GraphConfig = Camelize<GraphInput>;

/**
 * Validate camelCase authoring input by deep-remapping to the snake_case
 * wire format, then running the unchanged {@link GraphSchema} for
 * structural validation and default-filling. The remap is idempotent on
 * snake_case keys, so wire-format input is tolerated at runtime too.
 */
const GraphAuthoringSchema = z
  .any()
  .transform((value) => camelToSnakeDeep(value))
  .pipe(GraphSchema);

/**
 * Create a Graph from idiomatic camelCase authoring input ({@link GraphConfig}),
 * auto-generating `id` via `crypto.randomUUID()` when omitted.
 *
 * This is the public authoring entry point — every node field, including
 * nested config blocks (`budget`, `failurePolicy`, `supervisorConfig`, …), is
 * camelCase. To construct a Graph from the snake_case wire format (e.g. a
 * graph loaded from the database or produced by the architect), use
 * `GraphSchema.parse` directly. The runtime remap is idempotent on snake_case
 * keys, so wire-format objects are still tolerated if passed here.
 */
export function createGraph(input: GraphConfig): Graph {
  return GraphAuthoringSchema.parse(input);
}
