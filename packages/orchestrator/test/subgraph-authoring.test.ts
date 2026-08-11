/**
 * Compile-level tests for the subgraph() authoring constructor
 * (src/authoring/subgraph.ts): wire equality with the raw API, child-graph
 * collection for run()'s auto-wiring, and the duplicate-id guard.
 */

import { describe, it, expect } from 'vitest';
import { agent } from '../src/authoring/agent.js';
import { node } from '../src/authoring/node.js';
import { subgraph } from '../src/authoring/subgraph.js';
import { graph, graphsForGraph, GraphSpecError } from '../src/authoring/graph.js';
import { createGraph, type Graph } from '../src/graph/graph.js';

function childGraph(name = 'child'): Graph {
  const worker = node({
    id: 'worker',
    agent: agent({ model: 'claude-sonnet-4-6', instructions: 'work' }),
    reads: ['goal_in'],
    writes: 'out',
  });
  return graph({ name, nodes: [worker], edges: [] });
}

describe('subgraph', () => {
  it('compiles to the same wire node as the raw subgraph API', () => {
    const child = childGraph();

    const viaFacade = graph({
      name: 'parent',
      nodes: [
        subgraph(child, {
          id: 'call-child',
          reads: ['topic'],
          writes: 'result',
          inputs: { topic: 'goal_in' },
          outputs: { out: 'result' },
          maxIterations: 7,
        }),
      ],
    });
    const viaRaw = createGraph({
      name: 'parent',
      description: '',
      nodes: [
        {
          id: 'call-child',
          type: 'subgraph',
          readKeys: ['topic'],
          writeKeys: ['result'],
          subgraphConfig: {
            subgraphId: child.id,
            inputMapping: { topic: 'goal_in' },
            outputMapping: { out: 'result' },
            maxIterations: 7,
          },
        },
      ],
      edges: [],
      startNode: 'call-child',
      endNodes: ['call-child'],
    });

    expect(viaFacade.nodes[0]).toEqual(viaRaw.nodes[0]);
  });

  it('puts only the child id string in the serialized parent', () => {
    const child = childGraph();
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call-child', outputs: { out: 'result' }, writes: 'result' })],
    });

    const wire = JSON.parse(JSON.stringify(parent)) as Graph;

    expect(wire.nodes[0].subgraph_config?.subgraph_id).toBe(child.id);
    expect(JSON.stringify(wire)).not.toContain('"worker"');
  });

  it('applies schema defaults when mappings are omitted', () => {
    const child = childGraph();
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call-child' })],
    });

    expect(parent.nodes[0].subgraph_config).toEqual({
      subgraph_id: child.id,
      input_mapping: {},
      output_mapping: {},
      max_iterations: 50,
    });
  });

  it('collects an in-scope child graph for run()', () => {
    const child = childGraph();
    const parent = graph({
      name: 'parent',
      nodes: [subgraph(child, { id: 'call-child' })],
    });

    expect(graphsForGraph(parent)).toEqual([child]);
  });

  it('collects nothing for a string child id', () => {
    const parent = graph({
      name: 'parent',
      nodes: [subgraph('external-graph-id', { id: 'call-child' })],
    });

    expect(graphsForGraph(parent)).toEqual([]);
    expect(parent.nodes[0].subgraph_config?.subgraph_id).toBe('external-graph-id');
  });

  it('dedupes the same child reused across several subgraph nodes', () => {
    const child = childGraph();
    const parent = graph({
      name: 'parent',
      nodes: [
        subgraph(child, { id: 'first', outputs: { out: 'a' }, writes: 'a' }),
        subgraph(child, { id: 'second', outputs: { out: 'b' }, writes: 'b' }),
      ],
      edges: [{ from: 'first', to: 'second' }],
    });

    expect(graphsForGraph(parent)).toEqual([child]);
  });

  it('rejects two distinct child graphs sharing an id', () => {
    const childA = childGraph('child-a');
    const childB = { ...childGraph('child-b'), id: childA.id };

    expect(() =>
      graph({
        name: 'parent',
        nodes: [
          subgraph(childA, { id: 'first' }),
          subgraph(childB, { id: 'second' }),
        ],
        edges: [{ from: 'first', to: 'second' }],
      }),
    ).toThrow(GraphSpecError);
  });
});
