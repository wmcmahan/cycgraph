/**
 * Run-path test for PARTIAL run scoping: a GraphRunner given only
 * `options.providers` must inherit the globally-configured agent registry
 * instead of silently dropping it — otherwise every agent would degrade to
 * the deny-all default config while still spending real tokens.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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
      payload: { updates: { out: 'done' } },
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
import { agentFactory as globalAgentFactory } from '../src/agents/factory/index.js';
import { createProviderRegistry } from '../src/agents/providers/provider-registry.js';
import { createTestState } from './helpers/factories.js';

const AGENT_ID = uuidv4();
const GLOBAL_PROMPT = 'globally registered researcher';

afterEach(() => {
  globalAgentFactory.setRegistry(undefined as never);
});

describe('partial run scoping', () => {
  it('inherits the global registry when only providers are scoped', async () => {
    const globalRegistry = new InMemoryAgentRegistry();
    globalRegistry.register({
      id: AGENT_ID,
      name: 'researcher',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      systemPrompt: GLOBAL_PROMPT,
      tools: [],
      permissions: { readKeys: ['*'], writeKeys: ['*'] },
    });
    globalAgentFactory.setRegistry(globalRegistry);

    const g = createGraph({
      name: 'partial-scope',
      description: 'one worker',
      nodes: [{ id: 'worker', type: 'agent', agentId: AGENT_ID, readKeys: ['goal'], writeKeys: ['out'] }],
      edges: [],
      startNode: 'worker',
      endNodes: ['worker'],
    });
    const runner = new GraphRunner(g, createTestState(), { providers: createProviderRegistry() });
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(capturedFactories.length).toBeGreaterThan(0);
    const config = await capturedFactories[0].loadAgent(AGENT_ID);
    expect(config.system).toBe(GLOBAL_PROMPT);
  });
});
