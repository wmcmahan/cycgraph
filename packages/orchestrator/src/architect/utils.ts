/**
 * Graph Conversion Utilities
 *
 * Converts between the LLM-friendly graph format ({@link LLMGraph}) and
 * the runtime {@link Graph} format. The LLM format omits IDs, timestamps,
 * and version — those are added/stripped during conversion.
 *
 * @module architect/utils
 */

import { z } from 'zod';
import type { Graph } from '../types/graph.js';
import { GraphSchema } from '../types/graph.js';
import { LLMGraphSchema } from './schemas.js';

/** Inferred type of an LLM-generated graph (before runtime fields are added). */
export type LLMGraph = z.infer<typeof LLMGraphSchema>;

/**
 * Convert an LLM-generated graph to a full runtime {@link Graph}.
 *
 * Adds a UUID `id` (or preserves `existingId` in modification mode).
 *
 * @param llm - The validated LLM output.
 * @param existingId - If provided, preserves this ID (modification mode).
 * @returns A complete {@link Graph} ready for validation and persistence.
 */
export function llmGraphToGraph(llm: LLMGraph, existingId?: string): Graph {
  // Architect output is already snake_case wire format — validate it directly
  // rather than through the camelCase `createGraph` authoring entry.
  return GraphSchema.parse({
    ...(existingId ? { id: existingId } : {}),
    name: llm.name,
    description: llm.description,
    nodes: llm.nodes.map(n => ({
      ...n,
      failure_policy: {
        max_retries: n.failure_policy.max_retries,
        backoff_strategy: n.failure_policy.backoff_strategy,
        initial_backoff_ms: n.failure_policy.initial_backoff_ms,
        max_backoff_ms: n.failure_policy.max_backoff_ms,
      },
      requires_compensation: n.requires_compensation,
    })),
    edges: llm.edges.map(e => ({
      ...e,
      condition: {
        type: e.condition.type as 'always' | 'conditional' | 'map',
        condition: e.condition.condition,
      },
    })),
    start_node: llm.start_node,
    end_nodes: llm.end_nodes,
  });
}

/**
 * Convert a runtime {@link Graph} back to the LLM-friendly format.
 *
 * Strips the runtime `id` field so the LLM can understand and modify
 * the structure without confusion.
 *
 * Used in modification mode to provide context to the architect LLM.
 *
 * @param graph - The runtime graph to convert.
 * @returns An {@link LLMGraph} suitable for embedding in a prompt.
 */
export function graphToLLMSnapshot(graph: Graph): LLMGraph {
  return {
    name: graph.name,
    description: graph.description,
    nodes: graph.nodes.map(n => ({
      id: n.id,
      type: n.type,
      agent_id: n.agent_id,
      tools: n.tools,
      tool_id: n.tool_id,
      supervisor_config: n.supervisor_config,
      read_keys: n.read_keys,
      write_keys: n.write_keys,
      failure_policy: {
        max_retries: n.failure_policy.max_retries,
        backoff_strategy: n.failure_policy.backoff_strategy,
        initial_backoff_ms: n.failure_policy.initial_backoff_ms,
        max_backoff_ms: n.failure_policy.max_backoff_ms,
      },
      requires_compensation: n.requires_compensation,
    })),
    edges: graph.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      condition: { type: e.condition.type, condition: e.condition.condition },
    })),
    start_node: graph.start_node,
    end_nodes: graph.end_nodes,
  };
}
