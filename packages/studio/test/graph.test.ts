/**
 * Tests for the graph view's pure layout (src/server/ui/graph.js) and the
 * /api/graph route that feeds it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  graph as authoredGraph,
  node,
  subgraph,
  tool,
  InMemoryEventLogWriter,
  InMemoryPersistenceProvider,
} from '@cycgraph/orchestrator';
import { catalogOf } from '../src/scenarios/catalog.js';
import { scenario } from '../src/scenarios/types.js';
import { createDashboard } from '../src/server/index.js';
import { defaultStackConfig, type Stack } from '../src/stack/index.js';

import { layout, type WireGraph, type GraphLayout } from '../ui/lib/graph-layout';

const xOf = (l: GraphLayout, id: string) => l.nodes.find((n) => n.id === id)!.x;

describe('layout', () => {
  it('ranks a linear chain left to right', async () => {
    const l = layout({
      id: 'g',
      startNode: 'a',
      endNodes: ['c'],
      nodes: [{ id: 'a', type: 'tool' }, { id: 'b', type: 'tool' }, { id: 'c', type: 'tool' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    });

    expect(xOf(l, 'a')).toBeLessThan(xOf(l, 'b'));
    expect(xOf(l, 'b')).toBeLessThan(xOf(l, 'c'));
    expect(l.back).toEqual([]);
  });

  it('sets a cycle apart as a back edge instead of ranking through it', async () => {
    const l = layout({
      id: 'g',
      startNode: 'plan',
      endNodes: ['finish'],
      nodes: [
        { id: 'plan', type: 'tool' }, { id: 'measure', type: 'subgraph' },
        { id: 'decide', type: 'tool' }, { id: 'finish', type: 'tool' },
      ],
      edges: [
        { source: 'plan', target: 'measure' },
        { source: 'measure', target: 'decide' },
        { source: 'decide', target: 'plan' },
        { source: 'plan', target: 'finish', label: 'done' },
      ],
    });

    expect(l.back).toEqual([{ source: 'decide', target: 'plan' }]);
    expect(xOf(l, 'plan')).toBeLessThan(xOf(l, 'measure'));
    expect(xOf(l, 'measure')).toBeLessThan(xOf(l, 'decide'));
  });

  it('parks an unreachable worker beside its map node with an implicit edge', async () => {
    const l = layout({
      id: 'g',
      startNode: 'fan',
      endNodes: ['fan'],
      nodes: [{ id: 'fan', type: 'map', worker: 'fork' }, { id: 'fork', type: 'tool' }],
      edges: [],
    });

    expect(l.implicit).toEqual([{ source: 'fan', target: 'fork', label: 'fans out' }]);
    expect(xOf(l, 'fan')).toBeLessThan(xOf(l, 'fork'));
  });

  it('draws a supervisor\'s team as routed references', async () => {
    const l = layout({
      id: 'g',
      startNode: 'boss',
      endNodes: [],
      nodes: [{ id: 'boss', type: 'supervisor', managed: ['grind'] }, { id: 'grind', type: 'agent' }],
      edges: [{ source: 'boss', target: 'grind' }, { source: 'grind', target: 'boss' }],
    });

    expect(l.implicit).toEqual([{ source: 'boss', target: 'grind', label: 'routes' }]);
    expect(l.back).toHaveLength(1);
  });
});

describe('/api/graph', () => {
  let running: { close(): void } | undefined;
  afterEach(() => {
    running?.close();
    running = undefined;
  });

  it('serves the lean topology with its embedded children', async () => {
    const stack: Stack = {
      config: defaultStackConfig(),
      available: new Set(),
      gaps: [],
      persistence: new InMemoryPersistenceProvider(),
      eventLog: new InMemoryEventLogWriter(),
      close: async () => {},
    };
    const say = () => tool({
      name: 'say',
      description: 'Says.',
      parameters: z.object({}),
      execute: () => ({ ok: true }),
    });
    const leaf = authoredGraph({ name: 'leaf', nodes: [node({ id: 'emit', type: 'tool', toolId: 'say', tools: [say()] })] });
    const mid = authoredGraph({ name: 'mid', nodes: [subgraph(leaf, { id: 'descend_1' })] });
    const nested = scenario({
      id: 'nested-fixture',
      title: 'Nested fixture',
      covers: [],
      requires: [],
      params: z.object({}),
      build: async () => ({
        graph: authoredGraph({ name: 'top', nodes: [subgraph(mid, { id: 'descend' })] }),
        input: { goal: 'nest' },
        runner: {},
      }),
    });
    const server = createDashboard(defaultStackConfig(), stack, undefined, undefined, catalogOf([nested]));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    running = server;
    const port = (server.address() as AddressInfo).port;

    const query = new URLSearchParams({ scenario: 'nested-fixture', params: JSON.stringify({}) });
    const body = await (await fetch(`http://127.0.0.1:${port}/api/graph?${query}`)).json() as {
      graph: { nodes: Array<{ id: string; childId?: string }> };
      children: Record<string, { nodes: unknown[] }>;
    };

    const descend = body.graph.nodes.find((n) => n.id === 'descend');
    expect(descend?.childId).toBeDefined();
    expect(body.children[descend!.childId!]).toBeDefined();
    expect(Object.keys(body.children)).toHaveLength(2);
  });
});
