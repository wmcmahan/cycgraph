import { describe, test, expect } from 'vitest';
import { validateGraph } from '../src/validation/graph-validator.js';
import type { Graph } from '../src/index.js';

describe('Graph Validation', () => {
  const createValidGraph = (): Graph => ({
    id: 'test-graph',
    name: 'Test Graph',
    description: 'A valid test graph',
    start_node: 'start',
    end_nodes: ['end'],
    nodes: [
      {
        id: 'start',
        type: 'agent',
        agent_id: 'agent-1',
        read_keys: ['*'],
        write_keys: ['result'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 10000,
        },
      },
      {
        id: 'end',
        type: 'agent',
        agent_id: 'agent-2',
        read_keys: ['result'],
        write_keys: ['final'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 10000,
        },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'start',
        target: 'end',
        condition: { type: 'always' },
      },
    ],
  });

  describe('valid graphs', () => {
    test('should pass validation for a valid graph', () => {
      const graph = createValidGraph();
      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('least-privilege read_keys warning', () => {
    test('warns when a node uses wildcard read_keys', () => {
      const graph = createValidGraph(); // start node uses read_keys: ['*']
      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // wildcard is allowed, just discouraged
      expect(result.warnings.some(w => w.includes("'start'") && w.includes("read_keys includes '*'"))).toBe(true);
    });

    test('no warning when all nodes use explicit read_keys', () => {
      const graph = createValidGraph();
      graph.nodes[0].read_keys = ['goal'];
      const result = validateGraph(graph);

      expect(result.warnings.some(w => w.includes("read_keys includes '*'"))).toBe(false);
    });

    test('warns when a node uses wildcard write_keys (symmetric to read side)', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['*'];
      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // allowed, just discouraged
      expect(result.warnings.some(w => w.includes("'start'") && w.includes("write_keys includes '*'"))).toBe(true);
    });
  });

  describe('start node validation', () => {
    test('should fail if start node does not exist', () => {
      const graph = createValidGraph();
      graph.start_node = 'nonexistent';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Start node \'nonexistent\' not found in graph nodes');
    });
  });

  describe('end node validation', () => {
    test('should fail if end node does not exist', () => {
      const graph = createValidGraph();
      graph.end_nodes = ['missing'];

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('End node \'missing\' not found in graph nodes');
    });
  });

  describe('edge validation', () => {
    test('should fail if edge source does not exist', () => {
      const graph = createValidGraph();
      graph.edges[0].source = 'missing';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('source node \'missing\' not found'))).toBe(true);
    });

    test('should fail if edge target does not exist', () => {
      const graph = createValidGraph();
      graph.edges[0].target = 'missing';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('target node \'missing\' not found'))).toBe(true);
    });
  });

  describe('duplicate ID validation', () => {
    test('should fail if duplicate node IDs exist', () => {
      const graph = createValidGraph();
      graph.nodes.push({ ...graph.nodes[0] }); // Duplicate start node

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate node ID: \'start\'');
    });

    test('should fail if duplicate edge IDs exist', () => {
      const graph = createValidGraph();
      graph.edges.push({ ...graph.edges[0] }); // Duplicate edge

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate edge ID: \'edge-1\'');
    });
  });

  describe('reachability validation', () => {
    test('should warn if node is unreachable', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'unreachable',
        type: 'agent',
        agent_id: 'agent-3',
        read_keys: ['*'],
        write_keys: ['data'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 10000,
        },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // Not an error, just a warning
      expect(result.warnings).toContain('Node \'unreachable\' is unreachable from start node');
    });
  });

  describe('dead end validation', () => {
    test('should warn if non-end node has no outgoing edges', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'middle',
        type: 'agent',
        agent_id: 'agent-3',
        read_keys: ['*'],
        write_keys: ['data'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 10000,
        },
      });
      graph.edges.push({
        id: 'edge-2',
        source: 'start',
        target: 'middle',
        condition: { type: 'always' },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // Not an error, just a warning
      expect(result.warnings.some(w => w.includes('middle') && w.includes('no outgoing edges'))).toBe(true);
    });
  });

  describe('complex graphs', () => {
    test('should validate graph with multiple paths', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'router',
        type: 'router',
        read_keys: ['result'],
        write_keys: [],
        requires_compensation: false,
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'fixed',
          initial_backoff_ms: 0,
          max_backoff_ms: 0,
        },
      });
      graph.edges = [
        {
          id: 'edge-1',
          source: 'start',
          target: 'router',
          condition: { type: 'always' },
        },
        {
          id: 'edge-2',
          source: 'router',
          target: 'end',
          condition: { type: 'conditional', condition: '$.memory.approved == true' },
        },
        {
          id: 'edge-3',
          source: 'router',
          target: 'end',
          condition: { type: 'conditional', condition: '$.memory.approved == false' },
        },
      ];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('type-specific node validation', () => {
    test('should fail if agent node is missing agent_id', () => {
      const graph = createValidGraph();
      // Remove agent_id from start node
      delete (graph.nodes[0] as any).agent_id;

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Agent node 'start' is missing agent_id");
    });

    test('should fail if tool node is missing tool_id', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'tool-node',
        type: 'tool',
        read_keys: ['*'],
        write_keys: ['tool_result'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'fixed',
          initial_backoff_ms: 0,
          max_backoff_ms: 0,
        },
      });
      graph.edges.push({
        id: 'edge-to-tool',
        source: 'start',
        target: 'tool-node',
        condition: { type: 'always' },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Tool node 'tool-node' is missing tool_id");
    });

    test('should fail if voting node uses llm_judge without judge_agent_id', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'voter',
        type: 'voting',
        voting_config: {
          voter_agent_ids: ['agent-1', 'agent-2'],
          strategy: 'llm_judge',
          vote_key: 'vote',
        },
        read_keys: ['*'],
        write_keys: ['vote_result'],
        requires_compensation: false,
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'fixed',
          initial_backoff_ms: 0,
          max_backoff_ms: 0,
        },
      });
      graph.edges.push({
        id: 'edge-to-voter',
        source: 'start',
        target: 'voter',
        condition: { type: 'always' },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Voting node 'voter': llm_judge strategy requires judge_agent_id");
    });

    test('should fail if approval rejection_node_id references missing node', () => {
      const graph = createValidGraph();
      graph.nodes.push({
        id: 'approval-gate',
        type: 'approval',
        approval_config: {
          approval_type: 'human_review',
          prompt_message: 'Please review',
          review_keys: ['*'],
          timeout_ms: 86_400_000,
          rejection_node_id: 'nonexistent-node',
        },
        read_keys: ['*'],
        write_keys: [],
        requires_compensation: false,
        failure_policy: {
          max_retries: 1,
          backoff_strategy: 'fixed',
          initial_backoff_ms: 0,
          max_backoff_ms: 0,
        },
      });
      graph.edges.push({
        id: 'edge-to-approval',
        source: 'start',
        target: 'approval-gate',
        condition: { type: 'always' },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Approval node 'approval-gate': rejection_node_id 'nonexistent-node' not found in graph"
      );
    });
  });

  describe('edge hardening', () => {
    test('should warn on self-referencing edge', () => {
      const graph = createValidGraph();
      graph.edges.push({
        id: 'self-edge',
        source: 'start',
        target: 'start',
        condition: { type: 'always' },
      });

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.some(w => w.includes('self-referencing') && w.includes('start'))).toBe(true);
    });

    test('should warn on conditional edge with empty condition', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional' }; // no condition string

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.some(w => w.includes('conditional') && w.includes('missing a condition'))).toBe(true);
    });
  });

  describe('agent_id empty string validation', () => {
    test('should error if agent node has empty string agent_id', () => {
      const graph = createValidGraph();
      (graph.nodes[0] as any).agent_id = '';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Agent node 'start' is missing agent_id");
    });
  });

  describe('condition expression syntax validation', () => {
    test('should reject syntactically invalid condition expression as an error', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: '(((' };

      const result = validateGraph(graph);

      // Promoted from warning -> error: a broken filtrex expression would
      // silently evaluate to `false` at runtime and misroute execution. The
      // graph must fail to load so the author sees the syntax error.
      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.includes('edge-1') && e.includes('syntax error')
      )).toBe(true);
    });

    test('should accept a valid condition expression with no errors or warnings about syntax', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional', condition: 'memory.approved == 1' };

      const result = validateGraph(graph);

      expect(result.errors.some(e =>
        e.includes('edge-1') && e.includes('syntax error')
      )).toBe(false);
      expect(result.warnings.some(w =>
        w.includes('edge-1') && w.includes('syntax error')
      )).toBe(false);
    });

    test('should accept expressions that use runtime extra functions', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = {
        type: 'conditional',
        condition: 'length(memory.items) > 0 and lower(memory.status) == "ready"',
      };

      const result = validateGraph(graph);

      // The validator must share the runtime's extraFunctions config so that
      // expressions using length/lower/etc compile successfully here.
      expect(result.errors.some(e => e.includes('edge-1'))).toBe(false);
    });

    test('should accept single-quoted string literals via shared normalization', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = {
        type: 'conditional',
        condition: "memory.status == 'ready'",
      };

      const result = validateGraph(graph);

      expect(result.errors.some(e =>
        e.includes('edge-1') && e.includes('syntax error')
      )).toBe(false);
    });

    test('should still warn on conditional type with undefined condition', () => {
      const graph = createValidGraph();
      graph.edges[0].condition = { type: 'conditional' }; // no condition string

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.some(w =>
        w.includes('conditional') && w.includes('missing a condition')
      )).toBe(true);
    });
  });

  describe('structural warnings', () => {
    test('should warn if graph has no end nodes', () => {
      const graph = createValidGraph();
      graph.end_nodes = [];

      const result = validateGraph(graph);

      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.some(w => w.includes('no end nodes'))).toBe(true);
    });

    test('should warn if annealing initial_temperature < final_temperature', () => {
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

      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.some(w =>
        w.includes('initial_temperature') && w.includes('less than final_temperature')
      )).toBe(true);
    });
  });

  describe('default_write_key validation', () => {
    test('should error if default_write_key is not in write_keys', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['research_notes', 'summary'];
      graph.nodes[0].default_write_key = 'invalid_key';

      const result = validateGraph(graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e =>
        e.includes('default_write_key') && e.includes('invalid_key')
      )).toBe(true);
    });

    test('should pass if default_write_key is in write_keys', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['research_notes', 'summary'];
      graph.nodes[0].default_write_key = 'research_notes';

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('default_write_key'))).toBe(false);
    });

    test('should pass if write_keys includes wildcard', () => {
      const graph = createValidGraph();
      graph.nodes[0].write_keys = ['*'];
      graph.nodes[0].default_write_key = 'anything';

      const result = validateGraph(graph);

      expect(result.errors.some(e => e.includes('default_write_key'))).toBe(false);
    });
  });
});
