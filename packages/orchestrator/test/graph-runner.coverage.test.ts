/**
 * Targeted coverage for GraphRunner edge paths not exercised by the behavioral
 * suites: preflight wiring failures, wiring warnings, node-failure propagation,
 * and reserved-key memory drops.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

const mockExecuteAgent = vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type: 'update_memory',
  payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
  metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
}));

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: (...args: any[]) => mockExecuteAgent(...args),
}));

vi.mock('../src/agents/executors/supervisor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-6', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner';
import type { Graph } from '../src/graph/graph';
import { createTestState, makeNode } from './helpers/factories';

function singleNodeGraph(overrides: Partial<Graph['nodes'][number]> = {}): Graph {
  return {
    id: uuidv4(),
    name: 'Single Node Graph',
    description: 'One agent node',
    nodes: [makeNode({ id: 'only', agent_id: 'agent-1', ...overrides })],
    edges: [],
    start_node: 'only',
    end_nodes: ['only'],
  } as Graph;
}

describe('GraphRunner preflight wiring', () => {
  it('fails the run when a node declares MCP tools but no resolver is wired', async () => {
    const graph = singleNodeGraph({ tools: [{ type: 'mcp', server_id: 'web' }] as any });
    const runner = new GraphRunner(graph, createTestState());

    await expect(runner.run()).rejects.toThrow(/declares MCP tool sources but no ToolResolver/);
  });

  it('emits a workflow:failed stream event on a wiring error', async () => {
    const graph = singleNodeGraph({ tools: [{ type: 'mcp', server_id: 'web' }] as any });
    const runner = new GraphRunner(graph, createTestState());

    const types: string[] = [];
    for await (const event of runner.stream()) {
      types.push(event.type);
    }

    expect(types).toContain('workflow:failed');
    expect(types).not.toContain('workflow:start');
  });

  it('runs to completion but skips retrieval when memory_query is declared without a retriever', async () => {
    const graph = singleNodeGraph({ memory_query: { max_facts: 5 } as any });
    const runner = new GraphRunner(graph, createTestState());

    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
  });
});

describe('GraphRunner node failure propagation', () => {
  it('emits node:failed and rejects the run when a node throws every attempt', async () => {
    mockExecuteAgent.mockRejectedValueOnce(new Error('agent exploded'));
    const graph = singleNodeGraph({
      failure_policy: { max_retries: 0, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 } as any,
    });
    const runner = new GraphRunner(graph, createTestState());

    const failedSpy = vi.fn();
    runner.on('node:failed', failedSpy);

    await expect(runner.run()).rejects.toThrow(/agent exploded/);
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: 'only', error: expect.stringContaining('agent exploded') }),
    );
  });

  it('yields node:failed then workflow:failed on the streaming path when a node throws', async () => {
    mockExecuteAgent.mockRejectedValueOnce(new Error('agent exploded'));
    const graph = singleNodeGraph({
      failure_policy: { max_retries: 0, backoff_strategy: 'fixed', initial_backoff_ms: 1, max_backoff_ms: 1 } as any,
    });
    const runner = new GraphRunner(graph, createTestState());

    const types: string[] = [];
    for await (const event of runner.stream()) {
      types.push(event.type);
    }

    expect(types).toContain('node:failed');
    expect(types).toContain('workflow:failed');
  });
});

describe('GraphRunner rollback', () => {
  it('skips a compensation entry whose action fails schema validation', async () => {
    const state = createTestState({
      compensation_stack: [
        { action_id: 'bad', compensation_action: { type: 'update_memory', payload: {} } },
      ],
    });
    const runner = new GraphRunner(singleNodeGraph(), state);

    await runner.rollback();

    expect(runner.getState().compensation_stack).toHaveLength(0);
  });
});

describe('GraphRunner reserved-key memory drops', () => {
  it('emits memory:dropped when an agent writes a reserved underscore key', async () => {
    mockExecuteAgent.mockImplementationOnce(async (agentId: string, _sv, _tools, attempt: number) => ({
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates: { _arbitrary_reserved: 'nope', [`${agentId}_result`]: 'ok' } },
      metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
    }));
    const graph = singleNodeGraph();
    const runner = new GraphRunner(graph, createTestState());

    const dropped: unknown[] = [];
    for await (const event of runner.stream()) {
      if (event.type === 'memory:dropped') dropped.push(event);
    }

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ key: '_arbitrary_reserved', reason: 'reserved_key' });
  });
});
