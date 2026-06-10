import { describe, test, expect, beforeEach } from 'vitest';
import { InMemoryEventLogWriter, NoopEventLogWriter } from '../src/db/event-log.js';
import type { NewWorkflowEvent } from '../src/types/event.js';
import type { WorkflowState } from '../src/types/state.js';
import { createWorkflowState } from '../src/types/state.js';

const WF_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

function makeEvent(overrides: Partial<NewWorkflowEvent> = {}): NewWorkflowEvent {
  return {
    run_id: 'run-1',
    sequence_id: 0,
    event_type: 'action_dispatched',
    node_id: 'node-1',
    ...overrides,
  };
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return createWorkflowState({
    workflow_id: WF_ID,
    run_id: RUN_ID,
    status: 'running',
    current_node: 'node-1',
    goal: 'test',
    memory: { result: 'hello' },
    ...overrides,
  });
}

describe('InMemoryEventLogWriter', () => {
  let writer: InMemoryEventLogWriter;

  beforeEach(() => {
    writer = new InMemoryEventLogWriter();
  });

  describe('append + loadEvents', () => {
    test('should append and load events in sequence order', async () => {
      await writer.append(makeEvent({ sequence_id: 2 }));
      await writer.append(makeEvent({ sequence_id: 0 }));
      await writer.append(makeEvent({ sequence_id: 1 }));

      const events = await writer.loadEvents('run-1');
      expect(events).toHaveLength(3);
      expect(events.map(e => e.sequence_id)).toEqual([0, 1, 2]);
    });

    test('should return empty array for unknown run', async () => {
      const events = await writer.loadEvents('unknown');
      expect(events).toEqual([]);
    });

    test('should assign id and created_at to appended events', async () => {
      await writer.append(makeEvent());
      const events = await writer.loadEvents('run-1');
      expect(events[0].id).toBeDefined();
      expect(events[0].created_at).toBeInstanceOf(Date);
    });

    test('should isolate events by run_id', async () => {
      await writer.append(makeEvent({ run_id: 'run-1', sequence_id: 0 }));
      await writer.append(makeEvent({ run_id: 'run-2', sequence_id: 0 }));

      expect(await writer.loadEvents('run-1')).toHaveLength(1);
      expect(await writer.loadEvents('run-2')).toHaveLength(1);
    });
  });

  describe('loadEventsAfter', () => {
    test('should load only events after given sequence_id', async () => {
      await writer.append(makeEvent({ sequence_id: 0 }));
      await writer.append(makeEvent({ sequence_id: 1 }));
      await writer.append(makeEvent({ sequence_id: 2 }));
      await writer.append(makeEvent({ sequence_id: 3 }));

      const events = await writer.loadEventsAfter('run-1', 1);
      expect(events.map(e => e.sequence_id)).toEqual([2, 3]);
    });

    test('should return empty when no events after sequence_id', async () => {
      await writer.append(makeEvent({ sequence_id: 0 }));
      const events = await writer.loadEventsAfter('run-1', 5);
      expect(events).toEqual([]);
    });
  });

  describe('getLatestSequenceId', () => {
    test('should return -1 for unknown run', async () => {
      expect(await writer.getLatestSequenceId('unknown')).toBe(-1);
    });

    test('should return highest sequence_id', async () => {
      await writer.append(makeEvent({ sequence_id: 3 }));
      await writer.append(makeEvent({ sequence_id: 7 }));
      await writer.append(makeEvent({ sequence_id: 1 }));

      expect(await writer.getLatestSequenceId('run-1')).toBe(7);
    });
  });

  describe('checkpoint + loadCheckpoint', () => {
    test('should save and load checkpoint', async () => {
      const state = makeState();
      await writer.checkpoint('run-1', 5, state);

      const cp = await writer.loadCheckpoint('run-1');
      expect(cp).not.toBeNull();
      expect(cp!.sequence_id).toBe(5);
      expect(cp!.state.memory).toEqual({ result: 'hello' });
    });

    test('should return null for unknown run', async () => {
      expect(await writer.loadCheckpoint('unknown')).toBeNull();
    });

    test('should deep clone state to prevent mutation', async () => {
      const state = makeState();
      await writer.checkpoint('run-1', 0, state);

      // Mutate original
      state.memory.result = 'mutated';

      const cp = await writer.loadCheckpoint('run-1');
      expect(cp!.state.memory.result).toBe('hello');
    });

    test('should overwrite previous checkpoint for same run', async () => {
      await writer.checkpoint('run-1', 3, makeState({ status: 'running' } as Partial<WorkflowState>));
      await writer.checkpoint('run-1', 7, makeState({ status: 'completed' } as Partial<WorkflowState>));

      const cp = await writer.loadCheckpoint('run-1');
      expect(cp!.sequence_id).toBe(7);
      expect(cp!.state.status).toBe('completed');
    });
  });

  describe('compact', () => {
    test('should delete events at or before sequence_id', async () => {
      await writer.append(makeEvent({ sequence_id: 0 }));
      await writer.append(makeEvent({ sequence_id: 1 }));
      await writer.append(makeEvent({ sequence_id: 2 }));
      await writer.append(makeEvent({ sequence_id: 3 }));

      const deleted = await writer.compact('run-1', 2);
      expect(deleted).toBe(3); // seq 0, 1, 2

      const remaining = await writer.loadEvents('run-1');
      expect(remaining.map(e => e.sequence_id)).toEqual([3]);
    });

    test('should return 0 for unknown run', async () => {
      expect(await writer.compact('unknown', 5)).toBe(0);
    });

    test('should return 0 when no events match', async () => {
      await writer.append(makeEvent({ sequence_id: 10 }));
      expect(await writer.compact('run-1', 5)).toBe(0);
    });
  });

  describe('getEventsForRun (test helper)', () => {
    test('should return raw events without sorting', async () => {
      await writer.append(makeEvent({ sequence_id: 2 }));
      await writer.append(makeEvent({ sequence_id: 0 }));

      const raw = writer.getEventsForRun('run-1');
      expect(raw).toHaveLength(2);
      // Raw order (insertion order), not sorted
      expect(raw[0].sequence_id).toBe(2);
      expect(raw[1].sequence_id).toBe(0);
    });
  });

  describe('clear', () => {
    test('should remove all events and checkpoints', async () => {
      await writer.append(makeEvent());
      await writer.checkpoint('run-1', 0, makeState());

      writer.clear();

      expect(await writer.loadEvents('run-1')).toEqual([]);
      expect(await writer.loadCheckpoint('run-1')).toBeNull();
    });
  });
});

describe('NoopEventLogWriter', () => {
  let writer: NoopEventLogWriter;

  beforeEach(() => {
    writer = new NoopEventLogWriter();
  });

  test('append should not throw', async () => {
    await expect(writer.append(makeEvent())).resolves.toBeUndefined();
  });

  test('loadEvents should return empty array', async () => {
    expect(await writer.loadEvents('run-1')).toEqual([]);
  });

  test('loadEventsAfter should return empty array', async () => {
    expect(await writer.loadEventsAfter('run-1', 0)).toEqual([]);
  });

  test('getLatestSequenceId should return -1', async () => {
    expect(await writer.getLatestSequenceId('run-1')).toBe(-1);
  });

  test('checkpoint should not throw', async () => {
    await expect(writer.checkpoint('run-1', 0, makeState())).resolves.toBeUndefined();
  });

  test('loadCheckpoint should return null', async () => {
    expect(await writer.loadCheckpoint('run-1')).toBeNull();
  });

  test('compact should return 0', async () => {
    expect(await writer.compact('run-1', 5)).toBe(0);
  });
});
