/**
 * Reducer Hot Paths
 *
 * Pure-CPU baseline for the cheapest operation in the runner: applying an
 * action to state. These run millions of times during a heavy workflow, so
 * a regression here is amplified everywhere.
 *
 * What we measure:
 *   - `update_memory` — the dominant action type
 *   - `merge_parallel_results` — fan-in reducer with token accumulation
 *   - internal `_track_tokens` — fires after every action with tokens
 *   - internal `_increment_iteration` — fires once per node
 *
 * Run: `npm run bench --workspace=packages/benchmarks`
 */

import { bench, describe } from 'vitest';
import {
  rootReducer,
  internalReducer,
  createWorkflowState,
  type Action,
  type WorkflowState,
} from '@cycgraph/orchestrator';

function freshState(): WorkflowState {
  return createWorkflowState({
    workflow_id: '00000000-0000-0000-0000-000000000000',
    goal: 'bench',
  });
}

function makeUpdateMemoryAction(key: string, value: unknown): Action {
  return {
    id: 'a',
    idempotency_key: 'a',
    type: 'update_memory',
    payload: { updates: { [key]: value } },
    metadata: { node_id: 'n', timestamp: new Date(), attempt: 1 },
  };
}

function makeMergeAction(updates: Record<string, unknown>): Action {
  return {
    id: 'm',
    idempotency_key: 'm',
    type: 'merge_parallel_results',
    payload: { updates, total_tokens: 100 },
    metadata: { node_id: 'n', timestamp: new Date(), attempt: 1 },
  };
}

describe('rootReducer — update_memory', () => {
  const state = freshState();
  const tinyAction = makeUpdateMemoryAction('counter', 1);
  const smallAction = makeUpdateMemoryAction('payload', { items: [1, 2, 3, 4, 5] });
  const largeAction = makeUpdateMemoryAction('payload', { items: Array.from({ length: 1000 }, (_, i) => i) });

  bench('tiny value (number)', () => {
    rootReducer(state, tinyAction);
  });

  bench('small object (5-element array)', () => {
    rootReducer(state, smallAction);
  });

  bench('large object (1000-element array)', () => {
    rootReducer(state, largeAction);
  });
});

describe('rootReducer — merge_parallel_results', () => {
  const state = freshState();
  const tinyMerge = makeMergeAction({ result_0: 'a', result_1: 'b' });
  const wideMerge = makeMergeAction(
    Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`result_${i}`, i])),
  );

  bench('2 keys', () => {
    rootReducer(state, tinyMerge);
  });

  bench('50 keys', () => {
    rootReducer(state, wideMerge);
  });
});

describe('internalReducer — high-frequency dispatches', () => {
  const state = freshState();
  const trackTokens: Action = {
    id: 't',
    idempotency_key: 't',
    type: '_track_tokens' as unknown as Action['type'],
    payload: { tokens: 50 },
    metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
  };
  const incrementIteration: Action = {
    id: 'i',
    idempotency_key: 'i',
    type: '_increment_iteration' as unknown as Action['type'],
    payload: {},
    metadata: { node_id: '_runner', timestamp: new Date(), attempt: 1 },
  };

  bench('_track_tokens', () => {
    internalReducer(state, trackTokens);
  });

  bench('_increment_iteration', () => {
    internalReducer(state, incrementIteration);
  });
});

describe('rootReducer — sustained load (chain of updates)', () => {
  // Worst-case: a workflow that does 100 memory updates in sequence. We chain
  // them so each iteration applies its own action to the previous result —
  // measures whether memory growth slows reducer throughput.
  bench('100 sequential update_memory calls', () => {
    let s = freshState();
    for (let i = 0; i < 100; i++) {
      s = rootReducer(s, makeUpdateMemoryAction(`k${i}`, i));
    }
  });
});
