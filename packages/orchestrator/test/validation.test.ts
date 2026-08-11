/**
 * Tests for the graph structure validator (graph/graph-validator.ts).
 */

import { describe, it, expect } from 'vitest';
import { validateGraph } from '../src/graph/graph-validator.js';
import type { Graph, GraphNode } from '../src/index.js';

const FAILURE_POLICY = {
  max_retries: 1,
  backoff_strategy: 'fixed' as const,
  initial_backoff_ms: 0,
  max_backoff_ms: 0,
};

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n',
    type: 'agent',
    agent_id: 'agent-x',
    read_keys: [],
    write_keys: [],
    requires_compensation: false,
    failure_policy: FAILURE_POLICY,
    ...overrides,
  } as GraphNode;
}

function createValidGraph(): Graph {
  return {
    id: 'test-graph',
    name: 'Test Graph',
    description: 'A valid test graph',
    start_node: 'start',
    end_nodes: ['end'],
    nodes: [
      node({ id: 'start', agent_id: 'agent-1', read_keys: ['goal'], write_keys: ['result'] }),
      node({ id: 'end', agent_id: 'agent-2', read_keys: ['result'], write_keys: ['final'] }),
    ],
    edges: [{ id: 'edge-1', source: 'start', target: 'end', condition: { type: 'always' } }],
  } as Graph;
}

describe('validateGraph', () => {
  describe('valid graphs', () => {
    it('accepts a well-formed graph with no errors', () => {
      const result = validateGraph(createValidGraph());

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts a graph with multiple conditional paths', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'router', type: 'router', agent_id: undefined, read_keys: ['result'] }));
      graph.edges = [
        { id: 'edge-1', source: 'start', target: 'router', condition: { type: 'always' } },
        { id: 'edge-2', source: 'router', target: 'end', condition: { type: 'conditional', condition: 'memory.approved == 1' } },
        { id: 'edge-3', source: 'router', target: 'end', condition: { type: 'conditional', condition: 'memory.approved == 0' } },
      ];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('least-privilege warnings', () => {
    it('warns when a node reads with a wildcard', () => {
      const graph = createValidGraph();
      graph.nodes[0].read_keys = ['*'];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("'start'") && w.includes("read_keys includes '*'"))).toBe(true);
    });

    it('warns when a node writes with a wildcard', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['*'];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("'start'") && w.includes("write_keys includes '*'"))).toBe(true);
    });

    it('does not warn when all nodes use explicit keys', () => {
      const result = validateGraph(createValidGraph());

      expect(result.warnings.some(w => w.includes("read_keys includes '*'"))).toBe(false);
      expect(result.warnings.some(w => w.includes("write_keys includes '*'"))).toBe(false);
    });
  });

  describe('start and end node existence', () => {
    it('errors when the start node is absent', () => {
      const graph = createValidGraph();
      graph.start_node = 'nonexistent';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Start node 'nonexistent' not found in graph nodes");
    });

    it('errors when an end node is absent', () => {
      const graph = createValidGraph();
      graph.end_nodes = ['missing'];

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("End node 'missing' not found in graph nodes");
    });

    it('warns when there are no end nodes and no supervisor', () => {
      const graph = createValidGraph();
      graph.end_nodes = [];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('no end nodes'))).toBe(true);
    });
  });

  describe('edge validation', () => {
    it('errors when an edge source is absent', () => {
      const graph = createValidGraph();
      graph.edges[0].source = 'missing';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("source node 'missing' not found"))).toBe(true);
    });

    it('errors when an edge target is absent', () => {
      const graph = createValidGraph();
      graph.edges[0].target = 'missing';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("target node 'missing' not found"))).toBe(true);
    });

    it('warns on a self-referencing edge', () => {
      const graph = createValidGraph();
      graph.edges.push({ id: 'self-edge', source: 'start', target: 'start', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('self-referencing') && w.includes('start'))).toBe(true);
    });

    it('warns on a conditional edge with no condition string', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional' };

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('conditional') && w.includes('missing a condition'))).toBe(true);
    });
  });

  describe('duplicate IDs', () => {
    it('errors on a duplicate node ID', () => {
      const graph = createValidGraph();
      graph.nodes.push({ ...graph.nodes[0] });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Duplicate node ID: 'start'");
    });

    it('errors on a duplicate edge ID', () => {
      const graph = createValidGraph();
      graph.edges.push({ ...graph.edges[0] });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Duplicate edge ID: 'edge-1'");
    });
  });

  describe('reachability and dead ends', () => {
    it('warns when a node is unreachable from start', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'unreachable', agent_id: 'agent-3', write_keys: ['data'] }));

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("Node 'unreachable' is unreachable from start node");
    });

    it('warns when a non-end node has no outgoing edges', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'middle', agent_id: 'agent-3', write_keys: ['data'] }));
      graph.edges.push({ id: 'edge-2', source: 'start', target: 'middle', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('middle') && w.includes('no outgoing edges'))).toBe(true);
    });
  });

  describe('condition expression syntax', () => {
    it('errors on a syntactically invalid expression', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: '(((' };

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('edge-1') && e.includes('syntax error'))).toBe(true);
    });

    it('accepts an expression using runtime extra functions', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = {
        type: 'conditional',
        condition: 'length(memory.items) > 0 and lower(memory.status) == "ready"',
      };

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('edge-1'))).toBe(false);
    });

    it('accepts single-quoted string literals via shared normalization', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: "memory.status == 'ready'" };

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('edge-1') && e.includes('syntax error'))).toBe(false);
    });

    it('warns on a bare true/false literal', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: 'memory.flag == true' };

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('edge-1') && w.includes("bare 'true'/'false'"))).toBe(true);
    });

    it('does not warn about bare literals when true/false appears only inside a quoted string', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: "memory.status == 'true'" };

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('edge-1') && w.includes("bare 'true'/'false'"))).toBe(false);
    });
  });

  describe('default_write_key', () => {
    it('errors when default_write_key is not in write_keys', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['research_notes', 'summary'];
      graph.nodes[0].default_write_key = 'invalid_key';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('default_write_key') && e.includes('invalid_key'))).toBe(true);
    });

    it('passes when default_write_key is in write_keys', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['research_notes', 'summary'];
      graph.nodes[0].default_write_key = 'research_notes';

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('default_write_key'))).toBe(false);
    });

    it('passes when write_keys is a wildcard', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['*'];
      graph.nodes[0].default_write_key = 'anything';

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('default_write_key'))).toBe(false);
    });
  });

  describe('dangling read detection', () => {
    it('warns when a read_keys entry is produced by no node', () => {
      const graph = createValidGraph();
      graph.nodes[0].read_keys = ['never_written'];

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('never_written') && w.includes('not produced by any node'))).toBe(true);
    });

    it('does not warn when a wildcard writer exists', () => {
      const graph = createValidGraph();
      graph.nodes[1].write_keys = ['*'];
      graph.nodes[0].read_keys = ['never_written'];

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('not produced by any node'))).toBe(false);
    });

    it('treats an agent output fallback key as producible', () => {
      const graph = createValidGraph();
      graph.nodes[1].read_keys = ['start_output'];

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('start_output') && w.includes('not produced'))).toBe(false);
    });
  });

  describe('agent nodes', () => {
    it('errors when agent_id is missing', () => {
      const graph = createValidGraph();
      delete (graph.nodes[0] as { agent_id?: string }).agent_id;

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Agent node 'start' is missing agent_id");
    });

    it('errors when agent_id is an empty string', () => {
      const graph = createValidGraph();
      (graph.nodes[0] as { agent_id: string }).agent_id = '';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Agent node 'start' is missing agent_id");
    });

    it('warns when annealing initial_temperature is below final_temperature', () => {
      const graph = createValidGraph();
      graph.nodes[0].annealing_config = {
        initial_temperature: 0.2,
        final_temperature: 1.0,
        max_iterations: 5,
        threshold: 0.8,
        score_path: '$.score',
        diminishing_returns_delta: 0.02,
      };

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('initial_temperature') && w.includes('less than final_temperature'))).toBe(true);
    });

    it('does not warn when annealing temperature decreases', () => {
      const graph = createValidGraph();
      graph.nodes[0].annealing_config = {
        initial_temperature: 1.0,
        final_temperature: 0.2,
        max_iterations: 5,
        threshold: 0.8,
        score_path: '$.score',
        diminishing_returns_delta: 0.02,
      };

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('initial_temperature'))).toBe(false);
    });
  });

  describe('swarm nodes', () => {
    it('errors when a swarm peer node is absent', () => {
      const graph = createValidGraph();
      graph.nodes[0].swarm_config = { peer_nodes: ['ghost'] };

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Swarm node 'start': peer node 'ghost' not found in graph");
    });

    it('warns when a swarm peer has no return edge', () => {
      const graph = createValidGraph();
      graph.nodes[0].swarm_config = { peer_nodes: ['end'] };

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("Swarm node 'start'") && w.includes("no return edge from peer 'end'"))).toBe(true);
    });

    it('does not warn when a swarm peer has a return edge', () => {
      const graph = createValidGraph();
      graph.nodes[0].swarm_config = { peer_nodes: ['end'] };
      graph.edges.push({ id: 'return', source: 'end', target: 'start', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('no return edge'))).toBe(false);
    });
  });

  describe('tool nodes', () => {
    it('errors when tool_id is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'tool-node', type: 'tool', agent_id: undefined, write_keys: ['tool_result'] }));
      graph.edges.push({ id: 'edge-to-tool', source: 'start', target: 'tool-node', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Tool node 'tool-node' is missing tool_id");
    });

    it('passes when tool_id is present', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'tool-node', type: 'tool', agent_id: undefined, tool_id: 'search', write_keys: ['tool_result'] }));
      graph.edges.push({ id: 'edge-to-tool', source: 'start', target: 'tool-node', condition: { type: 'always' } });
      graph.end_nodes.push('tool-node');

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('tool-node'))).toBe(false);
    });
  });

  describe('subgraph nodes', () => {
    it('errors when subgraph_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'sub', type: 'subgraph', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-sub', source: 'start', target: 'sub', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Subgraph node 'sub' is missing subgraph_config");
    });

    it('errors when subgraph_config.subgraph_id is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'sub', type: 'subgraph', agent_id: undefined, subgraph_config: {} as GraphNode['subgraph_config'] }));
      graph.edges.push({ id: 'edge-to-sub', source: 'start', target: 'sub', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Subgraph node 'sub' is missing subgraph_config.subgraph_id");
    });

    it('passes when subgraph_id is present', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'sub',
        type: 'subgraph',
        agent_id: undefined,
        subgraph_config: { subgraph_id: 'child-graph' } as GraphNode['subgraph_config'],
      }));
      graph.edges.push({ id: 'edge-to-sub', source: 'start', target: 'sub', condition: { type: 'always' } });
      graph.end_nodes.push('sub');

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes("'sub'"))).toBe(false);
    });
  });

  describe('approval nodes', () => {
    it('errors when rejection_node_id references an absent node', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'approval-gate',
        type: 'approval',
        agent_id: undefined,
        approval_config: {
          approval_type: 'human_review',
          prompt_message: 'Please review',
          review_keys: ['*'],
          timeout_ms: 86_400_000,
          rejection_node_id: 'nonexistent-node',
        },
      }));
      graph.edges.push({ id: 'edge-to-approval', source: 'start', target: 'approval-gate', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Approval node 'approval-gate': rejection_node_id 'nonexistent-node' not found in graph");
    });

    it('errors when approval_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'approval-gate', type: 'approval', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-approval', source: 'start', target: 'approval-gate', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Approval node 'approval-gate' is missing approval_config");
    });

    it('passes when rejection_node_id references an existing node', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'approval-gate',
        type: 'approval',
        agent_id: undefined,
        approval_config: {
          approval_type: 'human_review',
          prompt_message: 'Please review',
          review_keys: ['*'],
          timeout_ms: 86_400_000,
          rejection_node_id: 'end',
        },
      }));
      graph.edges.push({ id: 'edge-to-approval', source: 'start', target: 'approval-gate', condition: { type: 'always' } });
      graph.end_nodes.push('approval-gate');

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('approval-gate'))).toBe(false);
    });
  });

  describe('map nodes', () => {
    it('errors when map_reduce_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'mapper', type: 'map', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-map', source: 'start', target: 'mapper', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Map node 'mapper' is missing map_reduce_config");
    });

    it('errors when the worker node is absent', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'mapper',
        type: 'map',
        agent_id: undefined,
        map_reduce_config: { items_key: 'items', worker_node_id: 'ghost-worker', result_key: 'r' } as GraphNode['map_reduce_config'],
      }));
      graph.edges.push({ id: 'edge-to-map', source: 'start', target: 'mapper', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Map node 'mapper': worker node 'ghost-worker' not found in graph");
    });

    it('errors when the synthesizer node is absent', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'worker', agent_id: 'agent-w' }));
      graph.nodes.push(node({
        id: 'mapper',
        type: 'map',
        agent_id: undefined,
        map_reduce_config: {
          items_key: 'items',
          worker_node_id: 'worker',
          synthesizer_node_id: 'ghost-synth',
          result_key: 'r',
        } as GraphNode['map_reduce_config'],
      }));
      graph.edges.push({ id: 'edge-to-map', source: 'start', target: 'mapper', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Map node 'mapper': synthesizer node 'ghost-synth' not found in graph");
    });

    it('does not flag worker or synthesizer as dead ends or unreachable', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'worker', agent_id: 'agent-w' }));
      graph.nodes.push(node({ id: 'synth', agent_id: 'agent-s' }));
      graph.nodes.push(node({
        id: 'mapper',
        type: 'map',
        agent_id: undefined,
        map_reduce_config: {
          items_key: 'items',
          worker_node_id: 'worker',
          synthesizer_node_id: 'synth',
          result_key: 'r',
        } as GraphNode['map_reduce_config'],
      }));
      graph.edges.push({ id: 'edge-to-map', source: 'start', target: 'mapper', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => (w.includes('worker') || w.includes('synth')) && w.includes('dead end'))).toBe(false);
      expect(result.warnings.some(w => (w.includes('worker') || w.includes('synth')) && w.includes('unreachable'))).toBe(false);
    });
  });

  describe('voting nodes', () => {
    it('errors when voter_agent_ids is empty', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'voter',
        type: 'voting',
        agent_id: undefined,
        voting_config: { voter_agent_ids: [], strategy: 'majority', vote_key: 'vote' } as GraphNode['voting_config'],
      }));
      graph.edges.push({ id: 'edge-to-voter', source: 'start', target: 'voter', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Voting node 'voter': voter_agent_ids must not be empty");
    });

    it('errors when llm_judge strategy has no judge_agent_id', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'voter',
        type: 'voting',
        agent_id: undefined,
        voting_config: { voter_agent_ids: ['agent-1', 'agent-2'], strategy: 'llm_judge', vote_key: 'vote' } as GraphNode['voting_config'],
      }));
      graph.edges.push({ id: 'edge-to-voter', source: 'start', target: 'voter', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Voting node 'voter': llm_judge strategy requires judge_agent_id");
    });

    it('errors when voting_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'voter', type: 'voting', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-voter', source: 'start', target: 'voter', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Voting node 'voter' is missing voting_config");
    });
  });

  describe('supervisor nodes', () => {
    it('errors when supervisor_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'super', type: 'supervisor' }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Supervisor node 'super' is missing supervisor_config");
    });

    it('errors when agent_id is set on neither the node nor supervisor_config', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'super',
        type: 'supervisor',
        agent_id: undefined,
        supervisor_config: { managed_nodes: ['end'] } as GraphNode['supervisor_config'],
      }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Supervisor node 'super' is missing agent_id (set on the node or in supervisor_config)");
    });

    it('errors when a managed node is absent', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'super',
        type: 'supervisor',
        agent_id: 'agent-super',
        supervisor_config: { managed_nodes: ['ghost'] } as GraphNode['supervisor_config'],
      }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Supervisor 'super': managed node 'ghost' not found in graph");
    });

    it('warns when there is no edge to a managed node', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'super',
        type: 'supervisor',
        agent_id: 'agent-super',
        supervisor_config: { managed_nodes: ['end'] } as GraphNode['supervisor_config'],
      }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("Supervisor 'super' has no edge to managed node 'end'"))).toBe(true);
    });

    it('warns only for the managed node it has no edge to', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'worker', agent_id: 'agent-w' }));
      graph.nodes.push(node({
        id: 'super',
        type: 'supervisor',
        agent_id: 'agent-super',
        supervisor_config: { managed_nodes: ['end', 'worker'] } as GraphNode['supervisor_config'],
      }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });
      graph.edges.push({ id: 'super-to-end', source: 'super', target: 'end', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("no edge to managed node 'end'"))).toBe(false);
      expect(result.warnings.some(w => w.includes("no edge to managed node 'worker'"))).toBe(true);
    });

    it('warns when a supervisor manages itself', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'super',
        type: 'supervisor',
        agent_id: 'agent-super',
        supervisor_config: { managed_nodes: ['super'] } as GraphNode['supervisor_config'],
      }));
      graph.edges.push({ id: 'edge-to-super', source: 'start', target: 'super', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("Supervisor 'super' manages itself"))).toBe(true);
    });
  });

  describe('evolution nodes', () => {
    function evolutionGraph(evolution_config: Record<string, unknown>): Graph {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'evo',
        type: 'evolution',
        agent_id: undefined,
        evolution_config: evolution_config as GraphNode['evolution_config'],
      }));
      graph.edges.push({ id: 'edge-to-evo', source: 'start', target: 'evo', condition: { type: 'always' } });
      return graph;
    }

    it('errors when evolution_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'evo', type: 'evolution', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-evo', source: 'start', target: 'evo', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Evolution node 'evo' is missing evolution_config");
    });

    it('errors when elite_count is not below population_size', () => {
      const result = validateGraph(evolutionGraph({
        candidate_agent_id: 'agent-c',
        population_size: 3,
        elite_count: 3,
        selection_strategy: 'rank',
        tournament_size: 2,
        initial_temperature: 1.0,
        final_temperature: 0.3,
      }));

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Evolution node 'evo': elite_count must be less than population_size");
    });

    it('errors when tournament_size exceeds population_size', () => {
      const result = validateGraph(evolutionGraph({
        candidate_agent_id: 'agent-c',
        population_size: 4,
        elite_count: 1,
        selection_strategy: 'tournament',
        tournament_size: 10,
        initial_temperature: 1.0,
        final_temperature: 0.3,
      }));

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Evolution node 'evo': tournament_size exceeds population_size");
    });

    it('warns when temperature increases over generations', () => {
      const result = validateGraph(evolutionGraph({
        candidate_agent_id: 'agent-c',
        population_size: 5,
        elite_count: 1,
        selection_strategy: 'rank',
        tournament_size: 2,
        initial_temperature: 0.3,
        final_temperature: 1.0,
      }));

      expect(result.warnings.some(w => w.includes("Evolution node 'evo'") && w.includes('temperature increases'))).toBe(true);
    });
  });

  describe('verifier nodes', () => {
    it('errors when verifier_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'verify', type: 'verifier', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-verify', source: 'start', target: 'verify', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Verifier node 'verify' is missing verifier_config");
    });

    it('errors when an llm_judge target_key is not readable', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'verify',
        type: 'verifier',
        agent_id: undefined,
        read_keys: ['other'],
        verifier_config: { type: 'llm_judge', target_key: 'draft', evaluator_agent_id: 'judge', pass_threshold: 0.8 } as GraphNode['verifier_config'],
      }));
      graph.edges.push({ id: 'edge-to-verify', source: 'start', target: 'verify', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Verifier node 'verify': target_key 'draft' is not in read_keys — the value to verify would not be visible");
    });

    it('passes when the verifier reads its target_key', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'verify',
        type: 'verifier',
        agent_id: undefined,
        read_keys: ['draft'],
        verifier_config: { type: 'llm_judge', target_key: 'draft', evaluator_agent_id: 'judge', pass_threshold: 0.8 } as GraphNode['verifier_config'],
      }));
      graph.edges.push({ id: 'edge-to-verify', source: 'start', target: 'verify', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('target_key'))).toBe(false);
    });

    it('does not require a readable target_key for an expression verifier', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'verify',
        type: 'verifier',
        agent_id: undefined,
        read_keys: [],
        verifier_config: { type: 'expression', expression: 'length(memory.draft) > 0' } as GraphNode['verifier_config'],
      }));
      graph.edges.push({ id: 'edge-to-verify', source: 'start', target: 'verify', condition: { type: 'always' } });
      graph.end_nodes.push('verify');

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('target_key'))).toBe(false);
    });

    it('passes when the verifier reads with a wildcard', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'verify',
        type: 'verifier',
        agent_id: undefined,
        read_keys: ['*'],
        verifier_config: { type: 'jsonpath', target_key: 'draft', path: '$.x', assertion: { op: 'exists' } } as GraphNode['verifier_config'],
      }));
      graph.edges.push({ id: 'edge-to-verify', source: 'start', target: 'verify', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('target_key'))).toBe(false);
    });
  });

  describe('reflection nodes', () => {
    it('errors when reflection_config is missing', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({ id: 'reflect', type: 'reflection', agent_id: undefined }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Reflection node 'reflect' is missing reflection_config");
    });

    it('errors when a source_key is not readable', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['other'],
        reflection_config: {
          source_keys: ['notes'],
          extractor: { type: 'rule_based', min_sentence_length: 25 },
          tags: ['lesson'],
        } as GraphNode['reflection_config'],
      }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Reflection node 'reflect': source_key 'notes' not in read_keys");
    });

    it('errors when an entity_key is not readable', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['notes'],
        reflection_config: {
          source_keys: ['notes'],
          entity_keys: ['entities'],
          extractor: { type: 'rule_based', min_sentence_length: 25 },
          tags: ['lesson'],
        } as GraphNode['reflection_config'],
      }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Reflection node 'reflect': entity_key 'entities' not in read_keys");
    });

    it('warns when no tags are set', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['notes'],
        reflection_config: {
          source_keys: ['notes'],
          extractor: { type: 'rule_based', min_sentence_length: 25 },
          tags: [],
        } as GraphNode['reflection_config'],
      }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("Reflection node 'reflect'") && w.includes('no tags set'))).toBe(true);
    });

    it('passes when all source and entity keys are readable', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['notes', 'entities'],
        reflection_config: {
          source_keys: ['notes'],
          entity_keys: ['entities'],
          extractor: { type: 'rule_based', min_sentence_length: 25 },
          tags: ['lesson'],
        } as GraphNode['reflection_config'],
      }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });
      graph.end_nodes.push('reflect');

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('reflect'))).toBe(false);
    });

    it('does not check source keys when reading with a wildcard', () => {
      const graph = createValidGraph();
      graph.nodes.push(node({
        id: 'reflect',
        type: 'reflection',
        agent_id: undefined,
        read_keys: ['*'],
        reflection_config: {
          source_keys: ['notes'],
          extractor: { type: 'rule_based', min_sentence_length: 25 },
          tags: ['lesson'],
        } as GraphNode['reflection_config'],
      }));
      graph.edges.push({ id: 'edge-to-reflect', source: 'start', target: 'reflect', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('source_key'))).toBe(false);
    });
  });

  describe('cycle detection', () => {
    it('warns on a cycle when there are no end nodes and no supervisor', () => {
      const graph = createValidGraph();
      graph.end_nodes = [];
      graph.edges.push({ id: 'back-edge', source: 'end', target: 'start', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('cycles but has no end nodes'))).toBe(true);
    });

    it('does not warn on a cycle when end nodes exist', () => {
      const graph = createValidGraph();
      graph.edges.push({ id: 'back-edge', source: 'end', target: 'start', condition: { type: 'always' } });

      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes('cycles but has no end nodes'))).toBe(false);
    });
  });
});
