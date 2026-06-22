/**
 * camelCase authoring layer for graph construction.
 *
 * Consumers author nodes in idiomatic camelCase; `createGraph` remaps to the
 * snake_case wire format before validation. Snake_case input must keep working
 * (back-compat for the architect, examples, and existing callers), and
 * freeform record values must survive the remap verbatim.
 */
import { describe, it, expect } from 'vitest';
import {
  createGraph,
  GraphSchema,
  type NodeConfig,
  type GraphConfig,
  type GraphInput,
} from '../src/types/graph.js';

describe('createGraph camelCase authoring', () => {
  it('maps top-level node fields camelCase → snake_case', () => {
    const graph = createGraph({
      name: 'Camel Graph',
      description: 'authored in camelCase',
      startNode: 'researcher',
      endNodes: ['researcher'],
      nodes: [
        {
          id: 'researcher',
          type: 'agent',
          agentId: 'agent-1',
          readKeys: ['goal', 'notes'],
          writeKeys: ['draft'],
          defaultWriteKey: 'draft',
        },
      ],
      edges: [],
    });

    const node = graph.nodes[0];
    expect(node.agent_id).toBe('agent-1');
    expect(node.read_keys).toEqual(['goal', 'notes']);
    expect(node.write_keys).toEqual(['draft']);
    expect(node.default_write_key).toBe('draft');
    // Wire format carries no camelCase keys.
    expect(node).not.toHaveProperty('agentId');
    expect(node).not.toHaveProperty('readKeys');
  });

  it('maps nested config blocks (supervisorConfig)', () => {
    const graph = createGraph({
      name: 'Supervised',
      description: '',
      startNode: 'sup',
      endNodes: ['sup'],
      nodes: [
        {
          id: 'sup',
          type: 'supervisor',
          agentId: 'sup-agent',
          supervisorConfig: {
            managedNodes: ['a', 'b'],
            maxIterations: 7,
            completionCondition: '$.done',
          },
        },
      ],
      edges: [],
    });

    const cfg = graph.nodes[0].supervisor_config!;
    expect(cfg.managed_nodes).toEqual(['a', 'b']);
    expect(cfg.max_iterations).toBe(7);
    expect(cfg.completion_condition).toBe('$.done');
  });

  it('maps deeply nested failurePolicy + circuitBreaker', () => {
    const graph = createGraph({
      name: 'Resilient',
      description: '',
      startNode: 'n',
      endNodes: ['n'],
      nodes: [
        {
          id: 'n',
          type: 'agent',
          agentId: 'a',
          failurePolicy: {
            maxRetries: 5,
            backoffStrategy: 'linear',
            initialBackoffMs: 250,
            maxBackoffMs: 9000,
            circuitBreaker: {
              enabled: true,
              failureThreshold: 4,
              successThreshold: 3,
              timeoutMs: 1000,
            },
          },
        },
      ],
      edges: [],
    });

    const fp = graph.nodes[0].failure_policy;
    expect(fp.max_retries).toBe(5);
    expect(fp.backoff_strategy).toBe('linear');
    expect(fp.initial_backoff_ms).toBe(250);
    expect(fp.max_backoff_ms).toBe(9000);
    expect(fp.circuit_breaker).toEqual({
      enabled: true,
      failure_threshold: 4,
      success_threshold: 3,
      timeout_ms: 1000,
    });
  });

  it('validates snake_case wire input via GraphSchema.parse', () => {
    const wire: GraphInput = {
      name: 'Snake Graph',
      description: 'wire format',
      start_node: 'r',
      end_nodes: ['r'],
      nodes: [
        {
          id: 'r',
          type: 'agent',
          agent_id: 'agent-1',
          read_keys: ['goal'],
          write_keys: ['draft'],
        },
      ],
      edges: [],
    };
    const graph = GraphSchema.parse(wire);

    expect(graph.nodes[0].agent_id).toBe('agent-1');
    expect(graph.nodes[0].read_keys).toEqual(['goal']);
  });

  it('createGraph still tolerates snake_case at runtime (idempotent remap)', () => {
    // The authoring type is camelCase-only, but the runtime remap is a no-op on
    // snake keys, so external/untyped snake callers keep working.
    const graph = createGraph({
      name: 'Snake via createGraph',
      description: '',
      start_node: 'r',
      end_nodes: ['r'],
      nodes: [{ id: 'r', type: 'agent', agent_id: 'agent-1', read_keys: ['goal'] }],
      edges: [],
    } as unknown as GraphConfig);

    expect(graph.nodes[0].agent_id).toBe('agent-1');
  });

  it('preserves freeform record values verbatim (metadata, weights, mappings)', () => {
    const graph = createGraph({
      name: 'Freeform',
      description: '',
      startNode: 'vote',
      endNodes: ['vote'],
      nodes: [
        {
          id: 'vote',
          type: 'voting',
          votingConfig: {
            voterAgentIds: ['v1', 'v2'],
            strategy: 'weighted_vote',
            // Arbitrary user keys — must NOT be snake-cased.
            weights: { agentOne: 0.7, agentTwo: 0.3 },
          },
          // Arbitrary user metadata — keys must be preserved.
          metadata: { camelKey: 'value', nested: { anotherCamelKey: 1 } },
        },
        {
          id: 'sub',
          type: 'subgraph',
          subgraphConfig: {
            subgraphId: 'child',
            // Memory-key maps — both keys and values are user-controlled.
            inputMapping: { parentKey: 'childKey' },
            outputMapping: { childResult: 'parentResult' },
          },
        },
      ],
      edges: [],
    });

    const voting = graph.nodes[0].voting_config!;
    expect(voting.weights).toEqual({ agentOne: 0.7, agentTwo: 0.3 });
    expect(graph.nodes[0].metadata).toEqual({
      camelKey: 'value',
      nested: { anotherCamelKey: 1 },
    });

    const sub = graph.nodes[1].subgraph_config!;
    expect(sub.input_mapping).toEqual({ parentKey: 'childKey' });
    expect(sub.output_mapping).toEqual({ childResult: 'parentResult' });
  });

  it('preserves map static_items objects verbatim', () => {
    const graph = createGraph({
      name: 'Map',
      description: '',
      startNode: 'm',
      endNodes: ['m'],
      nodes: [
        {
          id: 'm',
          type: 'map',
          mapReduceConfig: {
            workerNodeId: 'worker',
            staticItems: [{ camelField: 1 }, { camelField: 2 }],
            maxConcurrency: 3,
          },
        },
      ],
      edges: [],
    });

    const mr = graph.nodes[0].map_reduce_config!;
    expect(mr.worker_node_id).toBe('worker');
    expect(mr.max_concurrency).toBe(3);
    // Item object keys are user data — untouched.
    expect(mr.static_items).toEqual([{ camelField: 1 }, { camelField: 2 }]);
  });

  it('preserves verifier discriminant values and remaps its fields', () => {
    const graph = createGraph({
      name: 'Verify',
      description: '',
      startNode: 'v',
      endNodes: ['v'],
      nodes: [
        {
          id: 'v',
          type: 'verifier',
          writeKeys: ['v_verification', 'v_verification_passed'],
          verifierConfig: {
            type: 'llm_judge',
            targetKey: 'draft',
            evaluatorAgentId: 'judge',
            passThreshold: 0.9,
          },
        },
      ],
      edges: [],
    });

    const vc = graph.nodes[0].verifier_config!;
    expect(vc.type).toBe('llm_judge'); // discriminant value preserved
    if (vc.type === 'llm_judge') {
      expect(vc.target_key).toBe('draft');
      expect(vc.evaluator_agent_id).toBe('judge');
      expect(vc.pass_threshold).toBe(0.9);
    }
  });

  it('exposes camelCase authoring types', () => {
    // Compile-time assertion: the camelCase types are usable for authoring.
    const node: NodeConfig = {
      id: 'n',
      type: 'agent',
      agentId: 'a',
      readKeys: ['goal'],
    };
    const config: GraphConfig = {
      name: 'g',
      description: '',
      startNode: 'n',
      endNodes: ['n'],
      nodes: [node],
      edges: [],
    };
    expect(createGraph(config).nodes[0].agent_id).toBe('a');
  });
});
