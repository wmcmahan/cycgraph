import { describe, test, expect, beforeEach } from 'vitest';
import { StateDeltaTracker } from '../src/persistence/delta-tracker.js';
import { createWorkflowState, type WorkflowState } from '../src/types/state.js';
import { v4 as uuidv4 } from 'uuid';

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return createWorkflowState({
    workflow_id: uuidv4(),
    goal: 'Test goal',
    ...overrides,
  });
}

describe('StateDeltaTracker', () => {
  let tracker: StateDeltaTracker;

  beforeEach(() => {
    tracker = new StateDeltaTracker({ full_snapshot_interval: 5 });
  });

  describe('first persist', () => {
    test('always returns full snapshot on first call', () => {
      const state = makeState();
      const result = tracker.computeDelta(state);

      expect(result.type).toBe('full');
      if (result.type === 'full') {
        expect(result.state).toBe(state);
      }
    });
  });

  describe('patch computation', () => {
    test('returns patch when scalar fields change', () => {
      const state = makeState({ status: 'running', current_node: 'node-1' });
      tracker.computeDelta(state); // first = full

      const updated = { ...state, status: 'completed' as const, current_node: 'node-2' };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).toHaveProperty('status', 'completed');
        expect(result.patch.fields).toHaveProperty('current_node', 'node-2');
      }
    });

    test('returns patch with memory additions', () => {
      const state = makeState({ memory: { key1: 'value1' } });
      tracker.computeDelta(state); // first = full

      const updated = { ...state, memory: { key1: 'value1', key2: 'value2' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key2: 'value2' });
        expect(result.patch.memory_removals).toEqual([]);
      }
    });

    test('returns patch with memory removals', () => {
      const state = makeState({ memory: { key1: 'value1', key2: 'value2' } });
      tracker.computeDelta(state); // first = full

      const updated = { ...state, memory: { key1: 'value1' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_removals).toEqual(['key2']);
        expect(result.patch.memory_updates).toEqual({});
      }
    });

    test('returns patch with memory changes', () => {
      const state = makeState({ memory: { key1: 'old' } });
      tracker.computeDelta(state);

      const updated = { ...state, memory: { key1: 'new' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key1: 'new' });
      }
    });

    test('patch includes run_id and version', () => {
      const state = makeState();
      tracker.computeDelta(state);

      const result = tracker.computeDelta(state);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.run_id).toBe(state.run_id);
        expect(result.patch.version).toBe(2);
      }
    });

    test('empty patch when nothing changed', () => {
      const state = makeState({ memory: { key: 'value' } });
      tracker.computeDelta(state);

      // Same state object — values haven't changed
      const result = tracker.computeDelta(state);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(Object.keys(result.patch.fields)).toHaveLength(0);
        expect(Object.keys(result.patch.memory_updates)).toHaveLength(0);
        expect(result.patch.memory_removals).toHaveLength(0);
      }
    });
  });

  describe('full snapshot interval', () => {
    test('forces full snapshot at configured interval', () => {
      const state = makeState();

      // persist 1 = full (first)
      expect(tracker.computeDelta(state).type).toBe('full');
      // persist 2-4 = patch
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      // persist 5 = full (interval=5)
      expect(tracker.computeDelta(state).type).toBe('full');
      // persist 6-9 = patch
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      // persist 10 = full
      expect(tracker.computeDelta(state).type).toBe('full');
    });
  });

  describe('max patch size', () => {
    test('falls back to full snapshot when patch exceeds max size', () => {
      const tracker = new StateDeltaTracker({
        full_snapshot_interval: 100,
        max_patch_bytes: 50, // Very small limit
      });

      const state = makeState({ memory: {} });
      tracker.computeDelta(state);

      // Add a large memory value that exceeds 50 bytes
      const updated = {
        ...state,
        memory: { large_key: 'x'.repeat(100) },
      };
      const result = tracker.computeDelta(updated);
      expect(result.type).toBe('full');
    });
  });

  describe('reset', () => {
    test('reset forces next persist to be full', () => {
      const state = makeState();
      tracker.computeDelta(state);
      expect(tracker.computeDelta(state).type).toBe('patch');

      tracker.reset();
      expect(tracker.computeDelta(state).type).toBe('full');
      expect(tracker.getPersistCount()).toBe(1);
    });
  });

  describe('rollback', () => {
    test('rollback re-includes a failed persist in the next delta', () => {
      const s1 = makeState({ memory: { a: '1' } });
      tracker.computeDelta(s1); // first = full, baseline = s1

      // Persist of s2 "fails" — the changes a→2, b added must not be lost.
      const s2 = makeState({ run_id: s1.run_id, memory: { a: '2', b: 'new' } });
      tracker.computeDelta(s2);
      tracker.rollback();

      // Next delta diffs against s1 (the last *durable* state), so it carries
      // the rolled-back changes rather than diffing against the never-persisted s2.
      const s3 = makeState({ run_id: s1.run_id, memory: { a: '2', b: 'new' } });
      const result = tracker.computeDelta(s3);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ a: '2', b: 'new' });
      }
    });

    test('rollback restores the persist count (no skipped versions)', () => {
      const state = makeState();
      tracker.computeDelta(state); // count 1
      tracker.computeDelta(state); // count 2
      expect(tracker.getPersistCount()).toBe(2);

      tracker.rollback(); // undo the second
      expect(tracker.getPersistCount()).toBe(1);
    });
  });

  describe('isolation', () => {
    test('mutations to original state do not affect tracked state', () => {
      const state = makeState({ memory: { key: 'original' } });
      tracker.computeDelta(state);

      // Mutate the original
      state.memory.key = 'mutated';

      // Tracker should see the mutation as a change
      const result = tracker.computeDelta(state);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key: 'mutated' });
      }
    });
  });
});
