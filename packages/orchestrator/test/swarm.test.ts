/**
 * executeSwarmAgentNode — peer-delegation agent node.
 *
 * Covers the GraphRunner-integrated handoff lifecycle and the direct
 * option-forwarding branches (model override, default write key).
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  isStepCount: vi.fn().mockReturnValue(() => false),
  tool: vi.fn((def: any) => def),
  jsonSchema: vi.fn((schema: any) => schema),
  Output: { object: vi.fn().mockReturnValue({}) },
}));
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: () => undefined,
    getTracer: () => ({
      startActiveSpan: (_n: string, _o: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  isSpanContextValid: () => false,
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

let delegateTarget: string | null = null;
vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _t: any, attempt: number) => {
    const updates: Record<string, unknown> = { [`${agentId}_result`]: 'done' };
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

vi.mock('../src/agents/executors/supervisor', () => ({ executeSupervisor: vi.fn() }));
vi.mock('../src/agents/evaluator', () => ({ evaluateQuality: vi.fn() }));
vi.mock('../src/agents/factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test', name: 'Test', model: 'gpt-4', provider: 'openai',
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
  withSpan: (_t: any, _n: string, fn: (s: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { executeSwarmAgentNode } from '../src/execution/nodes/swarm.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { WorkflowState, StateView, Action } from '../src/state/state.js';
import type { NodeExecutorContext, ExecutorDependencies } from '../src/execution/nodes/context.js';

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
      swarm_config: { peer_nodes: ['agent-b'], max_handoffs: maxHandoffs, handoff_mode: 'agent_choice' },
      read_keys: ['*'],
      write_keys: ['*', 'control_flow'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'agent-b',
      type: 'agent',
      agent_id: 'swarm-b',
      swarm_config: { peer_nodes: ['agent-a'], max_handoffs: maxHandoffs, handoff_mode: 'agent_choice' },
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

describe('executeSwarmAgentNode', () => {
  describe('via GraphRunner', () => {
    it('executes normally when no delegation is requested', async () => {
      delegateTarget = null;
      const runner = new GraphRunner(createSwarmGraph(), createState());

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
      expect(finalState.memory['swarm-a_result']).toBe('done');
    });

    it('hands off to a peer when the agent delegates', async () => {
      delegateTarget = 'agent-b';
      const runner = new GraphRunner(createSwarmGraph(), createState());

      const finalState = await runner.run();

      expect(finalState.visited_nodes).toContain('agent-b');
      expect(finalState.supervisor_history.length).toBeGreaterThan(0);
    });

    it('rejects a handoff to a non-peer node', async () => {
      delegateTarget = 'agent-c';
      const runner = new GraphRunner(createSwarmGraph(), createState());

      await expect(runner.run()).rejects.toThrow('valid peer');
    });

    it('stops delegating once max_handoffs is reached', async () => {
      delegateTarget = 'agent-b';
      const state = createState();
      state.swarm_handoff_count = 1;
      const runner = new GraphRunner(createSwarmGraph(1), state);

      const finalState = await runner.run();

      expect(finalState.status).toBe('completed');
    });

    it('lands the incremented handoff count in state', async () => {
      delegateTarget = 'agent-b';
      const runner = new GraphRunner(createSwarmGraph(), createState());

      const finalState = await runner.run();

      expect(finalState.supervisor_history.length).toBeGreaterThan(0);
      expect(finalState.swarm_handoff_count as number).toBeGreaterThanOrEqual(1);
    });

    it('injects swarm peer context into the agent taskContext', async () => {
      delegateTarget = null;
      const { executeAgent } = await import('../src/agents/executors/agent/executor.js');
      (executeAgent as any).mockClear();
      const runner = new GraphRunner(createSwarmGraph(), createState());

      await runner.run();

      const stateView = (executeAgent as any).mock.calls[0][1];
      expect(stateView.taskContext?.swarm).toBeDefined();
      expect(stateView.taskContext?.swarm.peer_nodes).toContain('agent-b');
    });
  });

  describe('option forwarding', () => {
    const makeNode = (overrides: Partial<GraphNode> = {}): GraphNode => ({
      id: 'swarm-node',
      type: 'agent',
      agent_id: 'swarm-agent',
      swarm_config: { peer_nodes: ['peer'], max_handoffs: 5, handoff_mode: 'agent_choice' },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
      ...overrides,
    } as GraphNode);

    const makeStateView = (): StateView => ({
      workflow_id: 'wf-1', run_id: 'run-1', goal: 'g', constraints: [], memory: {},
    });

    const makeAction = (): Action => ({
      id: 'act-1',
      idempotency_key: 'idem-1',
      type: 'update_memory',
      payload: { updates: { swarm_result: 'done' } },
      metadata: { node_id: 'swarm-node', timestamp: new Date(), attempt: 1 },
    });

    const makeDeps = (overrides: Partial<ExecutorDependencies> = {}): ExecutorDependencies => ({
      executeAgent: vi.fn().mockResolvedValue(makeAction()),
      executeSupervisor: vi.fn(),
      evaluateQualityExecutor: vi.fn(),
      resolveTools: vi.fn().mockResolvedValue({}),
      loadAgent: vi.fn().mockResolvedValue({ tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6' }),
      getTaintRegistry: vi.fn().mockReturnValue({}),
      ...overrides,
    });

    const makeCtx = (overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext => ({
      state: { ...createState(), swarm_handoff_count: 0 },
      graph: { id: 'g-1', name: 'Test', nodes: [], edges: [], start_node: 'start', metadata: {} } as any,
      createStateView: () => makeStateView(),
      deps: makeDeps(),
      ...overrides,
    });

    it('forwards a resolved modelOverride to executeAgent', async () => {
      const deps = makeDeps({
        loadAgent: vi.fn().mockResolvedValue({
          tools: [], write_keys: [], provider: 'anthropic', model: 'claude-sonnet-4-6', model_preference: 'high',
        }),
      });
      const ctx = makeCtx({
        deps,
        modelResolver: (() => ({ model: 'claude-opus-4-8', reason: 'high-tier' })) as any,
        remainingBudgetUsd: 100,
      });

      await executeSwarmAgentNode(makeNode(), makeStateView(), 1, ctx);

      const callArgs = (deps.executeAgent as any).mock.calls[0][4];
      expect(callArgs.modelOverride).toBe('claude-opus-4-8');
    });

    it('forwards default_write_key as defaultWriteKey', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ deps });

      await executeSwarmAgentNode(makeNode({ default_write_key: 'summary' }), makeStateView(), 1, ctx);

      const callArgs = (deps.executeAgent as any).mock.calls[0][4];
      expect(callArgs.defaultWriteKey).toBe('summary');
    });

    it('omits both options when neither model_preference nor default_write_key is set', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ deps });

      await executeSwarmAgentNode(makeNode(), makeStateView(), 1, ctx);

      const callArgs = (deps.executeAgent as any).mock.calls[0][4];
      expect(callArgs.modelOverride).toBeUndefined();
      expect(callArgs.defaultWriteKey).toBeUndefined();
    });
  });
});
