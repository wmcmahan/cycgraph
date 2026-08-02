/**
 * Unit tests for the pure routing primitives (runner/router.ts):
 * getNextNode, getCurrentNode, shouldContinue, buildEdgeMap.
 */
import { describe, it, expect } from 'vitest';

import { getNextNode, getCurrentNode, shouldContinue, buildEdgeMap } from '../src/runner/router.js';
import { createTestState, createLinearGraph } from './helpers/factories.js';
import type { Graph, GraphNode, GraphEdge } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

function nodeMapOf(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('buildEdgeMap', () => {
  it('indexes edges by source node id', () => {
    const graph = createLinearGraph();

    const edgeMap = buildEdgeMap(graph);

    expect(edgeMap.get('node-1')).toHaveLength(1);
    expect(edgeMap.get('node-1')![0].target).toBe('node-2');
  });

  it('groups multiple edges sharing a source in declaration order', () => {
    const graph = {
      ...createLinearGraph(),
      edges: [
        { id: 'e1', source: 'node-1', target: 'node-2', condition: { type: 'always' } },
        { id: 'e2', source: 'node-1', target: 'node-3', condition: { type: 'always' } },
      ] as GraphEdge[],
    } as Graph;

    const edgeMap = buildEdgeMap(graph);

    expect(edgeMap.get('node-1')!.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('returns an empty map for an edgeless graph', () => {
    const graph = { ...createLinearGraph(), edges: [] } as Graph;

    const edgeMap = buildEdgeMap(graph);

    expect(edgeMap.size).toBe(0);
  });
});

describe('getNextNode', () => {
  it('returns the target of the first matching edge', () => {
    const graph = createLinearGraph();
    const edgeMap = buildEdgeMap(graph);
    const nodeMap = nodeMapOf(graph.nodes);

    const next = getNextNode(edgeMap, nodeMap, graph.nodes[0], createTestState());

    expect(next?.id).toBe('node-2');
  });

  it('returns null when the current node has no outgoing edges', () => {
    const graph = createLinearGraph();
    const edgeMap = buildEdgeMap(graph);
    const nodeMap = nodeMapOf(graph.nodes);

    const next = getNextNode(edgeMap, nodeMap, graph.nodes[1], createTestState());

    expect(next).toBeNull();
  });

  it('returns null when no edge condition matches', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'node-1', target: 'node-2', condition: { type: 'expression', expression: 'memory.go == "yes"' } },
    ];
    const graph = { ...createLinearGraph(), edges } as Graph;
    const edgeMap = buildEdgeMap(graph);
    const nodeMap = nodeMapOf(graph.nodes);

    const next = getNextNode(edgeMap, nodeMap, graph.nodes[0], createTestState({ memory: { go: 'no' } }));

    expect(next).toBeNull();
  });

  it('skips a matching edge whose target node is missing from the node map', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'node-1', target: 'ghost', condition: { type: 'always' } },
    ];
    const graph = { ...createLinearGraph(), edges } as Graph;
    const edgeMap = buildEdgeMap(graph);
    const nodeMap = nodeMapOf(graph.nodes);

    const next = getNextNode(edgeMap, nodeMap, graph.nodes[0], createTestState());

    expect(next).toBeNull();
  });
});

describe('getCurrentNode', () => {
  it('resolves the node named by state.current_node', () => {
    const graph = createLinearGraph();
    const nodeMap = nodeMapOf(graph.nodes);

    const current = getCurrentNode(nodeMap, createTestState({ current_node: 'node-2' }));

    expect(current?.id).toBe('node-2');
  });

  it('returns null when state has no current node', () => {
    const graph = createLinearGraph();
    const nodeMap = nodeMapOf(graph.nodes);

    const current = getCurrentNode(nodeMap, createTestState({ current_node: undefined }));

    expect(current).toBeNull();
  });

  it('returns null when the current node id is not in the node map', () => {
    const graph = createLinearGraph();
    const nodeMap = nodeMapOf(graph.nodes);

    const current = getCurrentNode(nodeMap, createTestState({ current_node: 'ghost' }));

    expect(current).toBeNull();
  });
});

describe('shouldContinue', () => {
  it('is true when running with a current node', () => {
    const state: WorkflowState = createTestState({ status: 'running', current_node: 'node-1' });

    expect(shouldContinue(state)).toBe(true);
  });

  it('is false when the status is not running', () => {
    const state: WorkflowState = createTestState({ status: 'completed', current_node: 'node-1' });

    expect(shouldContinue(state)).toBe(false);
  });

  it('is false when there is no current node', () => {
    const state: WorkflowState = createTestState({ status: 'running', current_node: undefined });

    expect(shouldContinue(state)).toBe(false);
  });
});
