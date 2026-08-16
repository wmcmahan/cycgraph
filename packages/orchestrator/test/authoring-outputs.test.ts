/**
 * Output keys carried on an authored node value.
 *
 * The keys a node writes are derived from its id, and typing them by hand is a
 * silent failure: the reader gets an empty slice and passes any assertion that
 * only checks the key exists.
 */

import { describe, it, expect } from 'vitest';
import { a2a, agent, graph, mapReduce, node, reflection, runTool, subgraph, tool, voting, evolution } from '../src/index.js';
import { z } from 'zod';

const worker = () => node({ id: 'worker', type: 'tool', toolId: 'noop' });

describe('node output keys', () => {
  it('names a map node output rather than requiring the convention from memory', () => {
    const fan = mapReduce(worker(), { id: 'fan', items: [1, 2] });

    expect({ results: fan.results, errors: fan.errors, count: fan.count, errorCount: fan.errorCount })
      .toEqual({
        results: 'fan_results',
        errors: 'fan_errors',
        count: 'fan_count',
        errorCount: 'fan_error_count',
      });
  });

  it('names a tool node result, which is singular where a map node is plural', () => {
    expect(node({ id: 'fetch', type: 'tool', toolId: 'lookup' }).result).toBe('fetch_result');
  });

  it('names voting outputs', () => {
    const vote = voting(['a', 'b'], { id: 'poll' });

    expect({ consensus: vote.consensus, votes: vote.votes })
      .toEqual({ consensus: 'poll_consensus', votes: 'poll_votes' });
  });

  it('names evolution outputs', () => {
    const evolve = evolution('candidate', { id: 'eco', evaluator: 'critic' });

    expect({ winner: evolve.winner, fitness: evolve.winnerFitness })
      .toEqual({ winner: 'eco_winner', fitness: 'eco_winner_fitness' });
  });

  it('follows a reflection node result key when one is pinned', () => {
    const pinned = reflection(['notes'], { id: 'distil', resultKey: 'lessons' });
    const derived = reflection(['notes'], { id: 'distil' });

    expect({ pinned: pinned.reflection, derived: derived.reflection })
      .toEqual({ pinned: 'lessons', derived: 'distil_reflection' });
  });

  it('names a synthesizer merge result', () => {
    expect(node({ id: 'reduce', type: 'synthesizer' }).synthesis).toBe('reduce_synthesis');
  });
});

describe('output keys at the graph boundary', () => {
  const built = () => {
    const fan = mapReduce(worker(), { id: 'fan', items: [1] });
    const reduce = node({ id: 'reduce', type: 'synthesizer', reads: [fan.results] });
    return {
      fan,
      graph: graph({
        name: 'outputs',
        nodes: [fan, worker(), reduce],
        edges: [{ from: fan, to: reduce }],
        startNode: fan,
        endNodes: [reduce],
      }),
    };
  };

  it('does not leak the properties onto the wire node', () => {
    const { graph: g } = built();
    const mapNode = g.nodes.find((n) => n.id === 'fan')!;

    expect(Object.keys(mapNode)).not.toContain('results');
  });

  it('survives serialization without them', () => {
    const { graph: g } = built();

    expect(JSON.stringify(g)).not.toContain('"results"');
  });

  it('resolves to a key the reader can actually read', () => {
    const { graph: g } = built();
    const reduce = g.nodes.find((n) => n.id === 'reduce')!;

    expect(reduce.read_keys).toEqual(['fan_results']);
  });

  it('is invisible to spread, which is how the wire node is built', () => {
    const fan = mapReduce(worker(), { id: 'fan', items: [1] });

    expect('results' in { ...fan }).toBe(false);
  });
});

describe('output keys against the runtime authority', () => {
  it('agrees with what a tool node is permitted to write', async () => {
    const { impliedResultKeys } = await import('../src/index.js');
    const probe = tool({ name: 'probe', description: 'p', parameters: z.object({}), execute: () => 1 });
    const call = node({ id: 'call', type: 'tool', toolId: 'probe', tools: [probe] });
    const g = graph({ name: 'agree', nodes: [call], startNode: call, endNodes: [call] });

    expect(impliedResultKeys(g.nodes[0]!)).toContain(call.result);
  });

  it('agrees with what a map node is permitted to write', async () => {
    const { impliedResultKeys } = await import('../src/index.js');
    const fan = mapReduce(worker(), { id: 'fan', items: [1] });
    const g = graph({ name: 'agree', nodes: [fan, worker()], startNode: fan, endNodes: [fan] });
    const permitted = impliedResultKeys(g.nodes.find((n) => n.id === 'fan')!);

    expect(permitted).toEqual(
      expect.arrayContaining([fan.results, fan.errors, fan.count, fan.errorCount]),
    );
  });

  it('agrees for an agent node fallback key', async () => {
    const { impliedResultKeys } = await import('../src/index.js');
    const write = node({
      id: 'draft',
      agent: agent({ id: 'writer', name: 'W', model: 'm', provider: 'ollama', instructions: 'w' }),
    });

    expect(write.output).toBe('draft_output');
    expect(impliedResultKeys).toBeTypeOf('function');
  });
});

describe('inline tool threading', () => {
  const probeGraph = (execute: () => unknown, name = 'probe') => {
    const probe = tool({ name, description: 'p', parameters: z.object({}), execute });
    const call = node({ id: 'call', type: 'tool', toolId: name, tools: [probe], reads: [] });
    return {
      probe,
      call,
      graph: graph({ name: 'inline', nodes: [call], startNode: call, endNodes: [call] }),
    };
  };

  it('runs a node whose tool is declared only on the node', async () => {
    const { GraphRunner, state } = await import('../src/index.js');
    const { graph: g, call } = probeGraph(() => ({ ok: true }));

    const final = await new GraphRunner(g, state({ workflowId: g.id, goal: 'go' })).run();

    expect(final.memory[call.result]).toEqual({ ok: true });
  });

  it('lets a tool supplied on options shadow the inline one of the same name', async () => {
    const { GraphRunner, state } = await import('../src/index.js');
    const { graph: g, call } = probeGraph(() => ({ from: 'inline' }));
    const override = tool({
      name: 'probe',
      description: 'p',
      parameters: z.object({}),
      execute: () => ({ from: 'options' }),
    });

    const final = await new GraphRunner(g, state({ workflowId: g.id, goal: 'go' }), { tools: [override] }).run();

    expect(final.memory[call.result]).toEqual({ from: 'options' });
  });

  it('keeps a tool supplied only on options', async () => {
    const { GraphRunner, state } = await import('../src/index.js');
    const extra = tool({ name: 'extra', description: 'e', parameters: z.object({}), execute: () => 'e' });
    const { graph: g, call } = probeGraph(() => ({ ok: true }));

    const final = await new GraphRunner(g, state({ workflowId: g.id, goal: 'go' }), { tools: [extra] }).run();

    expect(final.memory[call.result]).toEqual({ ok: true });
  });
});

describe('declared write keys', () => {
  const writer = () => agent({ id: 'w', name: 'W', model: 'm', provider: 'ollama', instructions: 'x' });

  it('carries a single declared write key at its literal type', () => {
    const draft = node({ id: 'draft', agent: writer(), writes: 'draft_text' });
    const edit = node({ id: 'edit', agent: writer(), reads: [draft.writes] });

    expect(edit.reads).toEqual(['draft_text']);
  });

  it('carries several declared write keys as the array they were given', () => {
    const many = node({ id: 'many', agent: writer(), writes: ['a', 'b'] });

    expect([...many.writes]).toEqual(['a', 'b']);
  });

  it('offers nothing when a node declares no writes', () => {
    expect(node({ id: 'none', type: 'router' }).writes).toBeUndefined();
  });

  it('still reaches the wire node as write_keys, unlike an output key', () => {
    const draft = node({ id: 'draft', agent: writer(), writes: 'draft_text' });
    const g = graph({ name: 'w', nodes: [draft], startNode: draft, endNodes: [draft] });

    expect(g.nodes[0]!.write_keys).toEqual(['draft_text']);
  });
});

describe('delegating node output mappings', () => {
  const child = () => graph({
    name: 'child',
    nodes: [node({ id: 'inner', type: 'router', writes: 'notes' })],
    outputs: { notes: { schema: { type: 'string' } } },
  });

  it('names the parent key through the delegate name it was mapped from', () => {
    const research = subgraph(child(), { id: 'research', outputs: { notes: 'findings' } });

    expect(research.outputs.notes).toBe('findings');
  });

  it('lets a downstream reader name it without retyping the rename', () => {
    const research = subgraph(child(), { id: 'research', outputs: { notes: 'findings' } });
    const write = node({ id: 'write', type: 'router', reads: [research.outputs.notes] });

    expect(write.reads).toEqual(['findings']);
  });

  it('carries an a2a artifact mapping the same way', () => {
    const remote = a2a('echo', { id: 'remote', outputs: { report: 'remote_notes' } });

    expect(remote.outputs.report).toBe('remote_notes');
  });

  it('is empty rather than absent when a node maps nothing out', () => {
    expect(a2a('echo', { id: 'remote' }).outputs).toEqual({});
  });

  it('stays off the wire node', () => {
    const research = subgraph(child(), { id: 'research', outputs: { notes: 'findings' } });
    const g = graph({ name: 'p', nodes: [research], startNode: research, endNodes: [research] });

    expect(JSON.stringify(g)).not.toContain('outputs');
  });

  it('still reaches the config as the output mapping', () => {
    const research = subgraph(child(), { id: 'research', outputs: { notes: 'findings' } });
    const g = graph({ name: 'p', nodes: [research], startNode: research, endNodes: [research] });

    expect(g.nodes[0]!.subgraph_config?.output_mapping).toEqual({ notes: 'findings' });
  });
});

describe('runTool output key', () => {
  it('names its result like any other tool node', () => {
    expect(runTool('web_fetch', { id: 'lookup' }).result).toBe('lookup_result');
  });
});
