/**
 * HITL Approval Eval Suite
 *
 * Validates that an approval gate pauses the workflow. The graph
 * has a tool → approval → tool pipeline. Since no human input is
 * provided during the eval, the workflow must end in `waiting` status.
 *
 * @module evals/hitl-approval
 */

import { createGraph, type EvalSuite } from '@cycgraph/orchestrator';

const hitlGraph = createGraph({
  name: 'HITL Approval Eval',
  description: 'Approval gate pauses for human review',
  nodes: [
    {
      id: 'prepare',
      type: 'tool',
      toolId: 'mock_prepare',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approvalConfig: {
        approvalType: 'human_review',
        promptMessage: 'Please review the prepared data.',
        reviewKeys: ['*'],
        timeoutMs: 86_400_000,
      },
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
    {
      id: 'finalize',
      type: 'tool',
      toolId: 'mock_finalize',
      readKeys: ['*'],
      writeKeys: ['*'],
      failurePolicy: { maxRetries: 1, backoffStrategy: 'fixed', initialBackoffMs: 0, maxBackoffMs: 0 },
      requiresCompensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'prepare', target: 'review', condition: { type: 'always' } },
    { id: 'e2', source: 'review', target: 'finalize', condition: { type: 'always' } },
  ],
  startNode: 'prepare',
  endNodes: ['finalize'],
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
