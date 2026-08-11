import { describe, expect, vi } from 'vitest';
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

vi.mock('../src/agents/executors/agent/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _sv: any, _t: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
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
}));

import { GraphRunner } from '../src/execution/engine/graph-runner.js';
import { markTainted } from '../src/security/taint.js';
import {
  evaluateSecurityPolicy,
  readableTaintedKeys,
  SecurityPolicyViolationError,
} from '../src/security/security-policy.js';
import type {
  SecurityPolicy,
  SecurityPolicyEventPayload,
} from '../src/security/security-policy.js';
import type { Graph, GraphNode } from '../src/graph/graph.js';
import type { TaintRegistry, WorkflowState } from '../src/state/state.js';

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
  state.taint_registry = markTainted({}, 'input', {
    source: 'tool_node',
    tool_name: 'external_input',
    created_at: new Date().toISOString(),
  });
  return state;
};

// ─── Tests ────────────────────────────────────────────────────────

describe('security policy enforcement', () => {
  it('allow: tainted + sensitive node runs normally', async () => {
    const policy: SecurityPolicy = vi.fn(() => ({ effect: 'allow' }));
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.memory.sink_result).toBe('output');
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('policy is NOT consulted when the node reads no tainted data', async () => {
    const policy: SecurityPolicy = vi.fn(() => ({ effect: 'block' }));
    const state = taintedState();
    state.taint_registry = {};
    const runner = new GraphRunner(createGraph(), state, { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(policy).not.toHaveBeenCalled();
  });

  it('policy receives the tainted readable keys', async () => {
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

  it('block: fails the run (fail-closed) and does NOT execute the node', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'block', reason: 'egress blocked', sensitivity: ['egress'] });
    const persist = vi.fn();
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy, persistStateFn: persist });
    await expect(runner.run()).rejects.toThrow('egress blocked');

    const lastPersisted = persist.mock.calls.at(-1)?.[0] as WorkflowState | undefined;
    expect(lastPersisted?.status).toBe('failed');
    expect(lastPersisted?.memory.sink_result).toBeUndefined();
  });

  it('require_approval: pauses the run BEFORE the node executes', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval', reason: 'untrusted → fetch', sensitivity: ['egress'] });
    const runner = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const final = await runner.run();

    expect(final.status).toBe('waiting');
    expect(final.waiting_for).toBe('human_approval');
    expect(final.memory.sink_result).toBeUndefined();
    const pending = final.pending_approval as any;
    expect(pending.policy_gate).toBe(true);
    expect(pending.node_id).toBe('sink');
    expect(pending.review_data.sensitivity).toEqual(['egress']);
    expect(pending.review_data.tainted_keys).toEqual(['input']);
  });

  it('approving a policy gate re-enters the gated node and runs it', async () => {
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

  it('rejecting a policy gate cancels the run (the node never executes)', async () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval' });
    const r1 = new GraphRunner(createGraph(), taintedState(), { securityPolicy: policy });
    const waiting = await r1.run();

    const r2 = new GraphRunner(createGraph(), waiting, { securityPolicy: policy });
    r2.applyHumanResponse({ decision: 'rejected' });
    const final = await r2.run();

    expect(final.status).toBe('cancelled');
    expect(final.memory.sink_result).toBeUndefined();
  });

  it('no policy provided: tainted node runs unguarded (back-compat)', async () => {
    const runner = new GraphRunner(createGraph(), taintedState());
    const final = await runner.run();
    expect(final.status).toBe('completed');
    expect(final.memory.sink_result).toBe('output');
  });
});

describe('evaluateSecurityPolicy', () => {
  const sinkNode = (overrides: Partial<GraphNode> = {}): GraphNode => ({
    id: 'sink',
    type: 'agent',
    agent_id: 'sink',
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
    requires_compensation: false,
    ...overrides,
  });

  const stateWithTaint = (): WorkflowState => taintedState();

  const noopEmit = () => {};

  it('returns undefined when the node reads no tainted data', () => {
    const state = stateWithTaint();
    state.taint_registry = {};
    const policy: SecurityPolicy = () => ({ effect: 'block' });

    const result = evaluateSecurityPolicy({ node: sinkNode(), state, policy, emitPolicyEvent: noopEmit });

    expect(result).toBeUndefined();
  });

  it('returns undefined without consulting the policy for a pre-approved node', () => {
    const state = stateWithTaint();
    state.policy_approvals = { sink: true };
    const policy = vi.fn(() => ({ effect: 'block' as const }));

    const result = evaluateSecurityPolicy({ node: sinkNode(), state, policy, emitPolicyEvent: noopEmit });

    expect(result).toBeUndefined();
    expect(policy).not.toHaveBeenCalled();
  });

  it('returns undefined when the policy allows', () => {
    const policy: SecurityPolicy = () => ({ effect: 'allow' });

    const result = evaluateSecurityPolicy({ node: sinkNode(), state: stateWithTaint(), policy, emitPolicyEvent: noopEmit });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the policy returns no decision', () => {
    const policy: SecurityPolicy = () => undefined;

    const result = evaluateSecurityPolicy({ node: sinkNode(), state: stateWithTaint(), policy, emitPolicyEvent: noopEmit });

    expect(result).toBeUndefined();
  });

  it('emits an audit event and allows the node on a monitor decision', () => {
    const events: SecurityPolicyEventPayload[] = [];
    const policy: SecurityPolicy = () => ({ effect: 'monitor', sensitivity: ['egress'], reason: 'watch it' });

    const result = evaluateSecurityPolicy({
      node: sinkNode(),
      state: stateWithTaint(),
      policy,
      emitPolicyEvent: (p) => events.push(p),
    });

    expect(result).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].effect).toBe('monitor');
    expect(events[0].tainted_keys).toEqual(['input']);
  });

  it('throws SecurityPolicyViolationError on a block decision', () => {
    const policy: SecurityPolicy = () => ({ effect: 'block', reason: 'egress blocked', sensitivity: ['egress'] });

    expect(() =>
      evaluateSecurityPolicy({ node: sinkNode(), state: stateWithTaint(), policy, emitPolicyEvent: noopEmit }),
    ).toThrow(SecurityPolicyViolationError);
  });

  it('uses a default block message when the policy omits a reason', () => {
    const policy: SecurityPolicy = () => ({ effect: 'block' });

    try {
      evaluateSecurityPolicy({ node: sinkNode(), state: stateWithTaint(), policy, emitPolicyEvent: noopEmit });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityPolicyViolationError);
      expect((err as SecurityPolicyViolationError).message).toContain('Blocked by security policy');
      expect((err as SecurityPolicyViolationError).node_id).toBe('sink');
    }
  });

  it('returns a human-approval gate action on a require_approval decision', () => {
    const policy: SecurityPolicy = () => ({ effect: 'require_approval', reason: 'needs review', prompt: 'Approve?' });

    const action = evaluateSecurityPolicy({ node: sinkNode(), state: stateWithTaint(), policy, emitPolicyEvent: noopEmit });

    expect(action?.type).toBe('request_human_input');
    const payload = action?.payload as Record<string, any>;
    expect(payload.waiting_for).toBe('human_approval');
    expect(payload.pending_approval.policy_gate).toBe(true);
    expect(payload.pending_approval.prompt_message).toBe('Approve?');
    expect(payload.pending_approval.review_data.tainted_keys).toEqual(['input']);
  });
});

describe('readableTaintedKeys', () => {
  const node = (readKeys: string[]): GraphNode => ({
    id: 'n',
    type: 'agent',
    agent_id: 'a',
    read_keys: readKeys,
    write_keys: [],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
    requires_compensation: false,
  });

  const registry: TaintRegistry = {
    input: { source: 'tool_node', tool_name: 't', created_at: '2024-01-01T00:00:00.000Z' },
    user: { source: 'mcp_tool', tool_name: 'm', created_at: '2024-01-01T00:00:00.000Z' },
  };

  it('returns an empty array when the registry is empty', () => {
    expect(readableTaintedKeys(node(['*']), {})).toEqual([]);
  });

  it('returns every tainted key when read_keys contains a wildcard', () => {
    expect(readableTaintedKeys(node(['*']), registry).sort()).toEqual(['input', 'user']);
  });

  it('matches dot-notation read keys on their top-level segment', () => {
    expect(readableTaintedKeys(node(['user.name']), registry)).toEqual(['user']);
  });

  it('returns only the tainted keys the node can read', () => {
    expect(readableTaintedKeys(node(['input']), registry)).toEqual(['input']);
  });

  it('returns an empty array when no read key matches a tainted key', () => {
    expect(readableTaintedKeys(node(['unrelated']), registry)).toEqual([]);
  });

  it('treats a missing read_keys as reading nothing', () => {
    const bare = { ...node([]) };
    delete (bare as { read_keys?: string[] }).read_keys;
    expect(readableTaintedKeys(bare, registry)).toEqual([]);
  });
});
