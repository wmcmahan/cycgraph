/**
 * Linear Completion Eval Suite
 *
 * Validates that a simple 2-node tool pipeline (fetch → transform)
 * runs to completion with both nodes visited and results in memory.
 *
 * @module evals/linear-completion
 */

import { createGraph, type EvalSuite } from '@cycgraph/orchestrator';

const linearGraph = createGraph({
  name: 'Linear Completion Eval',
  description: 'Two tool nodes in sequence',
  nodes: [
    {
      id: 'fetch',
      type: 'tool',
      toolId: 'mock_fetch',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
    {
      id: 'transform',
      type: 'tool',
      toolId: 'mock_transform',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'fetch', target: 'transform', condition: { type: 'always' } },
  ],
  startNode: 'fetch',
  endNodes: ['transform'],
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
        { type: 'node_visited', node_id: 'fetch' },
        { type: 'node_visited', node_id: 'transform' },
        { type: 'memory_contains', key: 'fetch_result' },
        { type: 'memory_contains', key: 'transform_result' },
      ],
    },
  ],
};

export default suite;
