/** Unit tests for `IdempotencyTracker` and its crash-window rebuild. */

import { describe, it, expect } from 'vitest';
import { IdempotencyTracker } from '../src/execution/coordination/idempotency-tracker.js';
import { InMemoryEventLogWriter } from '../src/persistence/event-log.js';
import type { EventLogWriter } from '../src/persistence/event-log.js';
import type { NewWorkflowEvent } from '../src/persistence/event.js';
import type { Action, WorkflowState } from '../src/state/state.js';

const RUN_ID = '11111111-1111-1111-1111-111111111111';

function makeAction(nodeId: string): Action {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    type: 'update_memory',
    payload: {},
    idempotency_key: `${nodeId}:1`,
    metadata: { node_id: nodeId, timestamp: new Date(), attempt: 1 },
  };
}

function actionEvent(sequenceId: number, nodeId: string): NewWorkflowEvent {
  return {
    run_id: RUN_ID,
    sequence_id: sequenceId,
    event_type: 'action_dispatched',
    node_id: nodeId,
    action: makeAction(nodeId),
  };
}

function internalEvent(sequenceId: number, internalType: string): NewWorkflowEvent {
  return {
    run_id: RUN_ID,
    sequence_id: sequenceId,
    event_type: 'internal_dispatched',
    internal_type: internalType,
  };
}

async function seedLog(events: NewWorkflowEvent[]): Promise<InMemoryEventLogWriter> {
  const log = new InMemoryEventLogWriter();
  for (const event of events) {
    await log.append(event);
  }
  return log;
}

function makeState(): WorkflowState {
  return {
    workflow_id: '33333333-3333-3333-3333-333333333333',
    run_id: RUN_ID,
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'idempotency test',
    constraints: [],
    status: 'running',
    iteration_count: 1,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    total_tokens_used: 0,
    visited_nodes: [],
    max_iterations: 50,
    max_execution_time_ms: 3_600_000,
    compensation_stack: [],
    supervisor_history: [],
  };
}

describe('IdempotencyTracker — key set', () => {
  it('reports a key as unapplied until it is added', () => {
    const tracker = new IdempotencyTracker();

    const before = tracker.has('node-a', 1);
    tracker.add('node-a', 1);

    expect(before).toBe(false);
    expect(tracker.has('node-a', 1)).toBe(true);
  });

  it('scopes keys by iteration', () => {
    const tracker = new IdempotencyTracker();

    tracker.add('node-a', 1);

    expect(tracker.has('node-a', 2)).toBe(false);
    expect(tracker.size).toBe(1);
  });

  it('treats add as idempotent', () => {
    const tracker = new IdempotencyTracker();

    tracker.add('node-a', 1);
    tracker.add('node-a', 1);

    expect(tracker.size).toBe(1);
  });
});

describe('IdempotencyTracker — crash-window rebuild', () => {
  it('marks the current node when its action is durable and no advance follows', async () => {
    const log = await seedLog([
      { run_id: RUN_ID, sequence_id: 0, event_type: 'workflow_started' },
      actionEvent(1, 'node-a'),
      internalEvent(2, '_increment_iteration'),
      internalEvent(3, '_advance'),
      actionEvent(4, 'node-b'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 4,
    });

    expect(tracker.has('node-b', 1)).toBe(true);
    expect(result.keysReconstructed).toBe(1);
    expect(result.maxSequenceId).toBe(4);
  });

  it('leaves the current node unmarked when an advance follows its action', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-b'),
      internalEvent(2, '_advance'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 2,
    });

    expect(tracker.has('node-b', 1)).toBe(false);
    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(2);
  });

  it('leaves the current node unmarked when an iteration increment follows its action', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-b'),
      internalEvent(2, '_increment_iteration'),
    ]);
    const tracker = new IdempotencyTracker();

    await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 2,
    });

    expect(tracker.has('node-b', 1)).toBe(false);
  });

  it('leaves the current node unmarked when the last durable action belongs to another node', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-a'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(tracker.has('node-b', 1)).toBe(false);
    expect(result.keysReconstructed).toBe(0);
  });

  it('leaves the current node unmarked when the action is above the high-water mark', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-a'),
      actionEvent(2, 'node-b'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(tracker.has('node-b', 1)).toBe(false);
    expect(result.maxSequenceId).toBe(2);
  });

  it('leaves the current node unmarked when the snapshot has no high-water mark', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-b'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
    });

    expect(tracker.has('node-b', 1)).toBe(false);
    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(1);
  });

  it('leaves keys unmarked when the snapshot has no current node', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-b'),
    ]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      iteration_count: 1,
      _last_event_sequence_id: 1,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(1);
  });
});

describe('IdempotencyTracker — checkpoint and failure branches', () => {
  it('returns the checkpoint sequence id when no events follow it', async () => {
    const log = await seedLog([]);
    await log.checkpoint(RUN_ID, 7, makeState());
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 7,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(7);
  });

  it('rebuilds from the tail after a checkpoint', async () => {
    const log = await seedLog([
      actionEvent(1, 'node-a'),
      actionEvent(9, 'node-b'),
    ]);
    await log.checkpoint(RUN_ID, 7, makeState());
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 9,
    });

    expect(tracker.has('node-b', 1)).toBe(true);
    expect(result.maxSequenceId).toBe(9);
  });

  it('returns a null max sequence id when there is no checkpoint and no events', async () => {
    const log = await seedLog([]);
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(log, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 3,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(null);
  });

  it('degrades to at-least-once when the event log throws', async () => {
    const failing = {
      loadCheckpoint: async () => { throw new Error('connection lost'); },
      loadEvents: async () => { throw new Error('connection lost'); },
      loadEventsAfter: async () => { throw new Error('connection lost'); },
    } as unknown as EventLogWriter;
    const tracker = new IdempotencyTracker();

    const result = await tracker.rebuildFromEventLog(failing, RUN_ID, {
      current_node: 'node-b',
      iteration_count: 1,
      _last_event_sequence_id: 4,
    });

    expect(result.keysReconstructed).toBe(0);
    expect(result.maxSequenceId).toBe(null);
    expect(tracker.has('node-b', 1)).toBe(false);
  });
});
