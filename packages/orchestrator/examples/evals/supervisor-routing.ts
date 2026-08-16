/**
 * Supervisor Routing Eval Suite
 *
 * Validates that a router-based graph correctly dispatches to a
 * worker node and then completes. Uses a router node to simulate
 * supervisor routing behavior without requiring real LLM calls.
 * Authored with the facade vocabulary: `node()` placements compiled
 * by `graph()` into the same wire the raw API produces.
 *
 * @module evals/supervisor-routing
 */

import {
  graph,
  type EvalSuite,
  router,
  runTool,
} from '@cycgraph/orchestrator';

const retryOnce = { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 } as const;

const dispatch = router({ id: 'router', failurePolicy: retryOnce });
const worker = runTool('mock_worker', { id: 'worker', failurePolicy: retryOnce });
const done = runTool('mock_done', { id: 'done', reads: [worker.result], failurePolicy: retryOnce });

const supervisorGraph = graph({
  name: 'Supervisor Routing Eval',
  description: 'Router dispatches to tool node then completes',
  nodes: [dispatch, worker, done],
  edges: [
    { from: dispatch, to: worker },
    { from: worker, to: done },
  ],
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
        { type: 'node_visited', node_id: dispatch.id },
        { type: 'node_visited', node_id: worker.id },
        { type: 'node_visited', node_id: done.id },
        { type: 'memory_contains', key: worker.result },
      ],
    },
  ],
};

export default suite;
