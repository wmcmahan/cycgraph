/**
 * Run-path test for subgraph scoping: a child GraphRunner spawned by a
 * subgraph node must inherit the parent's run-scoped registry/providers
 * (and the original tools option) — falling back to the process-global
 * agent factory would be cross-tenant contamination under multi-tenant
 * workers.
 */

import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { StateView } from '../src/state/state.js';
import type { AgentFactory } from '../src/agents/factory/index.js';

const capturedFactories: AgentFactory[] = [];

vi.mock('../src/agents/executors/agent/executor.js', () => ({
  executeAgent: vi.fn(async (
    agentId: string,
    _view: StateView,
    _tools: Record<string, unknown>,
    attempt: number,
    options?: { agentFactory?: AgentFactory; nodeId?: string; idempotencyKey?: string },
  ) => {
    if (options?.agentFactory) capturedFactories.push(options.agentFactory);
    return {
      id: uuidv4(),
      idempotency_key: options?.idempotencyKey ?? uuidv4(),
      type: 'update_memory',
      payload: { updates: { out: 'child result' } },
      metadata: { node_id: options?.nodeId ?? agentId, agent_id: agentId, timestamp: new Date(), attempt },
    };
  }),
}));

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { createGraph } from '../src/graph/graph.js';
import { InMemoryAgentRegistry } from '../src/persistence/in-memory.js';
import { createTestState } from './helpers/factories.js';

const CHILD_AGENT_ID = uuidv4();
const SCOPED_PROMPT = 'scoped tenant-A researcher';

describe('subgraph child scoping', () => {
  it('resolves child agents from the parent’s run-scoped registry', async () => {
    const registry = new InMemoryAgentRegistry();
    registry.register({
      id: CHILD_AGENT_ID,
      name: 'child-agent',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      systemPrompt: SCOPED_PROMPT,
      tools: [],
      permissions: { readKeys: ['*'], writeKeys: ['*'] },
    });

    const childGraph = createGraph({
      name: 'child',
      description: 'one worker',
      nodes: [
        { id: 'worker', type: 'agent', agentId: CHILD_AGENT_ID, readKeys: ['goal'], writeKeys: ['out'] },
      ],
      edges: [],
      startNode: 'worker',
      endNodes: ['worker'],
    });

    const parentGraph = createGraph({
      name: 'parent',
      description: 'subgraph wrapper',
      nodes: [
        {
          id: 'sub',
          type: 'subgraph',
          subgraphConfig: { subgraphId: childGraph.id, outputMapping: { out: 'sub_out' } },
          readKeys: ['goal'],
          writeKeys: ['sub_out'],
        },
      ],
      edges: [],
      startNode: 'sub',
      endNodes: ['sub'],
    });

    const runner = new GraphRunner(parentGraph, createTestState(), {
      registry,
      loadGraph: async (graphId) => (graphId === childGraph.id ? childGraph : null),
    });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(capturedFactories.length).toBeGreaterThan(0);
    const childConfig = await capturedFactories[0].loadAgent(CHILD_AGENT_ID);
    expect(childConfig.system).toBe(SCOPED_PROMPT);
  });
});
