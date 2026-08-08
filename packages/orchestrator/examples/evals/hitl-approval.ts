/**
 * HITL Approval Eval Suite
 *
 * Validates that an approval gate pauses the workflow. The graph
 * has a tool → approval → tool pipeline. Since no human input is
 * provided during the eval, the workflow must end in `waiting` status.
 * Authored with the facade vocabulary: `node()` placements compiled
 * by `graph()` into the same wire the raw API produces.
 *
 * @module evals/hitl-approval
 */

import { graph, node, type EvalSuite } from '@cycgraph/orchestrator';

const retryOnce = { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 } as const;

const prepare = node({ id: 'prepare', type: 'tool', toolId: 'mock_prepare', reads: ['*'], writes: ['*'], failurePolicy: retryOnce });
const review = node({
  id: 'review',
  type: 'approval',
  approvalConfig: { promptMessage: 'Please review the prepared data.' },
  reads: ['*'],
  writes: ['*'],
  failurePolicy: retryOnce,
});
const finalize = node({ id: 'finalize', type: 'tool', toolId: 'mock_finalize', reads: ['*'], writes: ['*'], failurePolicy: retryOnce });

const hitlGraph = graph({
  name: 'HITL Approval Eval',
  description: 'Approval gate pauses for human review',
  nodes: [prepare, review, finalize],
  edges: [
    { from: prepare, to: review },
    { from: review, to: finalize },
  ],
});

/** Eval suite asserting the approval gate pauses the workflow. */
export const suite: EvalSuite = {
  name: 'HITL Approval',
  cases: [
    {
      name: 'Workflow pauses at approval gate',
      graph: hitlGraph,
      input: { goal: 'Process data with human review' },
      assertions: [
        { type: 'status_equals', expected: 'waiting' },
        { type: 'node_visited', node_id: 'prepare' },
        { type: 'node_visited', node_id: 'review' },
        { type: 'memory_contains', key: 'prepare_result' },
      ],
    },
  ],
};

export default suite;
