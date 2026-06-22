/**
 * Shared benchmark helpers.
 *
 * Reusable graph and state builders so individual `.bench.ts` files stay
 * focused on the measurement, not the setup.
 */

import {
  GraphSchema,
  WorkflowStateSchema,
  type Graph,
  type WorkflowState,
} from '@cycgraph/orchestrator';

/**
 * Build a linear N-node graph where every node is a `tool` node calling the
 * built-in `save_to_memory` tool. Pure CPU + reducer cost — no LLM, no
 * persistence (unless wired by the caller).
 *
 * Useful for isolating GraphRunner overhead from any external system.
 */
export function buildLinearToolGraph(nodeCount: number): Graph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    type: 'tool' as const,
    tool_id: 'save_to_memory',
    tools: [{ type: 'builtin' as const, name: 'save_to_memory' as const }],
    read_keys: ['*'],
    write_keys: ['*'],
    // `max_retries` is total attempts, not retries-after-first. 1 = single attempt.
    failure_policy: { max_retries: 1, backoff_strategy: 'linear' as const },
  }));

  const edges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
    id: `e${i}`,
    source: `n${i}`,
    target: `n${i + 1}`,
    condition: { type: 'always' as const },
  }));

  // Snake_case wire format — validated directly rather than through the
  // camelCase `createGraph` authoring entry.
  return GraphSchema.parse({
    name: `linear-${nodeCount}`,
    description: `Linear ${nodeCount}-node graph for benchmarks`,
    nodes,
    edges,
    start_node: 'n0',
    end_nodes: [`n${nodeCount - 1}`],
  });
}

/**
 * Build a baseline state with realistic iteration headroom. Use a larger
 * `max_iterations` than the graph size so the runner doesn't trip the
 * iteration ceiling on the 1000-node bench.
 */
export function buildBenchState(graph: Graph, opts?: { maxIterations?: number }): WorkflowState {
  return WorkflowStateSchema.parse({
    workflow_id: graph.id,
    goal: 'bench',
    max_iterations: opts?.maxIterations ?? Math.max(50, graph.nodes.length + 10),
  });
}
