import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ─────────────────────────────────────────────────────────

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
    getTracer: () => ({
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
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
}));

import { GraphRunner } from '../src/execution/engine/graph-runner';
import type { Graph } from '../src/graph/graph';
import { createTestState, makeNode } from './helpers/factories';

// ─── Shared helpers ─────────────────────────────────────────────────────

const createLinearGraph = (): Graph => ({
  id: uuidv4(),
  name: 'Linear Test Graph',
  description: 'Simple linear graph for testing',
  nodes: [
    makeNode({ id: 'start', agent_id: 'agent-1' }),
    makeNode({ id: 'end', agent_id: 'agent-2', read_keys: ['result'] }),
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end', condition: { type: 'always' } }],
  start_node: 'start',
  end_nodes: ['end'],
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('GraphRunner — Basic Execution', () => {
  it('should execute a simple linear graph', async () => {
    const runner = new GraphRunner(createLinearGraph(), createTestState());
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.visited_nodes).toContain('start');
    expect(finalState.visited_nodes).toContain('end');
    expect(finalState.iteration_count).toBeGreaterThan(0);
  });

  it('should start with pending status', async () => {
    const initialState = createTestState();
    expect(initialState.status).toBe('pending');
    const runner = new GraphRunner(createLinearGraph(), initialState);
    await runner.run();
  });

  it('should track visited nodes', async () => {
    const runner = new GraphRunner(createLinearGraph(), createTestState());
    const finalState = await runner.run();

    expect(finalState.visited_nodes.length).toBeGreaterThan(0);
    expect(finalState.visited_nodes[0]).toBe('start');
  });
});

describe('GraphRunner — Event Emission', () => {
  it('should emit workflow:start event', async () => {
    const initialState = createTestState();
    const runner = new GraphRunner(createLinearGraph(), initialState);

    const startSpy = vi.fn();
    runner.on('workflow:start', startSpy);
    await runner.run();

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledWith({
      workflow_id: initialState.workflow_id,
      run_id: initialState.run_id,
    });
  });

  it('should emit workflow:complete event', async () => {
    const initialState = createTestState();
    const runner = new GraphRunner(createLinearGraph(), initialState);

    const completeSpy = vi.fn();
    runner.on('workflow:complete', completeSpy);
    await runner.run();

    expect(completeSpy).toHaveBeenCalledOnce();
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: initialState.workflow_id,
        run_id: initialState.run_id,
        duration_ms: expect.any(Number),
      })
    );
  });

  it('should emit node:start events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createTestState());
    const nodeStartSpy = vi.fn();
    runner.on('node:start', nodeStartSpy);
    await runner.run();

    expect(nodeStartSpy).toHaveBeenCalled();
    expect(nodeStartSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: expect.any(String), type: expect.any(String), timestamp: expect.any(Number) })
    );
  });

  it('should emit node:complete events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createTestState());
    const nodeCompleteSpy = vi.fn();
    runner.on('node:complete', nodeCompleteSpy);
    await runner.run();

    expect(nodeCompleteSpy).toHaveBeenCalled();
    expect(nodeCompleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: expect.any(String), type: expect.any(String), duration_ms: expect.any(Number) })
    );
  });

  it('should emit action:applied events', async () => {
    const runner = new GraphRunner(createLinearGraph(), createTestState());
    const actionSpy = vi.fn();
    runner.on('action:applied', actionSpy);
    await runner.run();

    expect(actionSpy).toHaveBeenCalled();
    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action_id: expect.any(String), type: expect.any(String), node_id: expect.any(String) })
    );
  });
});

describe('GraphRunner — State Persistence', () => {
  it('should call persistState function', async () => {
    const initialState = createTestState();
    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(createLinearGraph(), initialState, { persistState: persistSpy });
    await runner.run();

    expect(persistSpy).toHaveBeenCalled();
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow_id: initialState.workflow_id, run_id: initialState.run_id })
    );
  });

  it('still honors the deprecated persistStateFn alias', async () => {
    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(createLinearGraph(), createTestState(), { persistStateFn: persistSpy });
    await runner.run();

    expect(persistSpy).toHaveBeenCalled();
  });

  it('prefers persistState over the deprecated alias when both are given', async () => {
    const primary = vi.fn().mockResolvedValue(undefined);
    const alias = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(createLinearGraph(), createTestState(), {
      persistState: primary,
      persistStateFn: alias,
    });
    await runner.run();

    expect(primary).toHaveBeenCalled();
    expect(alias).not.toHaveBeenCalled();
  });

  it('should emit state:persisted events', async () => {
    const initialState = createTestState();
    const runner = new GraphRunner(createLinearGraph(), initialState, { persistStateFn: vi.fn().mockResolvedValue(undefined) });
    const persistedSpy = vi.fn();
    runner.on('state:persisted', persistedSpy);
    await runner.run();

    expect(persistedSpy).toHaveBeenCalled();
    expect(persistedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: initialState.run_id, iteration: expect.any(Number) })
    );
  });
});
