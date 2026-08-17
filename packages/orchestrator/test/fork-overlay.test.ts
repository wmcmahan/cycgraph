/**
 * Tests for applyOverlays (src/replay/overlay.ts): building the graph and
 * registry a forked tail runs against, without mutating the caller's.
 */

import { describe, it, expect } from 'vitest';
import { applyOverlays, OverlayError } from '../src/replay/overlay.js';
import { change } from '../src/replay/mutations.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';

const POLICY = { max_retries: 0, backoff_ms: 0, backoff_strategy: 'fixed' as const };

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type'>): GraphNode {
  return { read_keys: [], write_keys: [], failure_policy: POLICY, ...partial } as GraphNode;
}

function graphOf(...nodes: GraphNode[]): Graph {
  return { id: 'g', name: 'g', description: 'g', nodes, edges: [], start_node: nodes[0]!.id, end_nodes: [] } as Graph;
}

function registryWith(...names: string[]): { registry: InMemoryAgentRegistry; ids: string[] } {
  const registry = new InMemoryAgentRegistry();
  const ids = names.map(name => registry.register({
    name, model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: name,
  }));
  return { registry, ids };
}

describe('applyOverlays', () => {
  it('returns the caller graph unchanged when there is nothing to apply', async () => {
    const { registry } = registryWith('A');
    const graph = graphOf(node({ id: 'a', type: 'agent', agent_id: 'a1' }));

    const overlays = await applyOverlays(graph, registry, []);

    expect(overlays.graph).toBe(graph);
    expect(overlays.registry).toBe(registry);
  });

  it('points the node at a fork-local clone rather than editing the agent', async () => {
    const { registry, ids } = registryWith('Writer');
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: ids[0] }));

    const overlays = await applyOverlays(graph, registry, [change.model('write', 'claude-opus-5')]);

    expect(overlays.graph.nodes[0].agent_id).toBe('write@fork');
    expect((await overlays.registry.loadAgent('write@fork'))?.model).toBe('claude-opus-5');
    expect((await registry.loadAgent(ids[0]!))?.model).toBe('claude-sonnet-4-6');
  });

  it('leaves other nodes sharing the agent untouched', async () => {
    const { registry, ids } = registryWith('Shared');
    const graph = graphOf(
      node({ id: 'first', type: 'agent', agent_id: ids[0] }),
      node({ id: 'second', type: 'agent', agent_id: ids[0] }),
    );

    const overlays = await applyOverlays(graph, registry, [change.model('first', 'opus')]);

    expect(overlays.graph.nodes[0].agent_id).toBe('first@fork');
    expect(overlays.graph.nodes[1].agent_id).toBe(ids[0]);
  });

  it('accumulates two changes on one target onto a single clone', async () => {
    const { registry, ids } = registryWith('Writer');
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: ids[0] }));

    const overlays = await applyOverlays(graph, registry, [
      change.model('write', 'opus'),
      change.prompt('write', 'be terse'),
    ]);

    const clone = await overlays.registry.loadAgent('write@fork');
    expect(clone?.model).toBe('opus');
    expect(clone?.system_prompt).toBe('be terse');
  });

  it('applies a temperature change to the clone', async () => {
    const { registry, ids } = registryWith('Writer');
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: ids[0] }));

    const overlays = await applyOverlays(graph, registry, [change.temperature('write', 0)]);

    expect((await overlays.registry.loadAgent('write@fork'))?.temperature).toBe(0);
  });

  it('carries a provider swap onto the clone', async () => {
    const { registry, ids } = registryWith('Writer');
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: ids[0] }));

    const overlays = await applyOverlays(graph, registry, [
      change.model('write', 'gpt-5', { provider: 'openai' }),
    ]);

    expect((await overlays.registry.loadAgent('write@fork'))?.provider).toBe('openai');
  });

  it('delegates unknown agents to the base registry', async () => {
    const { registry, ids } = registryWith('Writer', 'Other');
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: ids[0] }));

    const overlays = await applyOverlays(graph, registry, [change.model('write', 'opus')]);

    expect((await overlays.registry.loadAgent(ids[1]!))?.name).toBe('Other');
  });
});

describe('applyOverlays — roles', () => {
  it('repoints a supervisor config agent', async () => {
    const { registry, ids } = registryWith('Boss');
    const graph = graphOf(node({
      id: 'boss',
      type: 'supervisor',
      supervisor_config: { agent_id: ids[0], managed_nodes: [], max_iterations: 3 } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('boss', 'opus')]);

    expect(overlays.graph.nodes[0].supervisor_config?.agent_id).toBe('boss@fork');
  });

  it('repoints an evolution candidate', async () => {
    const { registry, ids } = registryWith('Cand', 'Eval');
    const graph = graphOf(node({
      id: 'evolve',
      type: 'evolution',
      evolution_config: { candidate_agent_id: ids[0], evaluator_agent_id: ids[1] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('evolve.candidate', 'opus')]);

    expect(overlays.graph.nodes[0].evolution_config?.candidate_agent_id).toBe('evolve.candidate@fork');
    expect(overlays.graph.nodes[0].evolution_config?.evaluator_agent_id).toBe(ids[1]);
  });

  it('repoints an evolution evaluator', async () => {
    const { registry, ids } = registryWith('Cand', 'Eval');
    const graph = graphOf(node({
      id: 'evolve',
      type: 'evolution',
      evolution_config: { candidate_agent_id: ids[0], evaluator_agent_id: ids[1] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('evolve.evaluator', 'opus')]);

    expect(overlays.graph.nodes[0].evolution_config?.evaluator_agent_id).toBe('evolve.evaluator@fork');
  });

  it('repoints an annealing evaluator, which shares the evaluator role name', async () => {
    const { registry, ids } = registryWith('Eval');
    const graph = graphOf(node({
      id: 'anneal',
      type: 'agent',
      annealing_config: { evaluator_agent_id: ids[0] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('anneal.evaluator', 'opus')]);

    expect(overlays.graph.nodes[0].annealing_config?.evaluator_agent_id)
      .toBe('anneal.evaluator@fork');
  });

  it('repoints a verifier judge', async () => {
    const { registry, ids } = registryWith('Judge');
    const graph = graphOf(node({
      id: 'check',
      type: 'verifier',
      verifier_config: { type: 'llm_judge', evaluator_agent_id: ids[0] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('check.evaluator', 'opus')]);

    expect((overlays.graph.nodes[0].verifier_config as { evaluator_agent_id: string }).evaluator_agent_id)
      .toBe('check.evaluator@fork');
  });

  it('repoints a voting judge', async () => {
    const { registry, ids } = registryWith('Judge');
    const graph = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: ['v1'], judge_agent_id: ids[0] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('poll.judge', 'opus')]);

    expect(overlays.graph.nodes[0].voting_config?.judge_agent_id).toBe('poll.judge@fork');
  });

  it('repoints one voter and leaves the rest alone', async () => {
    const { registry, ids } = registryWith('V1', 'V2');
    const graph = graphOf(node({
      id: 'poll',
      type: 'voting',
      voting_config: { voter_agent_ids: [ids[0], ids[1]] } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('poll.voters[0]', 'opus')]);

    expect(overlays.graph.nodes[0].voting_config?.voter_agent_ids).toEqual([
      'poll.voters@fork', ids[1],
    ]);
  });

  it('repoints an llm reflection extractor', async () => {
    const { registry, ids } = registryWith('Extract');
    const graph = graphOf(node({
      id: 'reflect',
      type: 'reflection',
      reflection_config: {
        source_keys: ['x'],
        extractor: { type: 'llm', agent_id: ids[0] },
      } as never,
    }));

    const overlays = await applyOverlays(graph, registry, [change.model('reflect.extractor', 'opus')]);

    const extractor = overlays.graph.nodes[0].reflection_config?.extractor as { agent_id: string };
    expect(extractor.agent_id).toBe('reflect.extractor@fork');
  });
});

describe('applyOverlays — config and write grants', () => {
  it('patches a node config', async () => {
    const { registry, ids } = registryWith('Boss');
    const graph = graphOf(node({ id: 'boss', type: 'agent', agent_id: ids[0], read_keys: ['a'] }));

    const overlays = await applyOverlays(graph, registry, [change.config('boss', { read_keys: ['b'] })]);

    expect(overlays.graph.nodes[0].read_keys).toEqual(['b']);
    expect(graph.nodes[0].read_keys).toEqual(['a']);
  });

  it('refuses a patch that breaks the node schema', async () => {
    const { registry, ids } = registryWith('Boss');
    const graph = graphOf(node({ id: 'boss', type: 'agent', agent_id: ids[0] }));

    await expect(applyOverlays(graph, registry, [change.config('boss', { read_keys: 'oops' })]))
      .rejects.toThrow(/fails validation — read_keys/);
  });

  it('refuses a patch that breaks the graph, naming the validator error', async () => {
    const { registry, ids } = registryWith('Boss');
    const graph = graphOf(node({ id: 'boss', type: 'agent', agent_id: ids[0] }));

    // Structurally a valid node, but stripping the agent breaks the graph.
    await expect(applyOverlays(graph, registry, [change.config('boss', { agent_id: undefined })]))
      .rejects.toThrow(/patched graph fails validation.*missing agent_id/);
  });

  it('grants the keys a substituted output claims', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent', write_keys: ['draft'] }));

    const overlays = await applyOverlays(graph, registry, [change.output('write', { score: 1 })]);

    expect(overlays.graph.nodes[0].write_keys.sort()).toEqual(['draft', 'score']);
  });

  it('grants a substituted tool its result key', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'fetch', type: 'tool', tool_id: 't' }));

    const overlays = await applyOverlays(graph, registry, [change.tool('fetch', 'r')]);

    expect(overlays.graph.nodes[0].write_keys).toEqual(['fetch_result']);
  });

  it('leaves a wildcard grant alone', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent', write_keys: ['*'] }));

    const overlays = await applyOverlays(graph, registry, [change.output('write', { score: 1 })]);

    expect(overlays.graph.nodes[0].write_keys).toEqual(['*']);
  });

  it('grants nothing for an output substitution that names no keys', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent', write_keys: ['draft'] }));

    const overlays = await applyOverlays(graph, registry, [change.output('write', {})]);

    expect(overlays.graph.nodes[0].write_keys).toEqual(['draft']);
  });

  it('refuses a config patch naming an absent node', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent' }));

    await expect(applyOverlays(graph, registry, [change.config('nope', {})]))
      .rejects.toThrow(OverlayError);
  });

  it('refuses a substituted output naming an absent node', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent' }));

    await expect(applyOverlays(graph, registry, [change.output('nope', { a: 1 })]))
      .rejects.toThrow(/no node 'nope'/);
  });

  it('refuses an agent change whose agent is not in the registry', async () => {
    const { registry } = registryWith();
    const graph = graphOf(node({ id: 'write', type: 'agent', agent_id: 'ghost' }));

    await expect(applyOverlays(graph, registry, [change.model('write', 'opus')]))
      .rejects.toThrow(/agent 'ghost' behind 'write' is not in the registry/);
  });
});
