/**
 * Tests for the authoring facade (src/authoring/): the agent/node split
 * (agent = capability, node = placement), automatic agent ids, by-value
 * node references, deep agent-reference resolution in config blocks, edge
 * sugar, start/end inference, and the proof that a facade-authored graph
 * compiles to the same wire as the hand-authored raw API.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  agent,
  node,
  graph,
  tool,
  agentsForGraph,
  toolsForGraph,
  isAgentValue,
  isNodeValue,
  inferProvider,
  AgentSpecError,
  GraphSpecError,
  createGraph,
} from '../src/index.js';
import type { Graph } from '../src/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function researcherAgent() {
  return agent({ model: 'claude-sonnet-4-6', instructions: 'Research specialist.' });
}

function linearGraph() {
  const researcher = researcherAgent();
  const writer = agent({ model: 'claude-sonnet-4-6', instructions: 'Writer.' });
  const research = node({ id: 'research', agent: researcher, reads: ['goal'], writes: 'notes' });
  const write = node({ id: 'write', agent: writer, reads: ['goal', 'notes'], writes: 'draft' });
  return { researcher, writer, research, write };
}

describe('agent', () => {
  it('brands the returned value as a capability', () => {
    expect(isAgentValue(researcherAgent())).toBe(true);
    expect(isAgentValue({ model: 'x' })).toBe(false);
  });

  it('requires no id — the registry mints one at compile time', () => {
    const value = researcherAgent();

    expect(value.spec.id).toBeUndefined();
    expect(value.resolvedId).toBeUndefined();
  });

  it('infers the anthropic provider from a claude model', () => {
    expect(researcherAgent().spec.provider).toBe('anthropic');
  });

  it('honors an explicit provider override', () => {
    const a = agent({ model: 'llama3', instructions: 'x', provider: 'ollama' });

    expect(a.spec.provider).toBe('ollama');
  });

  it('throws when the provider cannot be inferred and none is given', () => {
    expect(() => agent({ model: 'llama3', instructions: 'x' })).toThrow(AgentSpecError);
  });
});

describe('inferProvider', () => {
  it.each([
    ['claude-sonnet-4-6', 'anthropic'],
    ['gpt-4o', 'openai'],
    ['o1-preview', 'openai'],
    ['gpt-oss-120b', null],
    ['text-davinci-003', null],
    ['mistral-large', null],
  ])('maps %s to %s', (model, expected) => {
    expect(inferProvider(model)).toBe(expected);
  });
});

describe('node', () => {
  it('exposes the spec properties on the value', () => {
    const { research } = linearGraph();

    expect(isNodeValue(research)).toBe(true);
    expect(research.id).toBe('research');
    expect(research.reads).toEqual(['goal']);
  });

  it('is inert — nothing registered or resolved at creation', () => {
    const researcher = researcherAgent();
    node({ id: 'research', agent: researcher });

    expect(researcher.resolvedId).toBeUndefined();
  });
});

describe('graph', () => {
  it('compiles node values to agent nodes with derived grants and a minted agent id', () => {
    const { research, write } = linearGraph();

    const g = graph({
      name: 'rw',
      nodes: [research, write],
      edges: [{ from: research, to: write }],
    });

    const compiled = g.nodes.find((n) => n.id === 'research')!;
    expect(compiled.type).toBe('agent');
    expect(compiled.agent_id).toMatch(UUID_RE);
    expect(compiled.read_keys).toEqual(['goal']);
    expect(compiled.write_keys).toEqual(['notes']);
  });

  it('registers one agent used at two nodes once, with one id', () => {
    const researcher = researcherAgent();
    const a = node({ id: 'first', agent: researcher, reads: ['goal'], writes: 'x' });
    const b = node({ id: 'second', agent: researcher, reads: ['x'], writes: 'y' });

    const g = graph({ name: 'reuse', nodes: [a, b], edges: [{ from: a, to: b }] });

    const agents = agentsForGraph(g);
    expect(agents).toHaveLength(1);
    expect(g.nodes[0].agent_id).toBe(g.nodes[1].agent_id);
    expect(agents[0].id).toBe(g.nodes[0].agent_id);
  });

  it('accepts node values in edges, startNode, and endNodes', () => {
    const { research, write } = linearGraph();

    const g = graph({
      name: 'rw',
      nodes: [research, write],
      edges: [{ from: research, to: write }],
      startNode: research,
      endNodes: [write],
    });

    expect(g.start_node).toBe('research');
    expect(g.end_nodes).toEqual(['write']);
    expect(g.edges[0]).toMatchObject({ source: 'research', target: 'write' });
  });

  it('resolves an agent value referenced from a supervisor node', () => {
    const brain = agent({ model: 'claude-sonnet-4-6', instructions: 'Route work.' });
    const { research, write } = linearGraph();
    const supervisor = node({
      id: 'supervisor',
      type: 'supervisor',
      agent: brain,
      supervisorConfig: { managedNodes: [research, write], maxIterations: 10 },
    });

    const g = graph({
      name: 'sup',
      nodes: [supervisor, research, write],
      edges: [
        { from: supervisor, to: research },
        { from: supervisor, to: write },
        { from: research, to: supervisor },
        { from: write, to: supervisor },
      ],
      startNode: supervisor,
      endNodes: [],
    });

    const supNode = g.nodes.find((n) => n.id === 'supervisor')!;
    expect(supNode.agent_id).toMatch(UUID_RE);
    expect(supNode.supervisor_config?.managed_nodes).toEqual(['research', 'write']);
    expect(agentsForGraph(g).map((a) => a.id)).toContain(supNode.agent_id);
    expect(g.end_nodes).toEqual([]);
  });

  it('resolves agent values deep inside config blocks (evolution)', () => {
    const candidate = agent({ model: 'claude-sonnet-4-6', instructions: 'Draft.' });
    const evaluator = agent({ model: 'claude-sonnet-4-6', instructions: 'Score.' });
    const evolve = node({
      id: 'evolve',
      type: 'evolution',
      reads: ['goal'],
      evolutionConfig: {
        candidateAgentId: candidate,
        evaluatorAgentId: evaluator,
        populationSize: 3,
        maxGenerations: 2,
      },
    });

    const g = graph({ name: 'evo', nodes: [evolve], edges: [] });

    const config = g.nodes[0].evolution_config!;
    expect(config.candidate_agent_id).toMatch(UUID_RE);
    expect(config.evaluator_agent_id).toMatch(UUID_RE);
    expect(config.candidate_agent_id).not.toBe(config.evaluator_agent_id);
    expect(agentsForGraph(g).map((a) => a.id).sort()).toEqual(
      [config.candidate_agent_id, config.evaluator_agent_id].sort(),
    );
  });

  it('pins the agent id when the spec provides one', () => {
    const pinned = agent({ id: 'research-brain', model: 'claude-sonnet-4-6', instructions: 'x' });
    const n = node({ id: 'research', agent: pinned });

    const g = graph({ name: 'pin', nodes: [n], edges: [] });

    expect(g.nodes[0].agent_id).toBe('research-brain');
  });

  it('rejects two distinct agent definitions pinned to the same id', () => {
    const a = agent({ id: 'brain', model: 'claude-sonnet-4-6', instructions: 'first' });
    const b = agent({ id: 'brain', model: 'claude-sonnet-4-6', instructions: 'second' });
    const first = node({ id: 'first', agent: a, writes: 'x' });
    const second = node({ id: 'second', agent: b, reads: ['x'], writes: 'y' });

    expect(() =>
      graph({ name: 'dup', nodes: [first, second], edges: [{ from: first, to: second }] }),
    ).toThrow(/share the id "brain"/);
  });

  it('defaults the node type to agent for a raw agentId', () => {
    const n = node({
      id: 'worker',
      agentId: '00000000-0000-4000-8000-000000000002',
      reads: ['goal'],
      writes: 'out',
    });

    const g = graph({ name: 'raw', nodes: [n], edges: [] });

    expect(g.nodes[0].type).toBe('agent');
  });

  it('collapses an inline tool reference on node tools and stashes the implementation', () => {
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Fetch an order by id',
      parameters: z.object({ orderId: z.string() }),
      execute: () => 'order',
    });
    const worker = node({
      id: 'worker',
      agent: researcherAgent(),
      tools: [lookupOrder, 'save_to_memory'],
      writes: 'out',
    });

    const g = graph({ name: 'inline-tools', nodes: [worker], edges: [] });

    expect(g.nodes[0].tools).toEqual([
      { type: 'custom', name: 'lookup_order' },
      { type: 'builtin', name: 'save_to_memory' },
    ]);
    expect(toolsForGraph(g)).toEqual([lookupOrder]);
    expect(JSON.parse(JSON.stringify(g)).nodes[0].tools[0]).toEqual({
      type: 'custom',
      name: 'lookup_order',
    });
  });

  it('stashes a tool referenced from an agent spec and a node once', () => {
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Fetch an order by id',
      parameters: z.object({ orderId: z.string() }),
      execute: () => 'order',
    });
    const researcher = agent({
      model: 'claude-sonnet-4-6',
      instructions: 'Research specialist.',
      tools: [lookupOrder],
    });
    const first = node({ id: 'first', agent: researcher, writes: 'a' });
    const second = node({ id: 'second', agentId: '00000000-0000-4000-8000-000000000002', tools: [lookupOrder], reads: ['a'], writes: 'b' });

    const g = graph({ name: 'shared-tool', nodes: [first, second], edges: [{ from: first, to: second }] });

    expect(toolsForGraph(g)).toEqual([lookupOrder]);
    expect(agentsForGraph(g)[0].tools).toEqual([{ type: 'custom', name: 'lookup_order' }]);
  });

  it('rejects two distinct tool definitions sharing a name', () => {
    const a = tool({ name: 'lookup', description: 'first', parameters: z.object({}), execute: () => 1 });
    const b = tool({ name: 'lookup', description: 'second', parameters: z.object({}), execute: () => 2 });
    const first = node({ id: 'first', agent: researcherAgent(), tools: [a], writes: 'x' });
    const second = node({ id: 'second', agent: researcherAgent(), tools: [b], reads: ['x'], writes: 'y' });

    expect(() =>
      graph({ name: 'dup-tool', nodes: [first, second], edges: [{ from: first, to: second }] }),
    ).toThrow(/share the name "lookup"/);
  });

  it('preserves Date values inside node config during reference resolution', () => {
    const deadline = new Date('2026-08-01T00:00:00Z');
    const n = node({
      id: 'worker',
      agent: researcherAgent(),
      writes: 'out',
      metadata: { deadline },
    });

    const g = graph({ name: 'dates', nodes: [n], edges: [] });

    expect(g.nodes[0].metadata?.deadline).toBeInstanceOf(Date);
    expect((g.nodes[0].metadata?.deadline as Date).toISOString()).toBe(deadline.toISOString());
  });

  it('translates a conditional edge (when) to a filtrex condition', () => {
    const { research, write } = linearGraph();

    const g = graph({
      name: 'loop',
      nodes: [research, write],
      edges: [
        { from: research, to: write },
        { from: write, to: research, when: 'memory.score < 0.7' },
      ],
      startNode: research,
      endNodes: [write],
    });

    const cond = g.edges.find((e) => e.source === 'write')!;
    expect(cond.condition).toEqual({ type: 'conditional', condition: 'memory.score < 0.7' });
  });

  it('infers start and end nodes for a linear chain', () => {
    const { research, write } = linearGraph();

    const g = graph({ name: 'rw', nodes: [research, write], edges: [{ from: research, to: write }] });

    expect(g.start_node).toBe('research');
    expect(g.end_nodes).toEqual(['write']);
  });

  it('throws when the start node is ambiguous', () => {
    const { research, write } = linearGraph();

    expect(() => graph({ name: 'x', nodes: [research, write], edges: [] })).toThrow(
      /infer a start node/,
    );
  });

  it('rejects duplicate node ids', () => {
    const first = node({ id: 'same', agent: researcherAgent() });
    const second = node({ id: 'same', agent: researcherAgent() });

    expect(() => graph({ name: 'x', nodes: [first, second], edges: [] })).toThrow(GraphSpecError);
  });

  it('rejects a bare agent value in nodes with placement guidance', () => {
    expect(() =>
      graph({ name: 'x', nodes: [researcherAgent() as never], edges: [] }),
    ).toThrow(/wrap it: node\(/);
  });

  it('compiles to the same wire as the hand-authored raw API', () => {
    const researcher = agent({ id: 'research-agent', model: 'claude-sonnet-4-6', instructions: 'Research specialist.' });
    const writer = agent({ id: 'write-agent', model: 'claude-sonnet-4-6', instructions: 'Writer.' });

    const facade = graph({
      name: 'rw',
      description: 'research then write',
      nodes: [
        node({ id: 'research', agent: researcher, reads: ['goal'], writes: 'notes' }),
        node({ id: 'write', agent: writer, reads: ['goal', 'notes'], writes: 'draft' }),
      ],
      edges: [{ from: 'research', to: 'write' }],
    });

    const hand = createGraph({
      name: 'rw',
      description: 'research then write',
      nodes: [
        { id: 'research', type: 'agent', agentId: 'research-agent', readKeys: ['goal'], writeKeys: ['notes'] },
        { id: 'write', type: 'agent', agentId: 'write-agent', readKeys: ['goal', 'notes'], writeKeys: ['draft'] },
      ],
      edges: [{ source: 'research', target: 'write' }],
      startNode: 'research',
      endNodes: ['write'],
    });

    const normalize = (g: Graph): unknown => ({
      ...g,
      id: '<id>',
      edges: g.edges.map((e) => ({ ...e, id: '<edge>' })),
    });
    expect(normalize(facade)).toEqual(normalize(hand));
  });

  it('passes strictTaint through to the wire', () => {
    const { research, write } = linearGraph();

    const g = graph({
      name: 'strict',
      nodes: [research, write],
      edges: [{ from: research, to: write }],
      strictTaint: true,
    });

    expect(g.strict_taint).toBe(true);
  });

  it('accepts a plain node config alongside node values', () => {
    const { research } = linearGraph();

    const g = graph({
      name: 'x',
      nodes: [research, { id: 'tool', type: 'tool', toolId: 'x', tools: ['x'] }],
      edges: [{ from: research, to: 'tool' }],
    });

    expect(g.nodes.find((n) => n.id === 'tool')?.type).toBe('tool');
  });
});
