/**
 * lesson-provenance.test.ts
 *
 * Tests for the lesson provenance registry (`memory._lesson_provenance`):
 * - Reducer merge: append-only union, anti-clearing, ring-buffer trim
 * - Helpers: ordering, fact-id dedupe
 * - Replay determinism: folding the same action log twice is byte-stable
 * - Security: the registry never appears in any node's StateView
 */
import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { updateMemoryReducer, mergeParallelResultsReducer, rootReducer } from '../src/reducers/index.js';
import {
  LESSON_PROVENANCE_KEY,
  MAX_LESSON_PROVENANCE_ENTRIES,
  getLessonProvenance,
  getLessonProvenanceRegistry,
  getInjectedFactIds,
  trimLessonProvenance,
} from '../src/utils/lesson-provenance.js';
import { createStateView } from '../src/runner/state-view.js';
import type { WorkflowState, Action, LessonProvenanceRegistry } from '../src/types/state.js';
import type { GraphNode } from '../src/types/graph.js';

const createBaseState = (): WorkflowState => ({
  workflow_id: uuidv4(),
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Test goal',
  constraints: [],
  status: 'running',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  max_execution_time_ms: 3600000,
  total_tokens_used: 0,
  supervisor_history: [],
});

const makeUpdateAction = (updates: Record<string, unknown>): Action => ({
  id: uuidv4(),
  idempotency_key: uuidv4(),
  type: 'update_memory',
  payload: { updates },
  metadata: { node_id: 'test', timestamp: new Date(), attempt: 1 },
});

const entry = (nodeId: string, factIds: string[], retrievedAt: string) => ({
  node_id: nodeId,
  agent_id: 'agent-1',
  fact_ids: factIds,
  retrieved_at: retrievedAt,
});

describe('lesson provenance reducer merge', () => {
  test('sequential update_memory actions union entries append-only', () => {
    const state = createBaseState();
    const keyA = uuidv4();
    const keyB = uuidv4();

    const s1 = updateMemoryReducer(state, makeUpdateAction({
      notes: 'first',
      [LESSON_PROVENANCE_KEY]: { [keyA]: entry('research', ['f1'], '2026-06-11T10:00:00.000Z') },
    }));
    const s2 = updateMemoryReducer(s1, makeUpdateAction({
      notes: 'second',
      [LESSON_PROVENANCE_KEY]: { [keyB]: entry('critique', ['f2'], '2026-06-11T10:01:00.000Z') },
    }));

    const registry = getLessonProvenanceRegistry(s2.memory);
    expect(Object.keys(registry).sort()).toEqual([keyA, keyB].sort());
    expect(registry[keyA].fact_ids).toEqual(['f1']);
    expect(registry[keyB].fact_ids).toEqual(['f2']);
  });

  test('a crafted empty-registry update cannot clear existing entries', () => {
    const state = createBaseState();
    const key = uuidv4();

    const s1 = updateMemoryReducer(state, makeUpdateAction({
      [LESSON_PROVENANCE_KEY]: { [key]: entry('research', ['f1'], '2026-06-11T10:00:00.000Z') },
    }));
    const s2 = updateMemoryReducer(s1, makeUpdateAction({
      [LESSON_PROVENANCE_KEY]: {},
    }));

    expect(Object.keys(getLessonProvenanceRegistry(s2.memory))).toEqual([key]);
  });

  test('merge_parallel_results merges provenance identically', () => {
    const state = createBaseState();
    const keyA = uuidv4();
    const keyB = uuidv4();

    const s1 = updateMemoryReducer(state, makeUpdateAction({
      [LESSON_PROVENANCE_KEY]: { [keyA]: entry('research', ['f1'], '2026-06-11T10:00:00.000Z') },
    }));

    const mergeAction: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'merge_parallel_results',
      payload: {
        updates: {
          vote_consensus: 'x',
          [LESSON_PROVENANCE_KEY]: { [keyB]: entry('vote_voter_0', ['f2', 'f3'], '2026-06-11T10:02:00.000Z') },
        },
        total_tokens: 10,
      },
      metadata: { node_id: 'vote', timestamp: new Date(), attempt: 1 },
    };
    const s2 = mergeParallelResultsReducer(s1, mergeAction);

    const registry = getLessonProvenanceRegistry(s2.memory);
    expect(Object.keys(registry).sort()).toEqual([keyA, keyB].sort());
  });

  test('trims to the newest MAX entries with deterministic ordering', () => {
    const registry: LessonProvenanceRegistry = {};
    for (let i = 0; i < MAX_LESSON_PROVENANCE_ENTRIES + 10; i++) {
      const ts = `2026-06-11T10:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
      registry[`key-${String(i).padStart(4, '0')}`] = entry(`node-${i}`, [`f${i}`], ts);
    }

    const trimmed = trimLessonProvenance(registry);
    expect(Object.keys(trimmed)).toHaveLength(MAX_LESSON_PROVENANCE_ENTRIES);
    // The oldest 10 (by retrieved_at, then key) are gone.
    expect(trimmed['key-0000']).toBeUndefined();
    expect(trimmed[`key-${String(MAX_LESSON_PROVENANCE_ENTRIES + 9).padStart(4, '0')}`]).toBeDefined();
  });

  test('trim is a no-op (same reference) under the cap', () => {
    const registry: LessonProvenanceRegistry = {
      [uuidv4()]: entry('n', ['f1'], '2026-06-11T10:00:00.000Z'),
    };
    expect(trimLessonProvenance(registry)).toBe(registry);
  });
});

describe('lesson provenance helpers', () => {
  test('getLessonProvenance returns entries oldest-first deterministically', () => {
    const state = createBaseState();
    state.memory[LESSON_PROVENANCE_KEY] = {
      b: entry('second', ['f2'], '2026-06-11T10:01:00.000Z'),
      a: entry('first', ['f1'], '2026-06-11T10:00:00.000Z'),
      // Same timestamp as `b` — key is the tiebreak.
      c: entry('third', ['f3'], '2026-06-11T10:01:00.000Z'),
    };

    expect(getLessonProvenance(state).map((e) => e.node_id)).toEqual(['first', 'second', 'third']);
  });

  test('getInjectedFactIds dedupes across entries in stable order', () => {
    const state = createBaseState();
    state.memory[LESSON_PROVENANCE_KEY] = {
      a: entry('n1', ['f1', 'f2'], '2026-06-11T10:00:00.000Z'),
      b: entry('n2', ['f2', 'f3'], '2026-06-11T10:01:00.000Z'),
    };

    expect(getInjectedFactIds(state)).toEqual(['f1', 'f2', 'f3']);
  });

  test('helpers tolerate a missing or malformed registry', () => {
    const state = createBaseState();
    expect(getLessonProvenance(state)).toEqual([]);
    expect(getInjectedFactIds(state)).toEqual([]);

    state.memory[LESSON_PROVENANCE_KEY] = 'corrupted';
    expect(getInjectedFactIds(state)).toEqual([]);
  });
});

describe('replay determinism', () => {
  test('folding the same action log twice yields deep-equal state', () => {
    const actions: Action[] = [
      makeUpdateAction({
        notes: 'a',
        [LESSON_PROVENANCE_KEY]: { [uuidv4()]: entry('research', ['f1'], '2026-06-11T10:00:00.000Z') },
      }),
      makeUpdateAction({
        critique: 'b',
        [LESSON_PROVENANCE_KEY]: { [uuidv4()]: entry('critique', ['f1', 'f2'], '2026-06-11T10:01:00.000Z') },
      }),
    ];

    const fold = () => actions.reduce((s, a) => rootReducer(s, a), createBaseState());
    const first = fold();
    const second = fold();

    expect(getLessonProvenanceRegistry(second.memory)).toEqual(getLessonProvenanceRegistry(first.memory));
    expect(getInjectedFactIds(second)).toEqual(getInjectedFactIds(first));
  });
});

describe('state-view isolation', () => {
  test('_lesson_provenance is invisible to nodes, including read_keys: ["*"]', () => {
    const state = createBaseState();
    state.memory = {
      visible: 'yes',
      [LESSON_PROVENANCE_KEY]: { [uuidv4()]: entry('n', ['f1'], '2026-06-11T10:00:00.000Z') },
    };

    const starNode: GraphNode = {
      id: 'n1',
      type: 'agent',
      agent_id: uuidv4(),
      read_keys: ['*'],
      write_keys: ['out'],
      requires_compensation: false,
    };
    const view = createStateView(state, starNode);

    expect(view.memory['visible']).toBe('yes');
    expect(LESSON_PROVENANCE_KEY in view.memory).toBe(false);
  });
});
