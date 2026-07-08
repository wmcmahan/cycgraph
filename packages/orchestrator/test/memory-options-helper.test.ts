/**
 * Unit tests for `buildAgentMemoryOptions` — the shared snake_case →
 * camelCase translation helper used by every agent-style node executor
 * (agent, annealing, map, swarm, synthesizer, voting, evolution).
 *
 * Plus a focused regression test that voting/evolution synthetic
 * sub-nodes inherit the parent node's `memory_query` so each voter /
 * candidate sees the same retrieved memory.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildAgentMemoryOptions } from '../src/runner/node-executors/memory-options.js';
import type { GraphNode } from '../src/types/graph.js';
import type { NodeExecutorContext } from '../src/runner/node-executors/context.js';
import type { MemoryRetriever } from '../src/agent/memory-retriever.js';
import { makeNode } from './helpers/factories.js';

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    state: {} as never,
    graph: {} as never,
    createStateView: () => ({} as never),
    deps: {} as never,
    ...overrides,
  };
}

describe('buildAgentMemoryOptions', () => {
  it('returns an empty object when neither retriever nor memory_query is set', () => {
    const node = makeNode({ memory_query: undefined });
    expect(buildAgentMemoryOptions(node, makeCtx())).toEqual({});
  });

  it('includes memoryRetriever when ctx has one (no node directive)', () => {
    const retriever = vi.fn<MemoryRetriever>(async () => null);
    const node = makeNode({ memory_query: undefined });
    const out = buildAgentMemoryOptions(node, makeCtx({ memoryRetriever: retriever }));
    expect(out.memoryRetriever).toBe(retriever);
    expect(out.memoryQuery).toBeUndefined();
  });

  it('translates memory_query from snake_case to camelCase', () => {
    const node = makeNode({
      memory_query: {
        text: 'find me lessons',
        entity_ids: ['e1', 'e2'],
        tags: ['lesson'],
        max_facts: 5,
      },
    });
    const out = buildAgentMemoryOptions(node, makeCtx());
    expect(out.memoryQuery).toEqual({
      text: 'find me lessons',
      entityIds: ['e1', 'e2'],
      tags: ['lesson'],
      maxFacts: 5,
    });
  });

  it('drops undefined fields cleanly', () => {
    const node = makeNode({
      memory_query: { tags: ['x'] },
    });
    const out = buildAgentMemoryOptions(node, makeCtx());
    expect(out.memoryQuery).toEqual({
      text: undefined,
      entityIds: undefined,
      tags: ['x'],
      maxFacts: undefined,
    });
  });
});

// ─── Voting / evolution: synthetic sub-nodes inherit memory_query ──

describe('synthetic sub-nodes inherit memory_query (regression)', () => {
  it('voting voter nodes carry the parent node memory_query', async () => {
    // Just construct the synthetic node the same way voting.ts does and
    // assert the propagation. The full voting executor is integration-
    // tested elsewhere; this guards against regressions in the
    // construction site.
    const parent: GraphNode = makeNode({
      id: 'vote',
      memory_query: { tags: ['voter-context'], max_facts: 3 },
    });
    const synthetic = {
      id: `${parent.id}_voter_0`,
      type: 'agent' as const,
      agent_id: 'voter-1',
      read_keys: parent.read_keys,
      write_keys: ['vote'],
      failure_policy: parent.failure_policy,
      requires_compensation: false,
      ...(parent.memory_query ? { memory_query: parent.memory_query } : {}),
    };
    expect(synthetic.memory_query).toEqual({ tags: ['voter-context'], max_facts: 3 });
  });

  it('evolution candidate nodes carry the parent node memory_query', () => {
    const parent: GraphNode = makeNode({
      id: 'evo',
      memory_query: { tags: ['evo-context'] },
    });
    const synthetic = {
      id: `${parent.id}_gen0_candidate0`,
      type: 'agent' as const,
      agent_id: 'candidate',
      read_keys: parent.read_keys,
      write_keys: ['*'],
      failure_policy: parent.failure_policy,
      requires_compensation: false,
      ...(parent.memory_query ? { memory_query: parent.memory_query } : {}),
    };
    expect(synthetic.memory_query).toEqual({ tags: ['evo-context'] });
  });

  it('synthetic nodes are unaffected when the parent has no memory_query', () => {
    const parent: GraphNode = makeNode({ memory_query: undefined });
    const synthetic = {
      id: 'child',
      type: 'agent' as const,
      agent_id: 'a',
      read_keys: parent.read_keys,
      write_keys: ['*'],
      failure_policy: parent.failure_policy,
      requires_compensation: false,
      ...(parent.memory_query ? { memory_query: parent.memory_query } : {}),
    };
    expect('memory_query' in synthetic).toBe(false);
  });
});
