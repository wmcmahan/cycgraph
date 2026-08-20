/**
 * Tests for applyChanges (src/replay/apply.ts), the permanent counterpart of
 * the fork overlay.
 */

import { describe, it, expect } from 'vitest';
import { applyChanges, ApplyError } from '../src/replay/apply.js';
import { change } from '../src/replay/mutations.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { createGraph } from '../src/graph/graph.js';
import type { Graph } from '../src/graph/graph.js';

function registryWith(name: string): { registry: InMemoryAgentRegistry; id: string } {
  const registry = new InMemoryAgentRegistry();
  const id = registry.register({
    name, model: 'claude-sonnet-4-6', provider: 'anthropic', systemPrompt: `You are ${name}.`,
    temperature: 0.7,
  });
  return { registry, id };
}

function supervisedGraph(agentId: string, workerId: string, maxIterations = 6): Graph {
  return createGraph({
    name: 'wf',
    description: 'a supervisor and a worker',
    nodes: [
      {
        id: 'boss',
        type: 'supervisor',
        agent_id: agentId,
        supervisor_config: { managed_nodes: ['worker'], max_iterations: maxIterations },
      },
      { id: 'worker', type: 'agent', agent_id: workerId },
    ],
    startNode: 'boss',
    endNodes: [],
    edges: [
      { source: 'boss', target: 'worker', description: 'delegate' },
      { source: 'worker', target: 'boss', description: 'report' },
    ],
  });
}

describe('applyChanges', () => {
  it('patches a node config through schema validation', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id, 6);

    const applied = await applyChanges(graph, registry, [
      change.config('boss', { supervisor_config: { managed_nodes: ['worker'], max_iterations: 3 } }),
    ]);

    expect(applied.graph.nodes.find(n => n.id === 'boss')!.supervisor_config!.max_iterations).toBe(3);
  });

  it('patches an agent in place under its own id', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    const applied = await applyChanges(graph, registry, [change.temperature('boss', 0.35)]);

    expect(applied.agents).toHaveLength(1);
    expect(applied.agents[0]).toMatchObject({ id, temperature: 0.35 });
  });

  it('never repoints a node at a clone', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    const applied = await applyChanges(graph, registry, [change.prompt('boss', 'be terse')]);

    expect(applied.graph.nodes.find(n => n.id === 'boss')!.agent_id).toBe(id);
    expect(applied.agents[0]!.system_prompt).toBe('be terse');
  });

  it('accumulates repeated changes onto one entry', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    const applied = await applyChanges(graph, registry, [
      change.prompt('boss', 'be terse'),
      change.temperature('boss', 0.35),
    ]);

    expect(applied.agents).toHaveLength(1);
    expect(applied.agents[0]).toMatchObject({ system_prompt: 'be terse', temperature: 0.35 });
  });

  it('leaves the graph untouched by agent-only changes', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    const applied = await applyChanges(graph, registry, [change.temperature('boss', 0.35)]);

    expect(applied.graph).toBe(graph);
  });

  it('applies a swept combination in one call', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id, 6);

    const applied = await applyChanges(graph, registry, [
      change.config('boss', { supervisor_config: { managed_nodes: ['worker'], max_iterations: 3 } }),
      change.temperature('boss', 0.35),
    ]);

    expect(applied.graph.nodes.find(n => n.id === 'boss')!.supervisor_config!.max_iterations).toBe(3);
    expect(applied.agents[0]!.temperature).toBe(0.35);
  });

  it('rejects a run-scoped change by kind', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, registry, [change.memory({ set: { a: 1 } })]))
      .rejects.toThrow(/describe one run of it/);
  });

  it('names every run-scoped change it rejects', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, registry, [
      change.output('worker', { worker_out: 'x' }),
      change.humanResponse('approved'),
    ])).rejects.toThrow(ApplyError);
  });

  it('rejects changes that claim the same thing', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, registry, [
      change.temperature('boss', 0.35),
      change.temperature('boss', 0),
    ])).rejects.toThrow(/claim the same thing/);
  });

  it('rejects a config patch that breaks the node schema', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, registry, [
      change.config('boss', { supervisor_config: { managed_nodes: ['worker'], max_iterations: 0 } }),
    ])).rejects.toThrow(/fails validation/);
  });

  it('rejects a change naming a node the graph lacks', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, registry, [change.config('ghost', { agent_id: id })]))
      .rejects.toThrow(/no node 'ghost'/);
  });

  it('rejects a change whose agent is not in the registry', async () => {
    const { id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    await expect(applyChanges(graph, new InMemoryAgentRegistry(), [change.temperature('boss', 0)]))
      .rejects.toThrow(/is not in the registry/);
  });

  it('returns nothing to persist for an empty change set', async () => {
    const { registry, id } = registryWith('Boss');
    const graph = supervisedGraph(id, id);

    const applied = await applyChanges(graph, registry, []);

    expect(applied.graph).toBe(graph);
    expect(applied.agents).toEqual([]);
  });
});
