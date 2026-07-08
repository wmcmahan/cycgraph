/**
 * durable-replay.test.ts
 *
 * Tests for event sourcing (write path) and deterministic replay (recovery path).
 * Verifies that the event log captures all significant state transitions and
 * that GraphRunner.recover() can reconstruct pre-crash state from events alone.
 */
import { describe, test, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// ─── Mocks (must be before any imports that use them) ───────────────

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn((model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn((model: string) => ({ provider: 'anthropic', modelId: model })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
  tool: vi.fn((def: unknown) => def),
  jsonSchema: vi.fn((s: unknown) => s),
  Output: { object: vi.fn((o: unknown) => o) },
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

/**
 * Agent executor mock: returns update_memory actions based on agent_id.
 * Default behavior: writes { [agentId]_result: 'done' }.
 */
vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: `${agentId}:mock:${attempt}`,
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'done' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor/executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/evaluator-executor/executor', () => ({
  evaluateQualityExecutor: vi.fn(),
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

vi.mock('../src/utils/taint', () => ({
  getTaintRegistry: vi.fn().mockReturnValue({}),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { GraphRunner } from '../src/runner/graph-runner.js';
import { InMemoryEventLogWriter, EventSequenceConflictError } from '../src/db/event-log.js';
import { REPLAY_VERSION } from '../src/reducers/index.js';
import { hydrateWorkflowState } from '../src/types/state.js';
import { executeAgent } from '../src/agent/agent-executor/executor.js';
import type { Graph, GraphNode, GraphEdge } from '../src/types/graph.js';
import type { WorkflowState } from '../src/types/state.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeNode(id: string, type: GraphNode['type'] = 'agent'): GraphNode {
  return {
    id,
    type,
    agent_id: id,
    read_keys: ['*'],
    write_keys: ['*'],
    failure_policy: { max_retries: 1, backoff_strategy: 'fixed' as const, initial_backoff_ms: 10, max_backoff_ms: 10 },
  };
}

function makeEdge(source: string, target: string): GraphEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    condition: { type: 'always' as const },
  };
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: uuidv4(),
    run_id: uuidv4(),
    status: 'pending' as const,
    goal: 'test goal',
    constraints: [],
    memory: {},
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    total_tokens_used: 0,
    visited_nodes: [],
    max_iterations: 50,
    max_execution_time_ms: 3600000,
    compensation_stack: [],
    supervisor_history: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Durable Execution — Event Sourcing', () => {

  describe('Event Logging (Write Path)', () => {
    test('should append events during a normal 2-node run', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'simple',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      const result = await runner.run();
      expect(result.status).toBe('completed');

      const events = eventLog.getEventsForRun(state.run_id);

      // Should have multiple events for a 2-node run
      expect(events.length).toBeGreaterThan(5);

      // Verify core event types present
      const types = events.map(e => e.event_type);
      expect(types).toContain('workflow_started');
      expect(types).toContain('node_started');
      expect(types).toContain('action_dispatched');
      expect(types).toContain('internal_dispatched');

      // Verify action_dispatched events contain full Actions
      const actionEvents = events.filter(e => e.event_type === 'action_dispatched');
      expect(actionEvents).toHaveLength(2);
      expect(actionEvents[0].action?.type).toBe('update_memory');
      expect(actionEvents[1].action?.type).toBe('update_memory');

      // Sequence IDs are monotonically increasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence_id).toBeGreaterThan(events[i - 1].sequence_id);
      }
    });

    test('should preserve event ordering across nodes', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'three-node',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      // node_started events should be in execution order
      const nodeStartEvents = eventLog
        .getEventsForRun(state.run_id)
        .filter(e => e.event_type === 'node_started');

      expect(nodeStartEvents.map(e => e.node_id)).toEqual(['a', 'b', 'c']);
    });

    test('should capture internal dispatch events', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'single',
        nodes: [makeNode('only')],
        edges: [],
        start_node: 'only',
        end_nodes: ['only'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      const internalEvents = eventLog
        .getEventsForRun(state.run_id)
        .filter(e => e.event_type === 'internal_dispatched');

      const internalTypes = internalEvents.map(e => e.internal_type);
      expect(internalTypes).toContain('_init');
      expect(internalTypes).toContain('_complete');
      expect(internalTypes).toContain('_increment_iteration');
    });
  });

  describe('Recovery (Replay Path)', () => {
    test('should recover completed workflow state from event log', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'recoverable',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      // Run to completion, capturing events
      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();
      expect(result1.status).toBe('completed');

      // Recover from events only — no state snapshot
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);

      // Recovered state should match completed state
      const recovered = runner2['state'] as WorkflowState;
      expect(recovered.status).toBe('completed');
      expect(recovered.visited_nodes).toEqual(result1.visited_nodes);
      expect(recovered.iteration_count).toBe(result1.iteration_count);
      // Memory should contain the agent outputs
      expect(recovered.memory).toEqual(result1.memory);
    });

    test('recovery from event log (no checkpoint) preserves run limits/config', async () => {
      // Regression: without a checkpoint, recover() used to seed default limits
      // (no token budget, max_iterations 50, empty goal), silently disabling
      // budget/iteration/timeout enforcement after a crash. The limits are now
      // persisted in the workflow_started event and restored on replay.
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'limited',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({
        workflow_id: graph.id,
        goal: 'a specific goal',
        constraints: ['stay under budget'],
        max_iterations: 7,
        max_execution_time_ms: 123_000,
        max_retries: 2,
        max_token_budget: 1000,
        budget_usd: 5,
      });

      const runner1 = new GraphRunner(graph, state, { eventLog });
      await runner1.run();

      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      const recovered = runner2['state'] as WorkflowState;

      expect(recovered.max_token_budget).toBe(1000);
      expect(recovered.budget_usd).toBe(5);
      expect(recovered.max_iterations).toBe(7);
      expect(recovered.max_execution_time_ms).toBe(123_000);
      expect(recovered.max_retries).toBe(2);
      expect(recovered.goal).toBe('a specific goal');
      expect(recovered.constraints).toEqual(['stay under budget']);
    });

    test('should recover 3-node workflow with correct memory accumulation', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'three-step',
        nodes: [makeNode('step1'), makeNode('step2'), makeNode('step3')],
        edges: [makeEdge('step1', 'step2'), makeEdge('step2', 'step3')],
        start_node: 'step1',
        end_nodes: ['step3'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();
      expect(result1.status).toBe('completed');

      // Each node writes {agentId_result: 'done'}, so memory should have 3 keys
      expect(result1.memory).toEqual({
        step1_result: 'done',
        step2_result: 'done',
        step3_result: 'done',
      });

      // Recover and verify identical state
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      const recovered = runner2['state'] as WorkflowState;
      expect(recovered.memory).toEqual(result1.memory);
      expect(recovered.visited_nodes).toEqual(['step1', 'step2', 'step3']);
    });

    test('should throw on empty event log', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'empty',
        nodes: [makeNode('start')],
        edges: [],
        start_node: 'start',
        end_nodes: ['start'],
      };

      await expect(
        GraphRunner.recover(graph, 'nonexistent-run', eventLog)
      ).rejects.toThrow(/corrupted or incomplete/);
    });

    test('should continue sequence_id after recovery', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'seq-check',
        nodes: [makeNode('only')],
        edges: [],
        start_node: 'only',
        end_nodes: ['only'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner1 = new GraphRunner(graph, state, { eventLog });
      await runner1.run();

      const eventsBefore = eventLog.getEventsForRun(state.run_id);
      const maxSeqBefore = Math.max(...eventsBefore.map(e => e.sequence_id));

      // Recover — sequenceId should be set past all replayed events
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      // The recovered runner's sequenceId is internal, but we can verify by
      // checking that calling getEventLog() works
      expect(runner2.getEventLog()).toBe(eventLog);
      expect(runner2['sequenceId']).toBe(maxSeqBefore + 1);
    });
  });

  describe('Event log integrity', () => {
    test('recovery throws EventLogCorruptionError on a sequence gap', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'gap-detect',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      // Simulate a lost append: remove an event from the middle of the log.
      const events = eventLog.getEventsForRun(state.run_id);
      expect(events.length).toBeGreaterThan(4);
      events.splice(3, 1);

      await expect(
        GraphRunner.recover(graph, state.run_id, eventLog),
      ).rejects.toThrow(/corrupted or incomplete/);
    });

    test('append rejects duplicate (run_id, sequence_id) with EventSequenceConflictError', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const runId = uuidv4();

      await eventLog.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await expect(
        eventLog.append({ run_id: runId, sequence_id: 0, event_type: 'node_started', node_id: 'x' }),
      ).rejects.toBeInstanceOf(EventSequenceConflictError);
    });

    test('run halts after three consecutive failed event-log flushes', async () => {
      // Event log whose appends always fail (e.g. DB down) but isn't a Noop —
      // the runner must halt instead of silently losing its durable history.
      const failingLog = new InMemoryEventLogWriter();
      failingLog.append = async () => {
        throw new Error('db down');
      };

      const graph: Graph = {
        id: uuidv4(),
        name: 'flush-halt',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'd')],
        start_node: 'a',
        end_nodes: ['d'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog: failingLog });
      await expect(runner.run()).rejects.toThrow(/Event log unavailable/);
    });

    test('a sequence conflict during execution is fatal (split-brain guard)', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'conflict-fatal',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      // Simulate a second writer racing on the same run: pre-claim a
      // sequence id this runner will try to use.
      await eventLog.append({ run_id: state.run_id, sequence_id: 4, event_type: 'node_started', node_id: 'intruder' });

      const runner = new GraphRunner(graph, state, { eventLog });
      await expect(runner.run()).rejects.toThrow(/another writer/);
    });
  });

  describe('Idempotency — crash-window resume', () => {
    /**
     * Simulate a crash in the post-reduce/pre-advance window: the snapshot
     * persisted right after node a's action contains the action's effects
     * while current_node still points at a. Resuming that snapshot must NOT
     * re-execute a (no duplicate LLM spend, no double-applied action).
     */
    async function runAndCaptureSnapshots() {
      const eventLog = new InMemoryEventLogWriter();
      const snapshots: WorkflowState[] = [];
      const graph: Graph = {
        id: uuidv4(),
        name: 'crash-window',
        nodes: [makeNode('a'), makeNode('b')],
        edges: [makeEdge('a', 'b')],
        start_node: 'a',
        end_nodes: ['b'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, {
        eventLog,
        persistStateFn: async (s) => {
          // Simulate real storage: JSON round-trip like a jsonb column.
          snapshots.push(JSON.parse(JSON.stringify(s)));
        },
      });
      await runner.run();
      return { eventLog, snapshots, graph, state };
    }

    test('resume after post-reduce/pre-advance crash skips the applied node', async () => {
      const { eventLog, snapshots, graph } = await runAndCaptureSnapshots();

      // The post-a-action, pre-advance snapshot: a's output is in memory but
      // current_node hasn't moved yet.
      const crashSnapshot = snapshots.find(
        s => s.current_node === 'a' && (s.memory as Record<string, unknown>).a_result === 'done',
      );
      expect(crashSnapshot).toBeDefined();

      const callsBefore = vi.mocked(executeAgent).mock.calls.length;
      const resumed = new GraphRunner(graph, hydrateWorkflowState(crashSnapshot), { eventLog });
      const result = await resumed.run();

      expect(result.status).toBe('completed');
      expect(result.memory.a_result).toBe('done');
      expect(result.memory.b_result).toBe('done');

      // Only node b executed on resume — a's action was already applied.
      const resumeCalls = vi.mocked(executeAgent).mock.calls.slice(callsBefore);
      expect(resumeCalls.map(c => c[0])).toEqual(['b']);
    });

    test('resume from a pre-action snapshot re-executes the node (at-least-once)', async () => {
      const { eventLog, snapshots, graph } = await runAndCaptureSnapshots();

      // The earliest snapshot: _init applied, node a not yet executed.
      const preActionSnapshot = snapshots.find(
        s => s.current_node === 'a' && (s.memory as Record<string, unknown>).a_result === undefined,
      );
      expect(preActionSnapshot).toBeDefined();

      const callsBefore = vi.mocked(executeAgent).mock.calls.length;
      const resumed = new GraphRunner(graph, hydrateWorkflowState(preActionSnapshot), { eventLog });
      const result = await resumed.run();

      expect(result.status).toBe('completed');
      // a's effects were NOT in the snapshot, so a must re-execute.
      const resumeCalls = vi.mocked(executeAgent).mock.calls.slice(callsBefore);
      expect(resumeCalls.map(c => c[0])).toEqual(['a', 'b']);
    });
  });

  describe('InMemoryEventLogWriter', () => {
    test('should store and retrieve events in sequence_id order', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const runId = uuidv4();

      await eventLog.append({ run_id: runId, sequence_id: 2, event_type: 'node_started', node_id: 'b' });
      await eventLog.append({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: runId, sequence_id: 1, event_type: 'node_started', node_id: 'a' });

      const events = await eventLog.loadEvents(runId);
      expect(events.map(e => e.sequence_id)).toEqual([0, 1, 2]);
    });

    test('should return -1 for latest sequence_id of unknown run', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const seq = await eventLog.getLatestSequenceId('unknown');
      expect(seq).toBe(-1);
    });

    test('should isolate events by run_id', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const run1 = uuidv4();
      const run2 = uuidv4();

      await eventLog.append({ run_id: run1, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: run2, sequence_id: 0, event_type: 'workflow_started' });
      await eventLog.append({ run_id: run1, sequence_id: 1, event_type: 'node_started', node_id: 'a' });

      expect((await eventLog.loadEvents(run1)).length).toBe(2);
      expect((await eventLog.loadEvents(run2)).length).toBe(1);
    });

    test('should clear all events', async () => {
      const eventLog = new InMemoryEventLogWriter();
      await eventLog.append({ run_id: uuidv4(), sequence_id: 0, event_type: 'workflow_started' });
      eventLog.clear();
      expect((await eventLog.loadEvents('any')).length).toBe(0);
    });
  });

  describe('Compaction', () => {
    test('should compact events after workflow completion', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'compactable',
        nodes: [makeNode('start'), makeNode('end')],
        edges: [makeEdge('start', 'end')],
        start_node: 'start',
        end_nodes: ['end'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      const eventsBefore = eventLog.getEventsForRun(state.run_id);
      expect(eventsBefore.length).toBeGreaterThan(5);

      // Compact all events
      const deleted = await runner.compactEvents();
      expect(deleted).toBe(eventsBefore.length);

      // Events should be gone
      const eventsAfter = eventLog.getEventsForRun(state.run_id);
      expect(eventsAfter.length).toBe(0);

      // Checkpoint should exist
      const checkpoint = await eventLog.loadCheckpoint(state.run_id);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.state.status).toBe('completed');
    });

    test('should recover from checkpoint after compaction', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'compact-recover',
        nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
        start_node: 'a',
        end_nodes: ['c'],
      };
      const state = makeState({ workflow_id: graph.id });

      // Run to completion
      const runner1 = new GraphRunner(graph, state, { eventLog });
      const result1 = await runner1.run();

      // Compact all events
      await runner1.compactEvents();

      // Recover — should use checkpoint, not events
      const runner2 = await GraphRunner.recover(graph, state.run_id, eventLog);
      const recovered = runner2['state'] as WorkflowState;

      expect(recovered.status).toBe('completed');
      expect(recovered.memory).toEqual(result1.memory);
      expect(recovered.visited_nodes).toEqual(result1.visited_nodes);
    });

    test('should compact and load only events after checkpoint', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const runId = uuidv4();

      // Simulate a 6-event log
      for (let i = 0; i < 6; i++) {
        await eventLog.append({
          run_id: runId,
          sequence_id: i,
          event_type: 'node_started',
          node_id: `node-${i}`,
        });
      }

      // Checkpoint at sequence 3
      const mockState = makeState({ run_id: runId });
      await eventLog.checkpoint(runId, 3, mockState);

      // Compact events <= 3
      const deleted = await eventLog.compact(runId, 3);
      expect(deleted).toBe(4); // events 0,1,2,3

      // Only events 4,5 remain
      const remaining = eventLog.getEventsForRun(runId);
      expect(remaining.length).toBe(2);
      expect(remaining.map(e => e.sequence_id)).toEqual([4, 5]);

      // loadEventsAfter should also return only 4,5
      const after = await eventLog.loadEventsAfter(runId, 3);
      expect(after.map(e => e.sequence_id)).toEqual([4, 5]);
    });

    test('workflow_started event carries the reducer replay version', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'versioned',
        nodes: [makeNode('only')],
        edges: [],
        start_node: 'only',
        end_nodes: ['only'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      await runner.run();

      const started = eventLog
        .getEventsForRun(state.run_id)
        .find(e => e.event_type === 'workflow_started');
      expect(started?.internal_payload?.replay_version).toBe(REPLAY_VERSION);
    });

    test('applyHumanResponse appends resume_from_human to the event log', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'hitl',
        nodes: [makeNode('gate'), makeNode('after')],
        edges: [makeEdge('gate', 'after')],
        start_node: 'gate',
        end_nodes: ['after'],
      };
      const state = makeState({
        workflow_id: graph.id,
        status: 'waiting',
        waiting_for: 'human_approval',
        current_node: 'gate',
        visited_nodes: ['gate'],
        memory: { _pending_approval: { node_id: 'gate' } },
      });

      const runner = new GraphRunner(graph, state, { eventLog });
      runner.applyHumanResponse({ decision: 'approved', data: { note: 'lgtm' } });
      // The resume events are deferred until execution — they land once the
      // resume path has advanced sequenceId past the run's existing log.
      await runner.run();

      const events = eventLog.getEventsForRun(state.run_id);
      const resume = events.find(
        e => e.event_type === 'action_dispatched' && e.action?.type === 'resume_from_human',
      );
      expect(resume).toBeDefined();

      // The human decision must precede the _advance so replay applies them
      // in the same order as the live run.
      const advance = events.find(
        e => e.event_type === 'internal_dispatched' && e.internal_type === '_advance',
      );
      expect(advance).toBeDefined();
      expect(resume!.sequence_id).toBeLessThan(advance!.sequence_id);
    });

    test('compactEvents() on fresh runner (no events) returns 0', async () => {
      const eventLog = new InMemoryEventLogWriter();
      const graph: Graph = {
        id: uuidv4(),
        name: 'empty',
        nodes: [makeNode('start')],
        edges: [],
        start_node: 'start',
        end_nodes: ['start'],
      };
      const state = makeState({ workflow_id: graph.id });

      const runner = new GraphRunner(graph, state, { eventLog });
      const deleted = await runner.compactEvents();
      expect(deleted).toBe(0);
    });
  });
});
