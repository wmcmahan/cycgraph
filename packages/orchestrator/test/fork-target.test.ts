/**
 * Tests for resolveTarget (src/replay/target.ts): turning a change's node id,
 * optionally with a dotted role, into the agents behind it.
 */

import { describe, it, expect } from 'vitest';
import { resolveTarget, TargetError } from '../src/replay/target.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';

const POLICY = { max_retries: 0, backoff_ms: 0, backoff_strategy: 'fixed' as const };

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type'>): GraphNode {
  return { read_keys: [], write_keys: [], failure_policy: POLICY, ...partial } as GraphNode;
}

function graphOf(...nodes: GraphNode[]): Graph {
  return { id: 'g', name: 'g', description: 'g', nodes, edges: [], start_node: nodes[0]?.id ?? '', end_nodes: [] } as Graph;
}

describe('resolveTarget', () => {
  it('resolves a bare node id to its own agent', () => {
    const g = graphOf(node({ id: 'write', type: 'agent', agent_id: 'a1' }));

    expect(resolveTarget(g, 'write')).toEqual({ nodeId: 'write', agentIds: ['a1'] });
  });

  it('falls back to a supervisor config agent for a bare node id', () => {
    const g = graphOf(node({
      id: 'boss',
      type: 'supervisor',
      supervisor_config: { agent_id: 's1', managed_nodes: ['write'], max_iterations: 3 },
    }));

    expect(resolveTarget(g, 'boss').agentIds).toEqual(['s1']);
  });

  it('resolves an evolution candidate role', () => {
    const g = graphOf(node({
      id: 'evolve',
      type: 'evolution',
      evolution_config: { candidate_agent_id: 'c1', evaluator_agent_id: 'e1' } as never,
    }));

    expect(resolveTarget(g, 'evolve.candidate')).toEqual({
      nodeId: 'evolve', role: 'candidate', agentIds: ['c1'],
    });
  });

  it('resolves an evolution evaluator role', () => {
    const g = graphOf(node({
      id: 'evolve',
      type: 'evolution',
      evolution_config: { candidate_agent_id: 'c1', evaluator_agent_id: 'e1' } as never,
    }));

    expect(resolveTarget(g, 'evolve.evaluator').agentIds).toEqual(['e1']);
  });

  it('resolves an annealing evaluator through the same role name', () => {
    const g = graphOf(node({
      id: 'anneal',
      type: 'agent',
      annealing_config: { evaluator_agent_id: 'e2' } as never,
    }));

    expect(resolveTarget(g, 'anneal.evaluator').agentIds).toEqual(['e2']);
  });

  it('resolves a verifier judge through the evaluator role', () => {
    const g = graphOf(node({
      id: 'check',
      type: 'verifier',
      verifier_config: { type: 'llm_judge', evaluator_agent_id: 'j1' } as never,
    }));

    expect(resolveTarget(g, 'check.evaluator').agentIds).toEqual(['j1']);
  });

  it('resolves a voting judge', () => {
    const g = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1', 'v2'], judge_agent_id: 'j2' } as never,
    }));

    expect(resolveTarget(g, 'poll.judge').agentIds).toEqual(['j2']);
  });

  it('resolves every voter at once', () => {
    const g = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1', 'v2', 'v3'] } as never,
    }));

    expect(resolveTarget(g, 'poll.voters').agentIds).toEqual(['v1', 'v2', 'v3']);
  });

  it('resolves one voter by index', () => {
    const g = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1', 'v2', 'v3'] } as never,
    }));

    expect(resolveTarget(g, 'poll.voters[1]')).toEqual({
      nodeId: 'poll', role: 'voters', agentIds: ['v2'],
    });
  });

  it('resolves an llm reflection extractor', () => {
    const g = graphOf(node({
      id: 'reflect',
      type: 'reflection',
      reflection_config: { source_keys: ['x'], extractor: { type: 'llm', agent_id: 'x1' } } as never,
    }));

    expect(resolveTarget(g, 'reflect.extractor').agentIds).toEqual(['x1']);
  });

  it('offers no extractor role for a rule-based reflection node', () => {
    const g = graphOf(node({
      id: 'reflect',
      type: 'reflection',
      reflection_config: { source_keys: ['x'], extractor: { type: 'rule_based' } } as never,
    }));

    expect(() => resolveTarget(g, 'reflect.extractor')).toThrow(/no agent roles/);
  });
});

describe('resolveTarget — refusals', () => {
  it('names the nodes that exist when the node does not', () => {
    const g = graphOf(
      node({ id: 'write', type: 'agent', agent_id: 'a1' }),
      node({ id: 'read', type: 'agent', agent_id: 'a2' }),
    );

    expect(() => resolveTarget(g, 'wrtier')).toThrow(/Nodes: write, read/);
    expect(() => resolveTarget(g, 'wrtier')).toThrow(TargetError);
  });

  it('explains that a node type driving no agent has nothing to change', () => {
    const g = graphOf(node({ id: 'gate', type: 'approval' }));

    expect(() => resolveTarget(g, 'gate')).toThrow(/an 'approval' node, which drives no agent/);
  });

  it('points a node with no default agent at the roles it does have', () => {
    const g = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1'] } as never,
    }));

    expect(() => resolveTarget(g, 'poll')).toThrow(/roles: poll\.voters/);
  });

  it('suggests memory and output changes for an agentless node', () => {
    const g = graphOf(node({ id: 'fetch', type: 'tool', tool_id: 't' }));

    expect(() => resolveTarget(g, 'fetch')).toThrow(/change\.memory/);
    expect(() => resolveTarget(g, 'fetch')).toThrow(/change\.output\('fetch', …\)/);
  });

  it('lists available roles when the named one is wrong', () => {
    const g = graphOf(node({
      id: 'evolve',
      type: 'evolution',
      evolution_config: { candidate_agent_id: 'c1' } as never,
    }));

    expect(() => resolveTarget(g, 'evolve.judge')).toThrow(/Roles on 'evolve': candidate/);
  });

  it('reports how many entries a role has when the index is out of range', () => {
    const g = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1', 'v2'] } as never,
    }));

    expect(() => resolveTarget(g, 'poll.voters[5]')).toThrow(/has 2 entr\(ies\)/);
  });
});
