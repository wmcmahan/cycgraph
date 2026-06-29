import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks ────────────────────────────────────────────────────────

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
import { InMemoryEventLogWriter } from '../src/db/event-log.js';
import type { Graph } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

const createState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'HITL test',
  constraints: [],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: { draft: 'some content' },
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const createHITLGraph = (rejectionNodeId?: string): Graph => ({
  id: 'hitl-graph',
  name: 'HITL Test',
  description: 'Test human-in-the-loop',
  nodes: [
    {
      id: 'agent1',
      type: 'agent',
      agent_id: 'writer',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approval_config: {
        approval_type: 'human_review',
        prompt_message: 'Please review the draft.',
        review_keys: ['draft'],
        timeout_ms: 60000,
        rejection_node_id: rejectionNodeId,
      },
      read_keys: ['*'],
      write_keys: ['*', 'control_flow'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    {
      id: 'publish',
      type: 'agent',
      agent_id: 'publisher',
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    },
    ...(rejectionNodeId ? [{
      id: rejectionNodeId,
      type: 'agent' as const,
      agent_id: 'reviser',
      read_keys: ['*'] as string[],
      write_keys: ['*'] as string[],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 100, max_backoff_ms: 100 },
      requires_compensation: false,
    }] : []),
  ],
  edges: [
    { id: 'e1', source: 'agent1', target: 'review', condition: { type: 'always' as const } },
    { id: 'e2', source: 'review', target: 'publish', condition: { type: 'always' as const } },
    ...(rejectionNodeId ? [
      { id: 'e3', source: rejectionNodeId, target: 'review', condition: { type: 'always' as const } },
    ] : []),
  ],
  start_node: 'agent1',
  end_nodes: ['publish', ...(rejectionNodeId ? [rejectionNodeId] : [])],
});

// ─── Tests ────────────────────────────────────────────────────────

describe('Human-in-the-Loop', () => {
  test('approval node should pause workflow with waiting status', async () => {
    const graph = createHITLGraph();
    const state = createState();
    const persist = vi.fn();

    const runner = new GraphRunner(graph, state, { persistStateFn: persist });
    const finalState = await runner.run();

    expect(finalState.status).toBe('waiting');
    expect(finalState.waiting_for).toBe('human_approval');
    expect(finalState.memory._pending_approval).toBeDefined();
    expect((finalState.memory._pending_approval as any).prompt_message).toBe('Please review the draft.');
  });

  test('approval node should include review data in pending approval', async () => {
    const graph = createHITLGraph();
    const state = createState();
    state.memory.draft = 'review this content';

    const runner = new GraphRunner(graph, state);
    const finalState = await runner.run();

    const pending = finalState.memory._pending_approval as any;
    expect(pending.review_data.draft).toBe('review this content');
  });

  test('should emit workflow:waiting event', async () => {
    const graph = createHITLGraph();
    const state = createState();
    const waitingHandler = vi.fn();

    const runner = new GraphRunner(graph, state);
    runner.on('workflow:waiting', waitingHandler);
    await runner.run();

    expect(waitingHandler).toHaveBeenCalledWith(
      expect.objectContaining({ waiting_for: 'human_approval' })
    );
  });

  test('applyHumanResponse with approval should resume workflow', async () => {
    const graph = createHITLGraph();
    const state = createState();
    const eventLog = new InMemoryEventLogWriter();

    // First run: pause at approval
    const runner1 = new GraphRunner(graph, state, { eventLog });
    const pausedState = await runner1.run();
    expect(pausedState.status).toBe('waiting');

    // Resume with approval (share the same event log)
    const runner2 = new GraphRunner(graph, { ...pausedState }, { eventLog });
    runner2.applyHumanResponse({ decision: 'approved', data: 'LGTM' });

    const resumedState = await runner2.run();
    expect(resumedState.status).toBe('completed');
    expect(resumedState.memory.human_decision).toBe('approved');
    expect(resumedState.memory.human_response).toBe('LGTM');
  });

  test('applyHumanResponse with rejection should route to rejection node', async () => {
    const graph = createHITLGraph('revise');
    const state = createState();
    const eventLog = new InMemoryEventLogWriter();

    // First run: pause at approval
    const runner1 = new GraphRunner(graph, state, { eventLog });
    const pausedState = await runner1.run();
    expect(pausedState.status).toBe('waiting');

    // Resume with rejection (share the same event log)
    const runner2 = new GraphRunner(graph, { ...pausedState }, { eventLog });
    runner2.applyHumanResponse({ decision: 'rejected', data: 'Needs work' });

    const resumedState = await runner2.run();
    // Should have routed to the rejection node
    expect(resumedState.visited_nodes).toContain('revise');
    expect(resumedState.memory.human_decision).toBe('rejected');
  });

  test('rejection without a rejection node halts the run (cancelled)', async () => {
    const graph = createHITLGraph(); // no rejection_node_id
    const state = createState();
    const eventLog = new InMemoryEventLogWriter();

    const runner1 = new GraphRunner(graph, state, { eventLog });
    const pausedState = await runner1.run();
    expect(pausedState.status).toBe('waiting');

    const runner2 = new GraphRunner(graph, { ...pausedState }, { eventLog });
    runner2.applyHumanResponse({ decision: 'rejected', data: 'No' });
    const resumedState = await runner2.run();

    // The gated node must NOT have executed, and the run ends terminally.
    expect(resumedState.status).toBe('cancelled');
    expect(resumedState.visited_nodes).not.toContain('publish');
    expect(resumedState.memory.human_decision).toBe('rejected');
  });

  test('applyHumanResponse should clear pending approval', async () => {
    const graph = createHITLGraph();
    const state = createState();
    const eventLog = new InMemoryEventLogWriter();

    const runner1 = new GraphRunner(graph, state, { eventLog });
    const pausedState = await runner1.run();

    const runner2 = new GraphRunner(graph, { ...pausedState }, { eventLog });
    runner2.applyHumanResponse({ decision: 'approved' });

    const resumedState = await runner2.run();
    expect(resumedState.memory._pending_approval).toBeUndefined();
  });

  test('applyHumanResponse with memory_updates should merge them', async () => {
    const graph = createHITLGraph();
    const state = createState();
    const eventLog = new InMemoryEventLogWriter();

    const runner1 = new GraphRunner(graph, state, { eventLog });
    const pausedState = await runner1.run();

    const runner2 = new GraphRunner(graph, { ...pausedState }, { eventLog });
    runner2.applyHumanResponse({
      decision: 'edited',
      data: 'Updated draft',
      memory_updates: { draft: 'edited content', reviewer_notes: 'Fixed typo' },
    });

    const resumedState = await runner2.run();
    expect(resumedState.memory.draft).toBe('edited content');
    expect(resumedState.memory.reviewer_notes).toBe('Fixed typo');
  });

  test('approval node should error without approval_config', async () => {
    const graph: Graph = {
      id: 'bad-graph',
      name: 'Bad',
      description: 'Missing config',
      nodes: [{
        id: 'bad-approval',
        type: 'approval',
        read_keys: ['*'],
        write_keys: ['*', 'control_flow'],
        failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 100, max_backoff_ms: 100 },
        requires_compensation: false,
        // No approval_config!
      }],
      edges: [],
      start_node: 'bad-approval',
      end_nodes: ['bad-approval'],
    };

    const state = createState();
    const runner = new GraphRunner(graph, state);

    await expect(runner.run()).rejects.toThrow('missing approval_config');
  });
});
