/**
 * taint.test.ts
 *
 * Tests for the taint tracking system:
 * - Taint utility functions (mark, check, get, propagate)
 * - MCP tool adapter tainting external results
 * - Tool node propagation through GraphRunner
 * - Supervisor prompt taint warnings
 * - Agent executor derived taint propagation
 */
import { describe, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

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
      startActiveSpan: (_name: string, _opts: any, fn: any) =>
        fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 0, ERROR: 2 },
  context: {},
}));

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../src/utils/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

vi.mock('../src/architect/tools', () => ({
  architectToolDefinitions: {},
  executeArchitectTool: vi.fn().mockResolvedValue({ drafted: true }),
}));

// Mock agent-executor and supervisor for GraphRunner tests
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _sv: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: `${agentId}:${attempt}`,
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'done' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

// tool-adapter.ts has been removed — tool resolution now goes through MCPConnectionManager

// Supervisor-executor is NOT mocked — we test the real buildSupervisorPrompt logic
// (it uses the mocked 'ai' generateObject above)

vi.mock('../src/agent/agent-factory/index', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-6', provider: 'anthropic',
      system: 'test', temperature: 0.7, maxSteps: 10, tools: [],
      read_keys: ['*'], write_keys: ['*'],
    }),
    getModel: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../src/runner/helpers', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

// ─── Imports ────────────────────────────────────────────────────────────

import {
  markTainted,
  isTainted,
  getTaintRegistry,
  getTaintInfo,
  propagateDerivedTaint,
  aggregateParallelTaint,
} from '../src/utils/taint.js';
import type { TaintMetadata, TaintRegistry } from '../src/types/state.js';
import { GraphRunner } from '../src/runner/graph-runner.js';
import { executeSupervisor } from '../src/agent/supervisor-executor/executor.js';
import { generateText } from 'ai';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Test Helpers ───────────────────────────────────────────────────────

const makeNode = (overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode => ({
  read_keys: ['*'],
  write_keys: ['*'],
  failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 10, max_backoff_ms: 10 },
  requires_compensation: false,
  ...overrides,
});

const createState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Taint test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 30000,
  supervisor_history: [],
  total_tokens_used: 0,
  ...overrides,
});

// ─── Utility Tests ──────────────────────────────────────────────────────

describe('Taint Utilities', () => {
  it('markTainted returns a new registry with the entry (pure)', () => {
    const registry: TaintRegistry = {};

    const next = markTainted(registry, 'search_result', {
      source: 'mcp_tool',
      tool_name: 'web_search',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(registry).toEqual({});
    expect(next['search_result']).toEqual({
      source: 'mcp_tool',
      tool_name: 'web_search',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('isTainted returns true for tainted keys, false for clean ones', () => {
    const registry: TaintRegistry = {
      dirty: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
    };

    expect(isTainted(registry, 'dirty')).toBe(true);
    expect(isTainted(registry, 'clean')).toBe(false);
    expect(isTainted(registry, 'nonexistent')).toBe(false);
  });

  it('getTaintRegistry returns empty object when the state field is absent', () => {
    expect(getTaintRegistry({ taint_registry: undefined as never })).toEqual({});
  });

  it('getTaintRegistry returns the state field', () => {
    const registry: TaintRegistry = {
      key1: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
    };

    expect(getTaintRegistry({ taint_registry: registry })).toEqual(registry);
  });

  it('getTaintInfo returns metadata for tainted key', () => {
    const meta: TaintMetadata = {
      source: 'mcp_tool',
      tool_name: 'browser',
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const registry: TaintRegistry = { page_content: meta };

    expect(getTaintInfo(registry, 'page_content')).toEqual(meta);
    expect(getTaintInfo(registry, 'clean_key')).toBeUndefined();
  });

  it('propagateDerivedTaint marks outputs when readable inputs are tainted', () => {
    const memory: Record<string, unknown> = { search_result: 'external data' };
    const registry: TaintRegistry = {
      search_result: { source: 'mcp_tool', tool_name: 'web_search', created_at: '2024-01-01T00:00:00.000Z' },
    };

    const result = propagateDerivedTaint(memory, registry, ['summary', 'analysis'], 'researcher');

    expect(result['summary']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'researcher' }),
    );
    expect(result['analysis']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'researcher' }),
    );
  });

  it('propagateDerivedTaint returns empty when no inputs are tainted', () => {
    const memory: Record<string, unknown> = { clean_data: 'safe' };

    const result = propagateDerivedTaint(memory, {}, ['output'], 'agent-1');
    expect(result).toEqual({});
  });
});

describe('aggregateParallelTaint', () => {
  const taintedUpdate = () => ({
    _taint_registry: {
      'srv:tool': { source: 'mcp_tool', tool_name: 'tool', created_at: '2024-01-01T00:00:00.000Z' },
    },
  });

  it('marks every aggregate key derived when any worker produced taint', () => {
    const result = aggregateParallelTaint(
      [{ clean: 'x' }, taintedUpdate()],
      ['node_results', 'node_consensus'],
      'fanout',
    );

    expect(result['node_results']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'fanout' }),
    );
    expect(result['node_consensus']).toEqual(
      expect.objectContaining({ source: 'derived', agent_id: 'fanout' }),
    );
    expect(typeof result['node_results'].created_at).toBe('string');
  });

  it('returns empty when no worker produced taint', () => {
    const result = aggregateParallelTaint([{ a: 1 }, { b: 2 }], ['out'], 'fanout');
    expect(result).toEqual({});
  });

  it('ignores null, undefined, and non-object worker updates', () => {
    const result = aggregateParallelTaint([null, undefined, 'string' as never], ['out'], 'fanout');
    expect(result).toEqual({});
  });

  it('ignores an empty taint registry on a worker', () => {
    const result = aggregateParallelTaint([{ _taint_registry: {} }], ['out'], 'fanout');
    expect(result).toEqual({});
  });

  it('ignores an array-valued _taint_registry', () => {
    const result = aggregateParallelTaint([{ _taint_registry: [] as never }], ['out'], 'fanout');
    expect(result).toEqual({});
  });

  it('returns empty when there are no aggregate keys even with tainted workers', () => {
    const result = aggregateParallelTaint([taintedUpdate()], [], 'fanout');
    expect(result).toEqual({});
  });
});

// Taint wrapping for MCP tools is now tested in connection-manager.test.ts

// Tool node taint propagation is now tested via connection-manager.test.ts
// (taint wrapping) and node-executors.test.ts (taint registry updates).

// ─── Supervisor Prompt Taint Warning ────────────────────────────────────

describe('Supervisor — Taint Warnings', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
  });

  it('supervisor prompt includes taint warning when memory has tainted keys', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'all done' },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const stateView = {
      workflow_id: uuidv4(),
      run_id: uuidv4(),
      goal: 'Test taint warning',
      constraints: [],
      memory: {
        search_result: 'some external data',
      },
      taint: {
        search_result: {
          source: 'mcp_tool' as const,
          tool_name: 'web_search',
          created_at: '2024-01-01T00:00:00.000Z',
        },
      },
    };

    const node = makeNode({
      id: 'supervisor-1',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'router-agent',
        managed_nodes: ['worker-1', 'worker-2'],
        max_iterations: 10,
      },
    });

    await executeSupervisor(node, stateView, [], 1);

    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
    const systemPrompt = vi.mocked(generateText).mock.calls[0][0].instructions as string;
    expect(systemPrompt).toContain('[TAINTED]');
    expect(systemPrompt).toContain('search_result');
  });

  it('supervisor prompt has no taint warning when memory is clean', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'all done' },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const stateView = {
      workflow_id: uuidv4(),
      run_id: uuidv4(),
      goal: 'Test clean memory',
      constraints: [],
      memory: {
        clean_data: 'safe internal data',
      },
    };

    const node = makeNode({
      id: 'supervisor-2',
      type: 'supervisor',
      supervisor_config: {
        agent_id: 'router-agent',
        managed_nodes: ['worker-1'],
        max_iterations: 10,
      },
    });

    await executeSupervisor(node, stateView, [], 1);

    const systemPrompt = vi.mocked(generateText).mock.calls[0][0].instructions as string;
    expect(systemPrompt).not.toContain('[TAINTED]');
  });
});

describe('Supervisor — budget accounting', () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
  });

  const cleanStateView = (memory: Record<string, unknown> = {}) => ({
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    goal: 'route',
    constraints: [],
    memory,
  });

  const supervisorNode = (overrides = {}) => makeNode({
    id: 'sup',
    type: 'supervisor',
    supervisor_config: { agent_id: 'router-agent', managed_nodes: ['worker-1'], max_iterations: 10 },
    ...overrides,
  });

  it('handoff action carries token_usage and model for budget tracking', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: 'worker-1', reasoning: 'go' },
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    } as any);

    const action = await executeSupervisor(supervisorNode(), cleanStateView(), [], 1);

    expect(action.type).toBe('handoff');
    expect(action.metadata.token_usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(action.metadata.model).toBeTruthy();
  });

  it('completion action carries token_usage', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'done' },
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    } as any);

    const action = await executeSupervisor(supervisorNode(), cleanStateView(), [], 1);

    expect(action.type).toBe('set_status');
    expect(action.metadata.token_usage).toEqual({ inputTokens: 80, outputTokens: 20, totalTokens: 100 });
  });

  it('totalTokens is derived when the provider omits it', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'done' },
      usage: { inputTokens: 70, outputTokens: 30 },
    } as any);

    const action = await executeSupervisor(supervisorNode(), cleanStateView(), [], 1);
    expect(action.metadata.token_usage?.totalTokens).toBe(100);
  });

  it('supervisor prompt memory is byte-capped (no quadratic growth)', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { next_node: '__done__', reasoning: 'done' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as any);
    const huge = 'x'.repeat(500_000);
    await executeSupervisor(supervisorNode(), cleanStateView({ blob: huge }), [], 1);

    const systemPrompt = vi.mocked(generateText).mock.calls[0][0].instructions as string;
    expect(systemPrompt).toContain('[truncated');
    expect(systemPrompt.length).toBeLessThan(200_000);
  });
});

describe('GraphRunner — strict_taint routing', () => {
  const buildBranchGraph = (strict_taint: boolean): Graph => ({
    id: 'strict-taint-graph',
    name: 'Strict Taint Routing',
    description: 'Routes on a tainted memory key',
    strict_taint,
    nodes: [
      makeNode({ id: 'A', type: 'agent', agent_id: 'a' }),
      makeNode({ id: 'go_node', type: 'agent', agent_id: 'go' }),
      makeNode({ id: 'safe_node', type: 'agent', agent_id: 'safe' }),
    ],
    edges: [
      { id: 'e_cond', source: 'A', target: 'go_node', condition: { type: 'conditional', condition: 'memory.decision == "go"' } },
      { id: 'e_safe', source: 'A', target: 'safe_node', condition: { type: 'always' } },
    ],
    start_node: 'A',
    end_nodes: ['go_node', 'safe_node'],
  });

  const taintedDecisionState = () => createState({
    memory: { decision: 'go' },
    taint_registry: { decision: { source: 'mcp_tool' as const, tool_name: 'web_search', created_at: new Date().toISOString() } },
  });

  it('default (strict_taint false): routes on the tainted key', async () => {
    const runner = new GraphRunner(buildBranchGraph(false), taintedDecisionState());
    const final = await runner.run();
    expect(final.visited_nodes).toContain('go_node');
    expect(final.visited_nodes).not.toContain('safe_node');
  });

  it('strict_taint true: refuses to route on the tainted key, takes the safe edge', async () => {
    const runner = new GraphRunner(buildBranchGraph(true), taintedDecisionState());
    const final = await runner.run();
    expect(final.visited_nodes).toContain('safe_node');
    expect(final.visited_nodes).not.toContain('go_node');
  });
});
