import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  stepCountIs: vi.fn().mockReturnValue(() => false),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((schema: any) => schema),
  Output: { object: vi.fn().mockReturnValue({}) },
}));
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

let delegateTarget: string | null = null;
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, stateView: any, _t: any, attempt: number) => {
    const updates: Record<string, unknown> = { [`${agentId}_result`]: 'done' };
    // Simulate delegation if configured
    if (delegateTarget) {
      updates._peer_delegation = {
        peer_node_id: delegateTarget,
        reason: `Delegating to ${delegateTarget}`,
      };
    }
    return {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: { updates },
      metadata: {
        node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt,
        token_usage: { totalTokens: 20 },
      },
    };
  }),
}));

vi.mock('../src/agent/supervisor-executor', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agent/evaluator', () => ({ evaluateQuality: vi.fn() }));
vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
}));

import { GraphRunner } from '../src/runner/graph-runner.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

const createState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Swarm test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const createSwarmGraph = (maxHandoffs = 10): Graph => ({
  id: 'swarm-graph',
  name: 'Swarm Test',
  description: 'Test swarm handoffs',
  nodes: [
    {
      id: 'agent-a',
      type: 'agent',
      agent_id: 'swarm-a',
      swarm_config: {
        peer_nodes: ['agent-b'],
        max_handoffs: maxHandoffs,
        handoff_mode: 'agent_choice',
      },
      read_keys: ['*'],
      write_keys: ['*', 'control_flow'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'agent-b',
      type: 'agent',
      agent_id: 'swarm-b',
      swarm_config: {
        peer_nodes: ['agent-a'],
        max_handoffs: maxHandoffs,
        handoff_mode: 'agent_choice',
      },
      read_keys: ['*'],
      write_keys: ['*', 'control_flow'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'agent-a', target: 'agent-b', condition: { type: 'always' } },
    { id: 'e2', source: 'agent-b', target: 'agent-a', condition: { type: 'always' } },
  ],
  start_node: 'agent-a',
  end_nodes: ['agent-a', 'agent-b'],
});

// ─── Tests ────────────────────────────────────────────────────────

describe('Swarm', () => {
  test('should execute normally when no delegation requested', async () => {
    delegateTarget = null;

    const graph = createSwarmGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    expect(finalState.status).toBe('completed');
    expect(finalState.memory['swarm-a_result']).toBe('done');
  });

  test('should handoff to peer when agent delegates', async () => {
    delegateTarget = 'agent-b';

    const graph = createSwarmGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // Should have visited agent-b via handoff
    expect(finalState.visited_nodes).toContain('agent-b');
    expect(finalState.supervisor_history.length).toBeGreaterThan(0);
  });

  test('should reject handoff to non-peer node', async () => {
    delegateTarget = 'agent-c'; // Not a peer

    const graph = createSwarmGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await expect(runner.run()).rejects.toThrow('valid peer');
  });

  test('should stop delegating when max_handoffs reached', async () => {
    // Set max_handoffs to 1 and always try to delegate
    delegateTarget = 'agent-b';

    const graph = createSwarmGraph(1);
    const state = createState();
    state.swarm_handoff_count = 1; // Already at max

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    // Should complete without further handoff
    expect(finalState.status).toBe('completed');
  });

  test('should increment handoff count in memory', async () => {
    delegateTarget = 'agent-b';

    const graph = createSwarmGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    const handoffHistory = finalState.supervisor_history;
    expect(handoffHistory.length).toBeGreaterThan(0);
    // The handoff's memory_updates must actually land in memory — this is
    // what makes max_handoffs enforceable across handoffs.
    expect(finalState.swarm_handoff_count as number).toBeGreaterThanOrEqual(1);
  });

  test('should inject swarm context into agent taskContext', async () => {
    delegateTarget = null;
    const { executeAgent } = await import('../src/agent/agent-executor/executor.js');
    (executeAgent as any).mockClear();

    const graph = createSwarmGraph();
    const state = createState();

    const runner = new GraphRunner(graph, state);
    await runner.run();

    const firstCall = (executeAgent as any).mock.calls[0];
    const stateView = firstCall[1];
    expect(stateView.taskContext?.swarm).toBeDefined();
    expect(stateView.taskContext?.swarm.peer_nodes).toContain('agent-b');
  });
});
