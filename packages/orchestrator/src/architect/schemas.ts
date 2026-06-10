/**
 * LLM Output Schemas
 *
 * Zod schemas defining the structure that the architect LLM must
 * produce via structured output (`Output.object`). These schemas
 * include sensible defaults so the LLM only needs to specify the
 * fields that matter for a given graph.
 *
 * @module architect/schemas
 */

import { z } from 'zod';
import { ToolSourceSchema } from '../types/tools.js';

/** Edge condition — determines when an edge is traversed. */
const LLMEdgeConditionSchema = z.object({
  /** Condition type: `always`, `conditional`, or `map`. */
  type: z.enum(['always', 'conditional', 'map']),
  /** Expression evaluated at runtime (required for `conditional` type). */
  condition: z.string().optional(),
});

/** Failure / retry policy applied to a single node. */
const LLMFailurePolicySchema = z.object({
  /** Maximum retry attempts before the node is marked as failed. */
  max_retries: z.number().default(3),
  /** Backoff strategy between retries. */
  backoff_strategy: z.enum(['linear', 'exponential', 'fixed']).default('exponential'),
  /** Initial backoff duration in milliseconds. */
  initial_backoff_ms: z.number().default(1000),
  /** Maximum backoff duration in milliseconds. */
  max_backoff_ms: z.number().default(60000),
}).default({
  max_retries: 3,
  backoff_strategy: 'exponential' as const,
  initial_backoff_ms: 1000,
  max_backoff_ms: 60000,
});

/** Supervisor configuration for hierarchical routing nodes. */
const LLMSupervisorConfigSchema = z.object({
  /** ID of the agent that acts as the supervisor LLM. Optional — falls back to node.agent_id. */
  agent_id: z.string().optional(),
  /** Node IDs this supervisor may delegate work to. */
  managed_nodes: z.array(z.string()),
  /** Maximum routing iterations before auto-completing. */
  max_iterations: z.number().int().min(1).max(1000).default(10),
  /** Optional expression that triggers early completion. */
  completion_condition: z.string().optional(),
});

/** A single node in the LLM-generated graph. */
const LLMGraphNodeSchema = z.object({
  id: z.string().describe('Unique node identifier (e.g., "research", "writer", "supervisor")'),
  type: z.enum(['agent', 'tool', 'subgraph', 'synthesizer', 'router', 'supervisor', 'map', 'voting', 'approval', 'evolution', 'verifier', 'reflection'])
    .describe('Node type'),
  agent_id: z.string().optional().describe('Agent config ID (required for agent nodes)'),
  tools: z.array(ToolSourceSchema).optional().describe('Tool sources for this node (overrides agent config tools when set)'),
  tool_id: z.string().optional().describe('Tool ID (for tool nodes)'),
  supervisor_config: LLMSupervisorConfigSchema.optional()
    .describe('Required for supervisor nodes'),
  read_keys: z.array(z.string()).default([]).describe('Memory keys this node may read (least-privilege: list only what the node needs; goal/constraints are always available). Avoid ["*"].'),
  write_keys: z.array(z.string()).default([]).describe('State keys this node can write'),
  failure_policy: LLMFailurePolicySchema,
  requires_compensation: z.boolean().default(false),
});

/** A directed edge connecting two nodes. */
const LLMGraphEdgeSchema = z.object({
  /** Unique edge identifier (e.g., `"e1"`, `"e2"`). */
  id: z.string().describe('Unique edge identifier'),
  /** Source node ID. */
  source: z.string().describe('Source node ID'),
  /** Target node ID. */
  target: z.string().describe('Target node ID'),
  /** Traversal condition (defaults to `always`). */
  condition: LLMEdgeConditionSchema.default({ type: 'always' }),
});

/**
 * Top-level schema for LLM-generated workflow graphs.
 *
 * This is the schema passed to `Output.object()` in the architect's
 * `generateText` call. The LLM must produce output conforming to
 * this structure.
 */
export const LLMGraphSchema = z.object({
  /** Short human-readable workflow name. */
  name: z.string().describe('Short human-readable name for this workflow'),
  /** Description of what the workflow does. */
  description: z.string().describe('What this workflow does'),
  /** All nodes in the graph. */
  nodes: z.array(LLMGraphNodeSchema).describe('All nodes in the graph'),
  /** Directed edges connecting nodes. */
  edges: z.array(LLMGraphEdgeSchema).describe('Connections between nodes'),
  /** ID of the first node to execute. */
  start_node: z.string().describe('ID of the first node to execute'),
  /** Terminal node IDs (empty for supervisor-driven graphs). */
  end_nodes: z.array(z.string()).describe('IDs of terminal nodes'),
});
