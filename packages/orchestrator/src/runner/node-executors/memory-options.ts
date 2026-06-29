/**
 * Shared helper that translates a graph node's `memory_query` directive
 * and the runner's `memoryRetriever` into the option shape consumed by
 * `executeAgent` / `executeSupervisor`.
 *
 * Keeps the 8-line pattern out of every agent-style node executor
 * (agent, annealing, map, swarm, synthesizer, supervisor, …). Returns
 * `{}` when there is nothing to pass through so callers can spread the
 * result without conditionals.
 *
 * @module runner/node-executors/memory-options
 */

import type { GraphNode } from '../../types/graph.js';
import type { MemoryRetriever } from '../../agent/memory-retriever.js';
import type { NodeExecutorContext } from './context.js';

/**
 * Options accepted by `executeAgent` / `executeSupervisor` for memory
 * retrieval. The orchestrator uses camelCase here even though
 * `GraphNode.memory_query` is snake_case — the helper handles the
 * translation in one place.
 */
export interface AgentMemoryOptions {
  memoryRetriever?: MemoryRetriever;
  memory_query?: {
    text?: string;
    entityIds?: string[];
    tags?: string[];
    maxFacts?: number;
    /** Retrieved content is untrusted → taint the agent's outputs. */
    untrusted?: boolean;
  };
}

/**
 * Build the memory-retrieval options for a node call.
 *
 * - Omits `memoryRetriever` when the runner has none → the executor
 *   won't bother fetching.
 * - Omits `memory_query` when the node hasn't declared one → the
 *   executor skips retrieval entirely (no goal-default).
 */
export function buildAgentMemoryOptions(
  node: GraphNode,
  ctx: NodeExecutorContext,
): AgentMemoryOptions {
  const out: AgentMemoryOptions = {};
  if (ctx.memoryRetriever) {
    out.memoryRetriever = ctx.memoryRetriever;
  }
  if (node.memory_query) {
    out.memory_query = {
      text: node.memory_query.text,
      entityIds: node.memory_query.entity_ids,
      tags: node.memory_query.tags,
      maxFacts: node.memory_query.max_facts,
      untrusted: node.memory_query.untrusted,
    };
  }
  return out;
}
