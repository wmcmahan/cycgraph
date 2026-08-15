import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Hoisted so `vi.mock`, which is lifted above module scope, can close over it.
const loggerCalls = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
}));
vi.mock('../src/observability/logger', () => ({
  createLogger: () => loggerCalls,
}));

vi.mock('../src/observability/tracing', () => ({
  getTracer: () => ({}),
  withSpan: (_tracer: any, _name: string, fn: (span: any) => any) => fn({ setAttribute: vi.fn() }),
  startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
  inSpanContext: (_span: any, fn: () => any) => fn(),
}));

import { WorkflowWorker } from '../src/execution/coordination/worker';
import { InMemoryWorkflowQueue } from '../src/persistence/in-memory-queue';
import { InMemoryPersistenceProvider } from '../src/persistence/in-memory';
import { InMemoryEventLogWriter } from '../src/persistence/event-log';
import { GraphRunner } from '../src/execution/engine/graph-runner';
import { StaleClaimError } from '../src/persistence/errors';
import { EventSequenceConflictError } from '../src/persistence/event-log';
import { createTestState, makeNode, createSimpleGraph } from './helpers/factories';
import type { Graph } from '../src/graph/graph';
import type { WorkflowState } from '../src/state/state';

function twoNodeGraph(): Graph {
  return {
    id: uuidv4(),
    name: 'Two Node Graph',
    nodes: [
      makeNode({ id: 'a', agent_id: 'a' }),
      makeNode({ id: 'b', agent_id: 'b' }),
    ],
    edges: [{ id: 'a->b', source: 'a', target: 'b', condition: { type: 'always' as const } }],
    start_node: 'a',
    end_nodes: ['b'],
  } as Graph;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

describe('WorkflowWorker', () => {
  let queue: InMemoryWorkflowQueue;
  let persistence: InMemoryPersistenceProvider;
  let eventLog: InMemoryEventLogWriter;
  let worker: WorkflowWorker;

  beforeEach(() => {
    queue = new InMemoryWorkflowQueue();
    persistence = new InMemoryPersistenceProvider();
    eventLog = new InMemoryEventLogWriter();
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
    vi.restoreAllMocks();
  });

  function createWorker(overrides: Record<string, any> = {}) {
    worker = new WorkflowWorker({
      queue,
      persistence,
      eventLog,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 500,
      reclaimIntervalMs: 500,
      shutdownGracePeriodMs: 2000,
      ...overrides,
    });
    return worker;
  }

  describe('constructor defaults', () => {
    it('applies default tuning knobs when only required options are given', () => {
      worker = new WorkflowWorker({ queue, persistence, eventLog });

      expect(worker.workerId).toEqual(expect.any(String));
      expect(worker.activeJobCount).toBe(0);
    });

    it('uses the provided workerId', () => {
      worker = new WorkflowWorker({ queue, persistence, eventLog, workerId: 'fixed-id' });

      expect(worker.workerId).toBe('fixed-id');
    });
  });

  describe('lifecycle events', () => {
    it('emits worker:started and worker:stopped', async () => {
      const events: string[] = [];
      const w = createWorker();
      w.on('worker:started', () => events.push('started'));
      w.on('worker:stopped', () => events.push('stopped'));

      await w.start();
      expect(events).toContain('started');

      await w.stop();
      expect(events).toContain('stopped');
    });

    it('start is idempotent when already running', async () => {
      const startedEvents: string[] = [];
      const w = createWorker();
      w.on('worker:started', () => startedEvents.push('started'));

      await w.start();
      await w.start();

      expect(startedEvents).toHaveLength(1);
    });

    it('stop is a no-op when not running', async () => {
      const w = createWorker();
      await expect(w.stop()).resolves.toBeUndefined();
    });
  });

  describe('job routing', () => {
    it('runs a start job to completion and acks it', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test goal' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:claimed', () => events.push('claimed'));
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(events).toContain('claimed');
      expect(events).toContain('completed');

      const depth = await queue.getQueueDepth();
      expect(depth.waiting).toBe(0);
      expect(depth.active).toBe(0);
    });

    it('nacks when the graph is not found', async () => {
      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: uuidv4(),
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:failed', () => events.push('failed'));

      await w.start();
      await waitFor(() => events.includes('failed'));

      const depth = await queue.getQueueDepth();
      expect(depth.waiting).toBe(1);
    });

    it('releases the job as paused on a HITL waiting result', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async function(this: GraphRunner) {
        return { ...(this as any).state, status: 'waiting' } as WorkflowState;
      });

      const jobId = await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:released', () => events.push('released'));

      await w.start();
      await waitFor(() => events.includes('released'));

      const depth = await queue.getQueueDepth();
      expect(depth.waiting).toBe(0);
      expect(depth.paused).toBe(1);

      expect(await queue.dequeue('other-worker')).toBeNull();
      expect((await queue.getJob(jobId))?.status).toBe('paused');
    });

    it('leaves a non-terminal non-waiting result active for reclaim', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const runSpy = vi.spyOn(GraphRunner.prototype, 'run')
        .mockResolvedValue({ status: 'running' } as unknown as WorkflowState);

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));
      w.on('job:released', () => events.push('released'));

      await w.start();
      await waitFor(() => runSpy.mock.calls.length > 0);
      await waitFor(() => w.activeJobCount === 0);

      expect(events).not.toContain('completed');
      expect(events).not.toContain('released');
      const depth = await queue.getQueueDepth();
      expect(depth.active).toBe(1);
    });

    it('starts fresh with an empty goal when the job has no initial_state', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      const finalState = await persistence.loadLatestWorkflowState(runId);
      expect(finalState!.goal).toBe('');
      expect(finalState!.status).toBe('completed');
    });

    it('applies the human response on a resume job', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      await eventLog.append({
        run_id: runId,
        sequence_id: 0,
        event_type: 'internal_dispatched',
        node_id: null,
        action: null,
        internal_type: '_init',
        internal_payload: {},
      });

      const applyMock = vi.fn();
      vi.spyOn(GraphRunner, 'recover').mockResolvedValue({
        run: vi.fn().mockResolvedValue({ status: 'completed' } as unknown as WorkflowState),
        applyHumanResponse: applyMock,
        shutdown: vi.fn(),
        getState: () => createTestState(),
        state: createTestState(),
      } as unknown as GraphRunner);

      const humanResponse = { decision: 'approved' as const };
      await queue.enqueue({
        type: 'resume',
        run_id: runId,
        graph_id: graph.id,
        human_response: humanResponse,
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(applyMock).toHaveBeenCalledWith(humanResponse);
    });
  });

  describe('recovery', () => {
    it('recovers via event-log replay when events exist for a start job', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      await eventLog.append({
        run_id: runId,
        sequence_id: 0,
        event_type: 'internal_dispatched',
        node_id: null,
        action: null,
        internal_type: '_init',
        internal_payload: { initial_state: {} },
      });

      const recoverSpy = vi.spyOn(GraphRunner, 'recover').mockResolvedValue({
        run: vi.fn().mockResolvedValue({ status: 'completed' } as unknown as WorkflowState),
        applyHumanResponse: vi.fn(),
        shutdown: vi.fn(),
        getState: () => createTestState(),
        state: createTestState(),
      } as unknown as GraphRunner);

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(recoverSpy).toHaveBeenCalled();
    });

    it('resumes from a snapshot when no events exist', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      await persistence.saveWorkflowSnapshot(createTestState({
        workflow_id: graph.id,
        run_id: runId,
        goal: 'test',
        status: 'running',
        current_node: 'agent-node',
        iteration_count: 4,
        memory: { seeded: 'from-snapshot' },
      }));

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      const finalState = await persistence.loadLatestWorkflowState(runId);
      expect(finalState!.memory.seeded).toBe('from-snapshot');
      expect(finalState!.status).toBe('completed');
    });

    it('resumes from the snapshot when it is ahead of the replayed event log', async () => {
      const graph = twoNodeGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      const liveState = createTestState({ workflow_id: graph.id, run_id: runId, goal: 'test' });
      await new GraphRunner(graph, liveState, { eventLog }).run();

      eventLog.getEventsForRun(runId).splice(4);

      await persistence.saveWorkflowSnapshot(createTestState({
        workflow_id: graph.id,
        run_id: runId,
        goal: 'test',
        status: 'running',
        current_node: 'b',
        visited_nodes: ['a'],
        iteration_count: 10,
        memory: { a_result: 'from-snapshot' },
      }));

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      const finalState = await persistence.loadLatestWorkflowState(runId);
      expect(finalState!.memory.a_result).toBe('from-snapshot');
      expect(finalState!.memory.b_result).toBe('Mock agent output');
      expect(finalState!.status).toBe('completed');
    });

    it('falls back to the snapshot when the event log has a gap', async () => {
      const graph = twoNodeGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      const liveState = createTestState({ workflow_id: graph.id, run_id: runId, goal: 'test' });
      await new GraphRunner(graph, liveState, { eventLog }).run();
      const events = eventLog.getEventsForRun(runId);
      expect(events.length).toBeGreaterThan(3);
      events.splice(2, 1);

      await persistence.saveWorkflowSnapshot(createTestState({
        workflow_id: graph.id,
        run_id: runId,
        goal: 'test',
        status: 'running',
        current_node: 'b',
        visited_nodes: ['a'],
        iteration_count: 10,
        memory: { a_result: 'from-snapshot' },
      }));

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const workerEvents: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => workerEvents.push('completed'));
      w.on('job:failed', () => workerEvents.push('failed'));

      await w.start();
      await waitFor(() => workerEvents.length > 0);

      expect(workerEvents).toContain('completed');
      const finalState = await persistence.loadLatestWorkflowState(runId);
      expect(finalState!.memory.a_result).toBe('from-snapshot');
      expect(finalState!.status).toBe('completed');
    });

    it('nacks when the event log is corrupt and no snapshot exists', async () => {
      const graph = twoNodeGraph();
      await persistence.saveGraph(graph);

      const runId = uuidv4();
      const liveState = createTestState({ workflow_id: graph.id, run_id: runId, goal: 'test' });
      await new GraphRunner(graph, liveState, { eventLog }).run();
      const events = eventLog.getEventsForRun(runId);
      events.splice(2, 1);

      await queue.enqueue({ type: 'start', run_id: runId, graph_id: graph.id });

      const workerEvents: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => workerEvents.push('completed'));
      w.on('job:failed', () => workerEvents.push('failed'));

      await w.start();
      await waitFor(() => workerEvents.length > 0);

      expect(workerEvents).toContain('failed');
    });

    it('continues past a snapshot that fails to load', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(persistence, 'loadLatestWorkflowState')
        .mockRejectedValue(new Error('snapshot store down'));

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(events).toContain('completed');
    });
  });

  describe('failure handling', () => {
    it('nacks a failed run and emits job:failed', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run').mockRejectedValueOnce(new Error('boom'));

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const errors: string[] = [];
      const w = createWorker();
      w.on('job:failed', (e) => errors.push(e.error));

      await w.start();
      await waitFor(() => errors.length > 0);

      expect(errors[0]).toBe('boom');
    });

    it('stringifies a thrown non-Error rejection', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run').mockRejectedValueOnce('plain string failure');

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const errors: string[] = [];
      const w = createWorker();
      w.on('job:failed', (e) => errors.push(e.error));

      await w.start();
      await waitFor(() => errors.length > 0);

      expect(errors[0]).toBe('plain string failure');
    });

    it('dead-letters a job after max_attempts', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run').mockRejectedValue(new Error('persistent failure'));

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
        max_attempts: 1,
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:dead_letter', () => events.push('dead_letter'));

      await w.start();
      await waitFor(() => events.includes('dead_letter'));

      const depth = await queue.getQueueDepth();
      expect(depth.dead_letter).toBe(1);
    });

    it('emits job:claim_lost without nacking on a StaleClaimError', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run')
        .mockRejectedValue(new StaleClaimError(uuidv4(), 1, 2));
      const nackSpy = vi.spyOn(queue, 'nack');

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:claim_lost', () => events.push('claim_lost'));

      await w.start();
      await waitFor(() => events.includes('claim_lost'));

      expect(nackSpy).not.toHaveBeenCalled();
    });

    it('emits job:claim_lost without nacking on an EventSequenceConflictError', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run')
        .mockRejectedValue(new EventSequenceConflictError(uuidv4(), 3));
      const nackSpy = vi.spyOn(queue, 'nack');

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:claim_lost', () => events.push('claim_lost'));

      await w.start();
      await waitFor(() => events.includes('claim_lost'));

      expect(nackSpy).not.toHaveBeenCalled();
    });

    it('swallows a nack failure after a run error', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(GraphRunner.prototype, 'run').mockRejectedValue(new Error('boom'));
      vi.spyOn(queue, 'nack').mockRejectedValue(new Error('nack store down'));

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const w = createWorker();
      await w.start();
      await waitFor(() => (queue.nack as any).mock.calls.length > 0);

      expect(w.activeJobCount).toBe(0);
    });

    it('recovers the poll loop when dequeue throws', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const realDequeue = queue.dequeue.bind(queue);
      let threw = false;
      vi.spyOn(queue, 'dequeue').mockImplementation(async (workerId: string) => {
        if (!threw) {
          threw = true;
          throw new Error('dequeue store hiccup');
        }
        return realDequeue(workerId);
      });

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker();
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(threw).toBe(true);
      expect(events).toContain('completed');
    });
  });

  describe('heartbeat and reclaim timers', () => {
    it('heartbeats during a long-running job', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      const heartbeatSpy = vi.spyOn(queue, 'heartbeat');
      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 700));
        return { status: 'completed' } as unknown as WorkflowState;
      });

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker({ heartbeatIntervalMs: 100 });
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(heartbeatSpy).toHaveBeenCalled();
    });

    it('swallows heartbeat errors during a long-running job', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      vi.spyOn(queue, 'heartbeat').mockRejectedValue(new Error('heartbeat store down'));
      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 400));
        return { status: 'completed' } as unknown as WorkflowState;
      });

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const events: string[] = [];
      const w = createWorker({ heartbeatIntervalMs: 100 });
      w.on('job:completed', () => events.push('completed'));

      await w.start();
      await waitFor(() => events.includes('completed'));

      expect(events).toContain('completed');
    });

    it('fires the reclaim timer periodically', async () => {
      const reclaimSpy = vi.spyOn(queue, 'reclaimExpired');

      const w = createWorker({ reclaimIntervalMs: 100 });
      await w.start();

      await waitFor(() => reclaimSpy.mock.calls.length >= 2, 3000);

      expect(reclaimSpy).toHaveBeenCalled();
    });

    it('logs when the reclaim timer returns reclaimed jobs', async () => {
      const reclaimSpy = vi.spyOn(queue, 'reclaimExpired').mockResolvedValue(2);

      const w = createWorker({ reclaimIntervalMs: 100 });
      await w.start();

      await waitFor(() => reclaimSpy.mock.calls.length >= 1, 3000);

      expect(reclaimSpy).toHaveBeenCalled();
    });

    it('keeps running when the reclaim timer throws', async () => {
      const reclaimSpy = vi.spyOn(queue, 'reclaimExpired')
        .mockRejectedValue(new Error('reclaim store down'));

      const w = createWorker({ reclaimIntervalMs: 100 });
      await w.start();

      await waitFor(() => reclaimSpy.mock.calls.length >= 2, 3000);

      const events: string[] = [];
      w.on('worker:stopped', () => events.push('stopped'));
      await w.stop();
      expect(events).toContain('stopped');
    });
  });

  describe('shutdown', () => {
    it('finishes in-flight work within the grace period', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      let resolveRun: (() => void) | null = null;
      let runStarted = false;
      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async () => {
        runStarted = true;
        await new Promise<void>(r => { resolveRun = r; });
        return { status: 'completed' } as unknown as WorkflowState;
      });
      const shutdownSpy = vi.spyOn(GraphRunner.prototype, 'shutdown');

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const w = createWorker();
      await w.start();
      await waitFor(() => runStarted);

      const stopPromise = w.stop();
      expect(shutdownSpy).toHaveBeenCalled();

      resolveRun?.();
      await stopPromise;

      expect(w.activeJobCount).toBe(0);
    });

    it('cancels a runner that outlives the grace period', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      let runStarted = false;
      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async () => {
        runStarted = true;
        await new Promise<void>(() => {});
        return { status: 'completed' } as unknown as WorkflowState;
      });
      const cancelSpy = vi.spyOn(GraphRunner.prototype, 'cancel').mockImplementation(() => {});

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const w = createWorker({ shutdownGracePeriodMs: 50 });
      await w.start();
      await waitFor(() => runStarted);

      await w.stop();

      expect(cancelSpy).toHaveBeenCalled();
      expect(w.activeJobCount).toBe(0);
    });

    it('shuts down cleanly when a job is claimed but its runner is not yet built', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      let loadStarted = false;
      vi.spyOn(persistence, 'loadGraph').mockImplementation(async () => {
        loadStarted = true;
        await new Promise<void>(() => {});
        return graph;
      });
      const cancelSpy = vi.spyOn(GraphRunner.prototype, 'cancel');

      await queue.enqueue({
        type: 'start',
        run_id: uuidv4(),
        graph_id: graph.id,
        initial_state: { goal: 'test' },
      });

      const w = createWorker({ shutdownGracePeriodMs: 50 });
      await w.start();
      await waitFor(() => loadStarted);

      await w.stop();

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(w.activeJobCount).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('respects the concurrency limit', async () => {
      const graph = createSimpleGraph();
      await persistence.saveGraph(graph);

      let activeCount = 0;
      let maxActive = 0;
      vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(r => setTimeout(r, 200));
        activeCount--;
        return { status: 'completed' } as unknown as WorkflowState;
      });

      for (let i = 0; i < 3; i++) {
        await queue.enqueue({
          type: 'start',
          run_id: uuidv4(),
          graph_id: graph.id,
          initial_state: { goal: `test-${i}` },
        });
      }

      const completed: string[] = [];
      const w = createWorker({ concurrency: 1 });
      w.on('job:completed', () => completed.push('done'));

      await w.start();
      await waitFor(() => completed.length === 3, 10000);

      expect(maxActive).toBe(1);
    });
  });
});


describe('WorkflowWorker error logging', () => {
  it('passes the thrown error to the logger rather than the context object', async () => {
    loggerCalls.error.mockClear();

    const failure = new Error('graph load exploded');
    const queue = new InMemoryWorkflowQueue();
    await queue.enqueue({ type: 'start', run_id: uuidv4(), graph_id: uuidv4() });

    const persistence = new InMemoryPersistenceProvider();
    persistence.loadGraph = async () => { throw failure; };

    const worker = new WorkflowWorker({
      queue,
      persistence,
      eventLog: new InMemoryEventLogWriter(),
      pollIntervalMs: 5,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.stop();

    const call = loggerCalls.error.mock.calls.find((c) => c[0] === 'job_processing_error');
    expect(call).toBeDefined();
    expect(call![1]).toBe(failure);
    expect(call![2]).toMatchObject({ run_id: expect.any(String) });
  });
});
