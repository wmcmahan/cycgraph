/**
 * Tests for the resume idempotency rebuild
 * (src/execution/coordination/idempotency-tracker.ts) — the crash-window
 * guard that stops a resumed run from re-executing a node whose action
 * was already reduced into the snapshot.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/observability/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { IdempotencyTracker } from '../src/execution/coordination/idempotency-tracker.js';
import { InMemoryEventLogWriter, type EventLogWriter } from '../src/persistence/event-log.js';
import type { WorkflowState } from '../src/state/state.js';

const makeState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Idempotency rebuild test',
  constraints: [],
  status: 'running',
  iteration_count: 1,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 30000,
  supervisor_history: [],
  total_tokens_used: 0,
});

const started = (runId: string) =>
  ({ run_id: runId, sequence_id: 0, event_type: 'workflow_started' as const });

const action = (runId: string, seq: number, nodeId: string) => ({
  run_id: runId,
  sequence_id: seq,
  event_type: 'action_dispatched' as const,
  node_id: nodeId,
  action: { metadata: { node_id: nodeId } },
});

const internal = (runId: string, seq: number, internalType: string) => ({
  run_id: runId,
  sequence_id: seq,
  event_type: 'internal_dispatched' as const,
  internal_type: internalType,
});

describe('IdempotencyTracker', () => {
  it('reports a pair as applied only after add', () => {
    const tracker = new IdempotencyTracker();

    expect(tracker.has('node-a', 1)).toBe(false);
    tracker.add('node-a', 1);
    expect(tracker.has('node-a', 1)).toBe(true);
    expect(tracker.size).toBe(1);
  });
});

describe('rebuildFromEventLog', () => {
  it('marks the current node as applied when its action is durable with no advance after it', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(started(runId));
    await eventLog.append(action(runId, 1, 'node-b'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(result.keysReconstructed).toBe(1);
    expect(result.maxSequenceId).toBe(1);
    expect(tracker.has('node-b', 1)).toBe(true);
  });

  it('marks nothing when an _advance follows the durable action', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(action(runId, 1, 'node-b'));
    await eventLog.append(internal(runId, 2, '_advance'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 2,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(2);
    expect(tracker.has('node-b', 1)).toBe(false);
  });

  it('treats _increment_iteration as an advance', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(action(runId, 1, 'node-b'));
    await eventLog.append(internal(runId, 2, '_increment_iteration'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 2,
    });

    expect(result.keysReconstructed).toBe(0);
  });

  it('marks the node when the only advance lies past the high-water mark', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(action(runId, 1, 'node-b'));
    await eventLog.append(internal(runId, 2, '_advance'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(result.keysReconstructed).toBe(1);
    expect(tracker.has('node-b', 1)).toBe(true);
  });

  it('marks nothing when the last durable action belongs to another node', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(action(runId, 1, 'node-a'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(tracker.has('node-b', 1)).toBe(false);
  });

  it('marks nothing without a high-water mark but still reports the max sequence id', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.append(action(runId, 1, 'node-b'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 1,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(1);
    expect(tracker.has('node-b', 1)).toBe(false);
  });

  it('continues numbering above a compacted checkpoint with no trailing events', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.checkpoint(runId, 7, makeState());
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 3,
      _last_event_sequence_id: 7,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(7);
  });

  it('marks from the events after a checkpoint', async () => {
    const runId = uuidv4();
    const eventLog = new InMemoryEventLogWriter();
    await eventLog.checkpoint(runId, 5, makeState());
    await eventLog.append(action(runId, 6, 'node-b'));
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(eventLog, runId, {
      current_node: 'node-b',
      iteration_count: 3,
      _last_event_sequence_id: 6,
    });

    expect(result.keysReconstructed).toBe(1);
    expect(result.maxSequenceId).toBe(6);
    expect(tracker.has('node-b', 3)).toBe(true);
  });

  it('degrades to no keys and a null max when the event log cannot be read', async () => {
    const failing = {
      loadCheckpoint: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as EventLogWriter;
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(failing, uuidv4(), {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(result).toEqual({ keysReconstructed: 0, maxSequenceId: null });
  });

  it('returns a null max for an empty log without a checkpoint', async () => {
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(new InMemoryEventLogWriter(), uuidv4(), {
      current_node: 'node-b',
      iteration_count: 1,
    });

    expect(result).toEqual({ keysReconstructed: 0, maxSequenceId: null });
  });
});
