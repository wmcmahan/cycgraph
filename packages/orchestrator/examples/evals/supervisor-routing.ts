/**
 * Supervisor Routing Eval Suite
 *
 * Validates that a router-based graph correctly dispatches to a
 * worker node and then completes. Uses a router node to simulate
 * supervisor routing behavior without requiring real LLM calls.
 *
 * @module evals/supervisor-routing
 */

import { createGraph, type EvalSuite } from '@cycgraph/orchestrator';

const supervisorGraph = createGraph({
  name: 'Supervisor Routing Eval',
  description: 'Router dispatches to tool node then completes',
  nodes: [
    {
      id: 'router',
      type: 'router',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
    {
      id: 'worker',
      type: 'tool',
      toolId: 'mock_worker',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
    {
      id: 'done',
      type: 'tool',
      toolId: 'mock_done',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'router', target: 'worker', condition: { type: 'always' } },
    { id: 'e2', source: 'worker', target: 'done', condition: { type: 'always' } },
  ],
  startNode: 'router',
  endNodes: ['done'],
});

/** Eval suite asserting the router dispatches to a worker and completes. */
export const suite: EvalSuite = {
  name: 'Supervisor Routing',
  cases: [
    {
      name: 'Router dispatches to worker then completes',
      graph: supervisorGraph,
      input: { goal: 'Route work to a tool node' },
      assertions: [
        { type: 'status_equals', expected: 'completed' },
        { type: 'node_visited', node_id: 'router' },
        { type: 'node_visited', node_id: 'worker' },
        { type: 'node_visited', node_id: 'done' },
        { type: 'memory_contains', key: 'worker_result' },
      ],
    },
  ],
};

export default suite;
