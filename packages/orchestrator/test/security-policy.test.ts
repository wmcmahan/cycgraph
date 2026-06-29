import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (mirror human-in-the-loop.test.ts) ─────────────────────

vi.mock('@ai-sdk/openai', () => ({ openai: vi.fn((m: string) => ({ provider: 'openai', modelId: m })) }));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn((m: string) => ({ provider: 'anthropic', modelId: m })) }));
vi.mock('ai', () => ({ generateObject: vi.fn(), streamText: vi.fn() }));
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

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
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
import { markTainted } from '../src/utils/taint.js';
import type { SecurityPolicy } from '../src/runner/security-policy.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

/** One agent node `sink` that reads everything and is both start and end. */
const createGraph = (): Graph => ({
  id: 'policy-graph',
  name: 'Policy Test',
  description: 'taint-aware policy enforcement',
  nodes: [
    {
      id: 'sink',
      type: 'agent',
      agent_id: 'sink',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
      requires_compensation: false,
    },
  ],
  edges: [],
  start_node: 'sink',
  end_nodes: ['sink'],
});

/** State whose `input` key is already tainted (untrusted). */
const taintedState = (): WorkflowState => {
  const state: WorkflowState = {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'policy test',
    constraints: [],
    status: 'pending',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: { input: 'untrusted content' },
    visited_nodes: [],
    max_iterations: 50,
    compensation_stack: [],
    max_execution_time_ms: 3600000,
    total_tokens_used: 0,
    supervisor_history: [],
  };
  markTainted(state.memory, 'input', {
    source: 'tool_node',
    tool_name: 'external_input',
    created_at: new Date().toISOString(),
  });
  return state;
};

// ─── Tests ────────────────────────────────────────────────────────

describe('security policy enforcement', () => {
  test('allow: tainted + sensitive node runs normally', async () => {
    const policy: SecurityPolicy = vi.fn(() => ({ effect: 'allow' }));
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.memory.sink_result).toBe('output');
    expect(policy).toHaveBeenCalledTimes(1);
  });

  test('policy is NOT consulted when the node reads no tainted data', async () => {
    const policy: SecurityPolicy = vi.fn(() => ({ effect: 'block' }));
    const state = taintedState();
    // Remove the taint registry so nothing is untrusted.
    delete state.memory._taint_registry;
    const runner = new GraphRunner(createGraph(), state, { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(policy).not.toHaveBeenCalled();
  });

  test('policy receives the tainted readable keys', async () => {
    const policy = vi.fn(() => ({ effect: 'allow' as const }));
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    await runner.run();

    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ id: 'sink' }),
        tainted_read_keys: ['input'],
      }),
    );
  });

  test('block: fails the run (fail-closed) and does NOT execute the node', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'block', reason: 'egress blocked', sensitivity: ['egress'] });
    const persist = vi.fn();
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy, persistStateFn: persist });

    // The engine contract: a failed run rejects (the worker persists `failed`).
    await expect(runner.run()).rejects.toThrow('egress blocked');

    const lastPersisted = persist.mock.calls.at(-1)?.[0] as WorkflowState | undefined;
    expect(lastPersisted?.status).toBe('failed');
    expect(lastPersisted?.memory.sink_result).toBeUndefined();
  });

  test('require_approval: pauses the run BEFORE the node executes', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval', reason: 'untrusted → fetch', sensitivity: ['egress'] });
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('waiting');
    expect(final.waiting_for).toBe('human_approval');
    // The gated node has not run yet.
    expect(final.memory.sink_result).toBeUndefined();
    const pending = final.memory._pending_approval as any;
    expect(pending.policy_gate).toBe(true);
    expect(pending.node_id).toBe('sink');
    expect(pending.review_data.sensitivity).toEqual(['egress']);
    expect(pending.review_data.tainted_keys).toEqual(['input']);
  });

  test('approving a policy gate re-enters the gated node and runs it', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval' });
    const r1 = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const waiting = await r1.run();
    expect(waiting.status).toBe('waiting');

    const r2 = new GraphRunner(createGraph(), waiting, { securityPolicy: policy });
    r2.applyHumanResponse({ decision: 'approved' });
    const final = await r2.run();

    expect(final.status).toBe('completed');
    expect(final.memory.sink_result).toBe('output');
  });

  test('rejecting a policy gate cancels the run (the node never executes)', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval' });
    const r1 = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const waiting = await r1.run();

    const r2 = new GraphRunner(createGraph(), waiting, { securityPolicy: policy });
    r2.applyHumanResponse({ decision: 'rejected' });
    const final = await r2.run();

    expect(final.status).toBe('cancelled');
    expect(final.memory.sink_result).toBeUndefined();
  });

  test('no policy provided: tainted node runs unguarded (back-compat)', async () => {
    const runner = new GraphRunner(createGraph(), taintedState());
    const final = await runner.run();
    expect(final.status).toBe('completed');
    expect(final.memory.sink_result).toBe('output');
  });
});
