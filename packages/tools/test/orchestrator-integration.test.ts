/**
 * Cross-package integration: a @cycgraph/tools factory result registered on
 * a real GraphRunner resolves through the composed tool pipeline and
 * executes in a tool node, declared via the bare-name authoring sugar.
 * No LLM or network involved.
 */

import { describe, it, expect } from 'vitest';
import { GraphRunner, createGraph, createWorkflowState } from '@cycgraph/orchestrator';
import { jsonTransformTool } from '../src/data/json-transform.js';

describe('GraphRunner integration', () => {
  it('executes a tools-package tool inside a tool node', async () => {
    const graph = createGraph({
      name: 'transform-graph',
      description: 'single tool node running json_transform',
      nodes: [
        {
          id: 'reshape',
          type: 'tool',
          toolId: 'json_transform',
          tools: ['json_transform'],
          readKeys: ['data', 'path'],
        },
      ],
      edges: [],
      startNode: 'reshape',
      endNodes: ['reshape'],
    });
    const state = createWorkflowState({
      workflowId: crypto.randomUUID(),
      goal: 'reshape the payload',
      memory: { data: { orders: [{ id: 'o-1', total: 42 }] }, path: 'orders[0].total' },
    });
    const runner = new GraphRunner(graph, state, {
      tools: [jsonTransformTool()],
    });

    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory.reshape_result).toEqual({ result: 42 });
  });
});
