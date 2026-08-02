import { describe, it, expect, beforeEach } from 'vitest';
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
    tracker = new StateDeltaTracker({ fullSnapshotInterval: 5 });
  });

  describe('first persist', () => {
    it('always returns full snapshot on first call', () => {
      const state = makeState();
      const result = tracker.computeDelta(state);

      expect(result.type).toBe('full');
      if (result.type === 'full') {
        expect(result.state).toBe(state);
      }
    });
  });

  describe('patch computation', () => {
    it('returns patch when scalar fields change', () => {
      const state = makeState({ status: 'running', current_node: 'node-1' });
      tracker.computeDelta(state);

      const updated = { ...state, status: 'completed' as const, current_node: 'node-2' };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).toHaveProperty('status', 'completed');
        expect(result.patch.fields).toHaveProperty('current_node', 'node-2');
      }
    });

    it('returns patch with memory additions', () => {
      const state = makeState({ memory: { key1: 'value1' } });
      tracker.computeDelta(state);

      const updated = { ...state, memory: { key1: 'value1', key2: 'value2' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key2: 'value2' });
        expect(result.patch.memory_removals).toEqual([]);
      }
    });

    it('returns patch with memory removals', () => {
      const state = makeState({ memory: { key1: 'value1', key2: 'value2' } });
      tracker.computeDelta(state);

      const updated = { ...state, memory: { key1: 'value1' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_removals).toEqual(['key2']);
        expect(result.patch.memory_updates).toEqual({});
      }
    });

    it('returns patch with memory changes', () => {
      const state = makeState({ memory: { key1: 'old' } });
      tracker.computeDelta(state);

      const updated = { ...state, memory: { key1: 'new' } };
      const result = tracker.computeDelta(updated);

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key1: 'new' });
      }
    });

    it('patch includes run_id and version', () => {
      const state = makeState();
      tracker.computeDelta(state);

      const result = tracker.computeDelta(state);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.run_id).toBe(state.run_id);
        expect(result.patch.version).toBe(2);
      }
    });

    it('empty patch when nothing changed', () => {
      const state = makeState({ memory: { key: 'value' } });
      tracker.computeDelta(state);

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
    it('forces full snapshot at configured interval', () => {
      const state = makeState();

      expect(tracker.computeDelta(state).type).toBe('full');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('full');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('patch');
      expect(tracker.computeDelta(state).type).toBe('full');
    });
  });

  describe('max patch size', () => {
    it('falls back to full snapshot when patch exceeds max size', () => {
      const tracker = new StateDeltaTracker({
        fullSnapshotInterval: 100,
        maxPatchBytes: 50,
      });

      const state = makeState({ memory: {} });
      tracker.computeDelta(state);

      const updated = {
        ...state,
        memory: { large_key: 'x'.repeat(100) },
      };
      const result = tracker.computeDelta(updated);
      expect(result.type).toBe('full');
    });
  });

  describe('reset', () => {
    it('reset forces next persist to be full', () => {
      const state = makeState();
      tracker.computeDelta(state);
      expect(tracker.computeDelta(state).type).toBe('patch');

      tracker.reset();
      expect(tracker.computeDelta(state).type).toBe('full');
      expect(tracker.getPersistCount()).toBe(1);
    });
  });

  describe('rollback', () => {
    it('rollback re-includes a failed persist in the next delta', () => {
      const s1 = makeState({ memory: { a: '1' } });
      tracker.computeDelta(s1);

      const s2 = makeState({ run_id: s1.run_id, memory: { a: '2', b: 'new' } });
      tracker.computeDelta(s2);
      tracker.rollback();

      const s3 = makeState({ run_id: s1.run_id, memory: { a: '2', b: 'new' } });
      const result = tracker.computeDelta(s3);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ a: '2', b: 'new' });
      }
    });

    it('rollback restores the persist count (no skipped versions)', () => {
      const state = makeState();
      tracker.computeDelta(state);
      tracker.computeDelta(state);
      expect(tracker.getPersistCount()).toBe(2);

      tracker.rollback();
      expect(tracker.getPersistCount()).toBe(1);
    });
  });

  describe('isolation', () => {
    it('mutations to original state do not affect tracked state', () => {
      const state = makeState({ memory: { key: 'original' } });
      tracker.computeDelta(state);

      state.memory.key = 'mutated';

      const result = tracker.computeDelta(state);
      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.memory_updates).toEqual({ key: 'mutated' });
      }
    });
  });

  describe('defaults', () => {
    it('applies the default full-snapshot interval when constructed without options', () => {
      const defaultTracker = new StateDeltaTracker();
      const state = makeState();

      expect(defaultTracker.computeDelta(state).type).toBe('full');
      for (let i = 0; i < 8; i++) {
        expect(defaultTracker.computeDelta(state).type).toBe('patch');
      }
      expect(defaultTracker.computeDelta(state).type).toBe('full');
    });
  });

  describe('Date-valued field diffing', () => {
    it('treats two equal Dates as unchanged', () => {
      const at = new Date('2026-05-01T00:00:00Z');
      const state = makeState({ started_at: at });
      tracker.computeDelta(state);

      const result = tracker.computeDelta({ ...state, started_at: new Date(at.getTime()) });

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).not.toHaveProperty('started_at');
      }
    });

    it('detects a Date replacing a non-Date value', () => {
      const state = makeState({ started_at: undefined });
      tracker.computeDelta(state);

      const result = tracker.computeDelta({ ...state, started_at: new Date('2026-05-01T00:00:00Z') });

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).toHaveProperty('started_at');
      }
    });
  });

  describe('object-valued field diffing', () => {
    it('treats an equal object-valued field as unchanged', () => {
      const breakdown = { a: { input_tokens: 1, output_tokens: 2, cost_usd: 0.1, calls: 1 } };
      const state = makeState({ model_breakdown: breakdown });
      tracker.computeDelta(state);

      const result = tracker.computeDelta({
        ...state,
        model_breakdown: { a: { input_tokens: 1, output_tokens: 2, cost_usd: 0.1, calls: 1 } },
      });

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).not.toHaveProperty('model_breakdown');
      }
    });

    it('treats a differing object-valued field as changed', () => {
      const state = makeState({ model_breakdown: { a: { input_tokens: 1, output_tokens: 2, cost_usd: 0.1, calls: 1 } } });
      tracker.computeDelta(state);

      const result = tracker.computeDelta({
        ...state,
        model_breakdown: { a: { input_tokens: 9, output_tokens: 2, cost_usd: 0.1, calls: 1 } },
      });

      expect(result.type).toBe('patch');
      if (result.type === 'patch') {
        expect(result.patch.fields).toHaveProperty('model_breakdown');
      }
    });
  });
});
