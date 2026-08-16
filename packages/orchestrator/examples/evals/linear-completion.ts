/**
 * Linear Completion Eval Suite
 *
 * Validates that a simple 2-node tool pipeline (fetch → transform)
 * runs to completion with both nodes visited and results in memory.
 * Authored with the facade vocabulary: `node()` placements compiled
 * by `graph()` into the same wire the raw API produces.
 *
 * @module evals/linear-completion
 */

import {
  graph,
  type EvalSuite,
  runTool,
} from '@cycgraph/orchestrator';

const retryOnce = { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 } as const;

const fetchData = runTool('mock_fetch', { id: 'fetch', failurePolicy: retryOnce });
const transform = runTool('mock_transform', { id: 'transform', reads: [fetchData.result], failurePolicy: retryOnce });

const linearGraph = graph({
  name: 'Linear Completion Eval',
  description: 'Two tool nodes in sequence',
  nodes: [fetchData, transform],
  edges: [{ from: fetchData, to: transform }],
});

/** Eval suite asserting a linear tool pipeline completes successfully. */
export const suite: EvalSuite = {
  name: 'Linear Completion',
  cases: [
    {
      name: 'Two tool nodes complete successfully',
      graph: linearGraph,
      input: { goal: 'Fetch and transform data' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: fetchData.id },
        { type: 'node_visited', node_id: transform.id },
        { type: 'memory_contains', key: fetchData.result },
        { type: 'memory_contains', key: transform.result },
      ],
    },
  ],
};

export default suite;
