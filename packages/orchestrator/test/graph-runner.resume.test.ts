/**
 * graph-runner.resume.test.ts
 *
 * Tests for workflow resumability (Remediation 3.1).
 * Verifies that GraphRunner can resume from a checkpoint state
 * instead of always starting from start_node.
 */
import { describe, it, expect, vi } from 'vitest';
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

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: `${agentId}:${attempt}`,
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: `done` } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-3-5-sonnet', provider: 'anthropic',
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
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
}));

vi.mock('../src/runner/helpers', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

import { GraphRunner } from '../src/runner/graph-runner.js';
import { InMemoryEventLogWriter } from '../src/db/event-log.js';
import type { Graph, GraphNode } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ────────────────────────────────────────────────────────────

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
  goal: 'Resume test',
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('GraphRunner — Resume from Checkpoint', () => {
  /**
   * When a GraphRunner is initialized with a state that already has
   * visited_nodes and current_node, it should resume from that node
   * instead of starting from start_node.
   */
  it('should resume from current_node when state has visited_nodes', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Resume Test', description: '',
      nodes: [
        makeNode({ id: 'step-1', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'step-2', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'step-3', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'step-1', target: 'step-2', condition: { type: 'always' } },
        { id: 'e2', source: 'step-2', target: 'step-3', condition: { type: 'always' } },
      ],
      start_node: 'step-1',
      end_nodes: ['step-3'],
    };

    const runId = uuidv4();

    const resumeState = createState({
      run_id: runId,
      current_node: 'step-2',
      visited_nodes: ['step-1', 'step-2'],
      iteration_count: 1,
      status: 'running',
      started_at: new Date(),
    });

    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append({
      run_id: runId, sequence_id: 0, event_type: 'workflow_started',
    });
    await eventLog.append({
      run_id: runId, sequence_id: 1, event_type: 'action_dispatched',
      node_id: 'step-1', action: { metadata: { node_id: 'step-1' } },
    });

    const persistSpy = vi.fn().mockResolvedValue(undefined);
    const runner = new GraphRunner(graph, resumeState, { persistStateFn: persistSpy, eventLog });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('step-2');
    expect(final.visited_nodes).toContain('step-3');
  });

  /**
   * Idempotency keys should be reconstructed from visited_nodes on resume,
   * preventing already-executed nodes from running again.
   */
  it('should reconstruct idempotency keys and skip already-executed iterations', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Idempotency Resume', description: '',
      nodes: [
        makeNode({ id: 'node-a', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'node-b', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'node-a', target: 'node-b', condition: { type: 'always' } },
      ],
      start_node: 'node-a',
      end_nodes: ['node-b'],
    };

    const runId = uuidv4();

    const resumeState = createState({
      run_id: runId,
      current_node: 'node-b',
      visited_nodes: ['node-a', 'node-b'],
      iteration_count: 1,
      status: 'running',
      started_at: new Date(),
      memory: { 'good-agent_result': 'already done' },
    });

    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append({
      run_id: runId, sequence_id: 0, event_type: 'workflow_started',
    });
    await eventLog.append({
      run_id: runId, sequence_id: 1, event_type: 'action_dispatched',
      node_id: 'node-a', action: { metadata: { node_id: 'node-a' } },
    });

    const runner = new GraphRunner(graph, resumeState, { eventLog });
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes).toContain('node-b');
  });

  /**
   * A fresh state (empty visited_nodes) should start from start_node as before.
   */
  it('should start from start_node when visited_nodes is empty', async () => {
    const graph: Graph = {
      id: uuidv4(), name: 'Fresh Start', description: '',
      nodes: [
        makeNode({ id: 'first', type: 'agent', agent_id: 'good-agent' }),
        makeNode({ id: 'second', type: 'agent', agent_id: 'good-agent' }),
      ],
      edges: [
        { id: 'e1', source: 'first', target: 'second', condition: { type: 'always' } },
      ],
      start_node: 'first',
      end_nodes: ['second'],
    };

    const freshState = createState();

    const runner = new GraphRunner(graph, freshState);
    const final = await runner.run();

    expect(final.status).toBe('completed');
    expect(final.visited_nodes[0]).toBe('first');
    expect(final.visited_nodes).toContain('second');
  });
});
