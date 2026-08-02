import { describe, it, expect } from 'vitest';
import { llmGraphToGraph, graphToLLMSnapshot, type LLMGraph } from '../src/architect/utils.js';
import type { Graph, GraphNode, GraphEdge } from '../src/types/graph.js';

// ─── Fixtures ────────────────────────────────────────────────────────

function makeLLMGraph(overrides: Partial<LLMGraph> = {}): LLMGraph {
  return {
    name: 'Test Workflow',
    description: 'A test workflow',
    nodes: [
      {
        id: 'research',
        type: 'agent',
        agent_id: 'researcher',
        read_keys: ['*'],
        write_keys: ['findings'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'research',
        target: 'writer',
        condition: { type: 'always' },
      },
    ],
    start_node: 'research',
    end_nodes: ['writer'],
    ...overrides,
  };
}

function makeGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    id: 'graph-123',
    name: 'Test Workflow',
    description: 'A test workflow',
    nodes: [
      {
        id: 'research',
        type: 'agent',
        agent_id: 'researcher',
        read_keys: ['*'],
        write_keys: ['findings'],
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
        },
        requires_compensation: false,
      } as GraphNode,
    ],
    edges: [
      {
        id: 'e1',
        source: 'research',
        target: 'writer',
        condition: { type: 'always' },
      } as GraphEdge,
    ],
    start_node: 'research',
    end_nodes: ['writer'],
    ...overrides,
  } as Graph;
}

// ─── llmGraphToGraph ──────────────────────────────────────────────────

describe('llmGraphToGraph', () => {
  it('generates a UUID id when no existingId is provided', () => {
    const llm = makeLLMGraph();
    const graph = llmGraphToGraph(llm);

    expect(graph.id).toBeDefined();
    expect(graph.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('preserves existingId in modification mode', () => {
    const llm = makeLLMGraph();
    const graph = llmGraphToGraph(llm, 'existing-id-123');

    expect(graph.id).toBe('existing-id-123');
  });

  it('does not include version or timestamps (persistence-layer concerns)', () => {
    const graph = llmGraphToGraph(makeLLMGraph());
    expect((graph as any).version).toBeUndefined();
    expect((graph as any).created_at).toBeUndefined();
    expect((graph as any).updated_at).toBeUndefined();
  });

  it('maps nodes with failure_policy and requires_compensation', () => {
    const graph = llmGraphToGraph(makeLLMGraph());

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe('research');
    expect(graph.nodes[0].failure_policy.max_retries).toBe(3);
    expect(graph.nodes[0].failure_policy.backoff_strategy).toBe('exponential');
    expect(graph.nodes[0].requires_compensation).toBe(false);
  });

  it('maps edges with condition types', () => {
    const graph = llmGraphToGraph(makeLLMGraph());

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].source).toBe('research');
    expect(graph.edges[0].target).toBe('writer');
    expect(graph.edges[0].condition.type).toBe('always');
  });

  it('preserves start_node and end_nodes', () => {
    const graph = llmGraphToGraph(makeLLMGraph());
    expect(graph.start_node).toBe('research');
    expect(graph.end_nodes).toEqual(['writer']);
  });

  it('handles conditional edges', () => {
    const llm = makeLLMGraph({
      edges: [{
        id: 'e1',
        source: 'a',
        target: 'b',
        condition: { type: 'conditional', condition: 'status == "done"' },
      }],
    });
    const graph = llmGraphToGraph(llm);

    expect(graph.edges[0].condition.type).toBe('conditional');
    expect(graph.edges[0].condition.condition).toBe('status == "done"');
  });

  it('handles empty nodes and edges', () => {
    const llm = makeLLMGraph({ nodes: [], edges: [] });
    const graph = llmGraphToGraph(llm);

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});

// ─── graphToLLMSnapshot ───────────────────────────────────────────────

describe('graphToLLMSnapshot', () => {
  it('strips runtime-only fields (id, version, timestamps)', () => {
    const graph = makeGraph();
    const snapshot = graphToLLMSnapshot(graph);

    expect(snapshot).not.toHaveProperty('id');
    expect(snapshot).not.toHaveProperty('version');
    expect(snapshot).not.toHaveProperty('created_at');
    expect(snapshot).not.toHaveProperty('updated_at');
  });

  it('preserves name and description', () => {
    const graph = makeGraph({ name: 'My Workflow', description: 'Does stuff' });
    const snapshot = graphToLLMSnapshot(graph);

    expect(snapshot.name).toBe('My Workflow');
    expect(snapshot.description).toBe('Does stuff');
  });

  it('maps nodes with all relevant fields', () => {
    const snapshot = graphToLLMSnapshot(makeGraph());

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0].id).toBe('research');
    expect(snapshot.nodes[0].type).toBe('agent');
    expect(snapshot.nodes[0].agent_id).toBe('researcher');
    expect(snapshot.nodes[0].read_keys).toEqual(['*']);
    expect(snapshot.nodes[0].write_keys).toEqual(['findings']);
    expect(snapshot.nodes[0].failure_policy.max_retries).toBe(3);
  });

  it('maps edges with condition', () => {
    const snapshot = graphToLLMSnapshot(makeGraph());

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0].source).toBe('research');
    expect(snapshot.edges[0].target).toBe('writer');
    expect(snapshot.edges[0].condition.type).toBe('always');
  });

  it('preserves start_node and end_nodes', () => {
    const snapshot = graphToLLMSnapshot(makeGraph());
    expect(snapshot.start_node).toBe('research');
    expect(snapshot.end_nodes).toEqual(['writer']);
  });

  it('round-trips through llmGraphToGraph', () => {
    const original = makeGraph();
    const snapshot = graphToLLMSnapshot(original);
    const restored = llmGraphToGraph(snapshot, original.id);

    expect(restored.name).toBe(original.name);
    expect(restored.nodes.length).toBe(original.nodes.length);
    expect(restored.edges.length).toBe(original.edges.length);
    expect(restored.start_node).toBe(original.start_node);
  });
});
