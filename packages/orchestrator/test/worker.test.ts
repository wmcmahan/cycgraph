import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('../src/agent/agent-executor/executor', () => ({
  executeAgent: vi.fn(async (agentId: string, _stateView: any, _tools: any, attempt: number) => ({
    id: uuidv4(),
    idempotency_key: uuidv4(),
    type: 'update_memory',
    payload: { updates: { [`${agentId}_result`]: 'Mock agent output' } },
    metadata: { node_id: agentId, agent_id: agentId, timestamp: new Date(), attempt },
  })),
}));

vi.mock('../src/agent/supervisor-executor', () => ({
  executeSupervisor: vi.fn(),
}));

vi.mock('../src/agent/agent-factory', () => ({
  agentFactory: {
    loadAgent: vi.fn().mockResolvedValue({
      id: 'test-agent', name: 'Test', model: 'claude-sonnet-4-6', provider: 'anthropic',
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

// ─── Imports ────────────────────────────────────────────────────────

import { WorkflowWorker } from '../src/runner/worker';
import { InMemoryWorkflowQueue } from '../src/persistence/in-memory-queue';
import { InMemoryPersistenceProvider } from '../src/persistence/in-memory';
import { InMemoryEventLogWriter } from '../src/db/event-log';
import { GraphRunner } from '../src/runner/graph-runner';
import { createTestState, makeNode } from './helpers/factories';
import type { Graph } from '../src/types/graph';
import type { WorkflowState } from '../src/types/state';

// ─── Helpers ────────────────────────────────────────────────────────

function createSimpleGraph(id?: string): Graph {
  const graphId = id ?? uuidv4();
  return {
    id: graphId,
    name: 'Test Graph',
    description: 'Simple test graph',
    nodes: [
      makeNode({ id: 'agent-node', agent_id: 'test-agent' }),
    ],
    edges: [],
    start_node: 'agent-node',
    end_nodes: ['agent-node'],
  } as Graph;
}

/** Wait until a condition is met or timeout. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

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
  });

  function createWorker(overrides: Partial<Parameters<typeof WorkflowWorker.prototype.start>[0]> & Record<string, any> = {}) {
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

  test('happy path: start → completed → ack', async () => {
    const graph = createSimpleGraph();
    await persistence.saveGraph(graph);

    const runId = uuidv4();
    await queue.enqueue({
      type: 'start',
      run_id: runId,
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

  test('graph not found → nack', async () => {
    const runId = uuidv4();
    await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: uuidv4(), // non-existent
    });

    const events: string[] = [];
    const w = createWorker();
    w.on('job:failed', () => events.push('failed'));

    await w.start();
    await waitFor(() => events.includes('failed'));

    const depth = await queue.getQueueDepth();
    // nack returns to waiting since attempt < max_attempts
    expect(depth.waiting).toBe(1);
  });

  test('HITL: start → waiting → release (paused, not re-claimable)', async () => {
    const graph = createSimpleGraph();
    await persistence.saveGraph(graph);

    // Mock the runner to return waiting status
    const originalRun = GraphRunner.prototype.run;
    const runSpy = vi.spyOn(GraphRunner.prototype, 'run').mockImplementation(async function(this: GraphRunner) {
      // Simulate HITL pause by returning a state with status 'waiting'
      return { ...(this as any).state, status: 'waiting' } as WorkflowState;
    });

    const runId = uuidv4();
    const jobId = await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: graph.id,
      initial_state: { goal: 'test' },
    });

    const events: string[] = [];
    const w = createWorker();
    w.on('job:released', () => events.push('released'));

    await w.start();
    await waitFor(() => events.includes('released'));

    expect(events).toContain('released');

    // Job should be paused (not waiting — not re-claimable by dequeue)
    const depth = await queue.getQueueDepth();
    expect(depth.waiting).toBe(0);
    expect(depth.paused).toBe(1);

    // Verify dequeue returns null (paused job is not claimable)
    const nextJob = await queue.dequeue('other-worker');
    expect(nextJob).toBeNull();

    // Verify the job itself has paused status
    const job = await queue.getJob(jobId);
    expect(job?.status).toBe('paused');

    runSpy.mockRestore();
  });

  test('crash recovery: events exist for start job → uses recover()', async () => {
    const graph = createSimpleGraph();
    await persistence.saveGraph(graph);

    const runId = uuidv4();

    // Simulate existing events from a crashed previous run
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
      state: createTestState(),
    } as unknown as GraphRunner);

    await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: graph.id,
    });

    const events: string[] = [];
    const w = createWorker();
    w.on('job:completed', () => events.push('completed'));

    await w.start();
    await waitFor(() => events.includes('completed'));

    expect(recoverSpy).toHaveBeenCalled();
    recoverSpy.mockRestore();
  });

  test('recovery reconciliation: snapshot ahead of event log → resumes from snapshot', async () => {
    // Two-node graph: a → b
    const graph: Graph = {
      id: uuidv4(),
      name: 'Reconcile Graph',
      nodes: [
        makeNode({ id: 'a', agent_id: 'a' }),
        makeNode({ id: 'b', agent_id: 'b' }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b', condition: { type: 'always' as const } }],
      start_node: 'a',
      end_nodes: ['b'],
    } as Graph;
    await persistence.saveGraph(graph);

    const runId = uuidv4();

    // Produce a real, complete event log for the run (no snapshots wired).
    const liveState = createTestState({ workflow_id: graph.id, run_id: runId, goal: 'test' });
    const liveRunner = new GraphRunner(graph, liveState, { eventLog });
    await liveRunner.run();

    // Simulate lost tail appends: drop everything after the first few events,
    // so event-log replay reconstructs an EARLY state (contiguity preserved).
    const events = eventLog.getEventsForRun(runId);
    events.splice(4);

    // The latest snapshot, however, reflects MORE progress than the replayed
    // state — e.g. its writes committed while the event appends were lost.
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

    await w.start();
    await waitFor(() => workerEvents.includes('completed'));

    // If the worker resumed from the snapshot, node a's output is the
    // snapshot's value (a never re-executed) and only b ran. If it had
    // trusted the truncated event log, a_result would be the mock agent
    // output from re-execution.
    const finalState = await persistence.loadLatestWorkflowState(runId);
    expect(finalState).not.toBeNull();
    expect(finalState!.memory.a_result).toBe('from-snapshot');
    expect(finalState!.memory.b_result).toBe('Mock agent output');
    expect(finalState!.status).toBe('completed');
  });

  // A GAP in the event log (a lost middle append) makes replay-based
  // recover() throw EventLogCorruptionError. A run with a valid snapshot must
  // NOT be dead-lettered — the worker falls back to the snapshot.
  test('recovery: event-log gap falls back to the snapshot instead of dead-lettering', async () => {
    const graph: Graph = {
      id: uuidv4(),
      name: 'Gap Graph',
      nodes: [
        makeNode({ id: 'a', agent_id: 'a' }),
        makeNode({ id: 'b', agent_id: 'b' }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b', condition: { type: 'always' as const } }],
      start_node: 'a',
      end_nodes: ['b'],
    } as Graph;
    await persistence.saveGraph(graph);

    const runId = uuidv4();

    // Produce a real event log, then drop a MIDDLE event to create a sequence
    // gap (contiguity broken → recover() will refuse).
    const liveState = createTestState({ workflow_id: graph.id, run_id: runId, goal: 'test' });
    await new GraphRunner(graph, liveState, { eventLog }).run();
    const events = eventLog.getEventsForRun(runId);
    expect(events.length).toBeGreaterThan(3);
    events.splice(2, 1); // remove one middle event → gap

    // A valid snapshot captures the run's progress.
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

    // The run completed from the snapshot — NOT failed/dead-lettered.
    expect(workerEvents).toContain('completed');
    const finalState = await persistence.loadLatestWorkflowState(runId);
    expect(finalState!.memory.a_result).toBe('from-snapshot');
    expect(finalState!.status).toBe('completed');
  });

  test('resume job: recover → applyHumanResponse → run → ack', async () => {
    const graph = createSimpleGraph();
    await persistence.saveGraph(graph);

    const runId = uuidv4();

    // Simulate existing events
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
    const recoverSpy = vi.spyOn(GraphRunner, 'recover').mockResolvedValue({
      run: vi.fn().mockResolvedValue({ status: 'completed' } as unknown as WorkflowState),
      applyHumanResponse: applyMock,
      shutdown: vi.fn(),
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
    recoverSpy.mockRestore();
  });

  test('failure → nack', async () => {
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

  test('dead letter after max_attempts', async () => {
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

    vi.restoreAllMocks();
  });

  test('heartbeat fires during execution', async () => {
    const graph = createSimpleGraph();
    await persistence.saveGraph(graph);

    const heartbeatSpy = vi.spyOn(queue, 'heartbeat');

    // Make the run take long enough for a heartbeat
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
    vi.restoreAllMocks();
  });

  test('graceful shutdown: finish in-flight work', async () => {
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

    // Wait for the run to actually start (runner is set by then)
    await waitFor(() => runStarted);

    // Start shutdown
    const stopPromise = w.stop();

    expect(shutdownSpy).toHaveBeenCalled();

    // Let the run finish
    resolveRun?.();
    await stopPromise;

    expect(w.activeJobCount).toBe(0);
    vi.restoreAllMocks();
  });

  test('concurrency limit respected', async () => {
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

    // Enqueue 3 jobs but concurrency = 1
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
    vi.restoreAllMocks();
  });

  test('reclaim timer fires periodically', async () => {
    const reclaimSpy = vi.spyOn(queue, 'reclaimExpired');

    const w = createWorker({ reclaimIntervalMs: 100 });
    await w.start();

    await waitFor(() => reclaimSpy.mock.calls.length >= 2, 3000);
    expect(reclaimSpy).toHaveBeenCalled();

    await w.stop();
  });

  test('worker events: started and stopped', async () => {
    const events: string[] = [];
    const w = createWorker();
    w.on('worker:started', () => events.push('started'));
    w.on('worker:stopped', () => events.push('stopped'));

    await w.start();
    expect(events).toContain('started');

    await w.stop();
    expect(events).toContain('stopped');
  });
});
