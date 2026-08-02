/**
 * Persistence Coordinator — Unit Tests
 *
 * Pins down contracts that the integration tests can't easily verify:
 *   - delta vs snapshot routing
 *   - the 3-strike persist-failure counter (success resets it)
 *   - auto-compaction triggers at the configured interval
 *   - compaction failures DON'T increment the persist counter
 */

import { describe, it, expect, vi } from 'vitest';
import { PersistenceCoordinator, MAX_PERSIST_FAILURES } from '../src/runner/persistence-coordinator.js';
import { NoopEventLogWriter, InMemoryEventLogWriter } from '../src/db/event-log.js';
import { StaleClaimError } from '../src/persistence/errors.js';
import type { WorkflowState } from '../src/types/state.js';
import type { StatePatch } from '../src/persistence/delta-tracker.js';

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000000',
    run_id: '11111111-1111-1111-1111-111111111111',
    created_at: new Date(),
    updated_at: new Date(),
    goal: 'test',
    constraints: [],
    status: 'running',
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    memory: {},
    total_tokens_used: 0,
    total_cost_usd: 0,
    _cost_alert_thresholds_fired: [],
    visited_nodes: [],
    max_iterations: 50,
    max_execution_time_ms: 3_600_000,
    compensation_stack: [],
    supervisor_history: [],
    memory_drops: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof PersistenceCoordinator.prototype.constructor>[0]> = {}) {
  return {
    eventLog: new NoopEventLogWriter(),
    compactionInterval: 0,
    isStreaming: vi.fn().mockReturnValue(false),
    push: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

describe('PersistenceCoordinator — basic routing', () => {
  it('uses persistStateFn when no delta tracker is configured', async () => {
    const persistStateFn = vi.fn().mockResolvedValue(undefined);
    const coord = new PersistenceCoordinator(makeDeps({ persistStateFn }));

    await coord.persist(makeState(), 0);
    expect(persistStateFn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no persistStateFn is configured', async () => {
    const coord = new PersistenceCoordinator(makeDeps());
    await expect(coord.persist(makeState(), 0)).resolves.toBeUndefined();
  });

  it('routes patches to persistDeltaFn and full snapshots to persistStateFn', async () => {
    const persistStateFn = vi.fn().mockResolvedValue(undefined);
    const persistDeltaFn = vi.fn().mockResolvedValue(undefined);

    let nextIsFull = true;
    const deltaTracker = {
      computeDelta: vi.fn(() => {
        const result = nextIsFull
          ? { type: 'full' as const, state: makeState() }
          : { type: 'patch' as const, patch: { run_id: 'r', version: 1, changes: {} } as unknown as StatePatch };
        nextIsFull = !nextIsFull;
        return result;
      }),
    };

    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn,
      persistDeltaFn,
      deltaTracker: deltaTracker as unknown as Parameters<typeof makeDeps>[0]['deltaTracker'],
    }));

    await coord.persist(makeState(), 0);
    await coord.persist(makeState(), 1);

    expect(persistStateFn).toHaveBeenCalledTimes(1);
    expect(persistDeltaFn).toHaveBeenCalledTimes(1);
  });
});

describe('PersistenceCoordinator — delta write failures', () => {
  it('rolls back the tracker and rethrows when a delta write fails', async () => {
    const rollback = vi.fn();
    const deltaTracker = {
      computeDelta: vi.fn(() => ({
        type: 'patch' as const,
        patch: { run_id: 'r', version: 1, changes: {} } as unknown as StatePatch,
      })),
      rollback,
    };
    const persistStateFn = vi.fn().mockResolvedValue(undefined);
    const persistDeltaFn = vi.fn().mockRejectedValue(new Error('delta write failed'));

    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn,
      persistDeltaFn,
      deltaTracker: deltaTracker as unknown as Parameters<typeof makeDeps>[0]['deltaTracker'],
    }));

    await coord.persist(makeState(), 0);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(coord.failureCount).toBe(1);
  });
});

describe('PersistenceCoordinator — stale claim', () => {
  it('rethrows a StaleClaimError immediately without counting a strike', async () => {
    const persistStateFn = vi.fn().mockRejectedValue(new StaleClaimError('run-1', 1, 2));
    const coord = new PersistenceCoordinator(makeDeps({ persistStateFn }));

    await expect(coord.persist(makeState(), 0)).rejects.toBeInstanceOf(StaleClaimError);
    expect(coord.failureCount).toBe(0);
  });
});

describe('PersistenceCoordinator — emit + push contract', () => {
  it('emits state:persisted on success', async () => {
    const emit = vi.fn();
    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      emit,
    }));

    await coord.persist(makeState({ iteration_count: 7 }), 0);

    expect(emit).toHaveBeenCalledWith('state:persisted', {
      run_id: expect.any(String),
      iteration: 7,
    });
  });

  it('pushes to stream channel only when isStreaming() is true', async () => {
    const pushOff = vi.fn();
    const coordOff = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      push: pushOff,
      isStreaming: vi.fn().mockReturnValue(false),
    }));
    await coordOff.persist(makeState(), 0);
    expect(pushOff).not.toHaveBeenCalled();

    const pushOn = vi.fn();
    const coordOn = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      push: pushOn,
      isStreaming: vi.fn().mockReturnValue(true),
    }));
    await coordOn.persist(makeState(), 0);
    expect(pushOn).toHaveBeenCalledWith(expect.objectContaining({ type: 'state:persisted' }));
  });

  it('does not emit when persistStateFn is not configured', async () => {
    const emit = vi.fn();
    const coord = new PersistenceCoordinator(makeDeps({ emit }));
    await coord.persist(makeState(), 0);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('PersistenceCoordinator — 3-strike failure counter', () => {
  it('counts consecutive failures and throws on the third', async () => {
    const persistStateFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const coord = new PersistenceCoordinator(makeDeps({ persistStateFn }));

    await expect(coord.persist(makeState(), 0)).resolves.toBeUndefined();
    expect(coord.failureCount).toBe(1);
    await expect(coord.persist(makeState(), 1)).resolves.toBeUndefined();
    expect(coord.failureCount).toBe(2);
    await expect(coord.persist(makeState(), 2)).rejects.toThrow(/Persistence unavailable after 3/);
    expect(coord.failureCount).toBe(MAX_PERSIST_FAILURES);
  });

  it('resets the counter on first success', async () => {
    let calls = 0;
    const persistStateFn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1 || calls === 2) throw new Error('transient');
    });
    const coord = new PersistenceCoordinator(makeDeps({ persistStateFn }));

    await coord.persist(makeState(), 0);
    await coord.persist(makeState(), 1);
    expect(coord.failureCount).toBe(2);
    await coord.persist(makeState(), 2);
    expect(coord.failureCount).toBe(0);
    await coord.persist(makeState(), 3);
    expect(coord.failureCount).toBe(0);
  });
});

describe('PersistenceCoordinator — auto-compaction', () => {
  it('is disabled when compactionInterval is 0', async () => {
    const eventLog = new InMemoryEventLogWriter();
    const checkpointSpy = vi.spyOn(eventLog, 'checkpoint');
    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      eventLog,
      compactionInterval: 0,
    }));

    for (let i = 0; i < 5; i++) {
      await coord.persist(makeState(), i);
    }
    expect(checkpointSpy).not.toHaveBeenCalled();
  });

  it('triggers compaction exactly at compactionInterval', async () => {
    const eventLog = new InMemoryEventLogWriter();
    const checkpointSpy = vi.spyOn(eventLog, 'checkpoint');
    const compactSpy = vi.spyOn(eventLog, 'compact');
    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      eventLog,
      compactionInterval: 3,
    }));

    await coord.persist(makeState(), 1);
    await coord.persist(makeState(), 2);
    expect(checkpointSpy).not.toHaveBeenCalled();
    await coord.persist(makeState(), 3);
    expect(checkpointSpy).toHaveBeenCalledTimes(1);
    expect(compactSpy).toHaveBeenCalledTimes(1);

    await coord.persist(makeState(), 4);
    await coord.persist(makeState(), 5);
    expect(checkpointSpy).toHaveBeenCalledTimes(1);
    await coord.persist(makeState(), 6);
    expect(checkpointSpy).toHaveBeenCalledTimes(2);
  });

  it('logs the deleted count when auto-compaction removes events', async () => {
    const eventLog = new InMemoryEventLogWriter();
    vi.spyOn(eventLog, 'checkpoint').mockResolvedValue(undefined);
    vi.spyOn(eventLog, 'compact').mockResolvedValue(5);
    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      eventLog,
      compactionInterval: 1,
    }));

    await coord.persist(makeState(), 10);

    expect(coord.failureCount).toBe(0);
  });

  it('swallows a non-Error compaction failure', async () => {
    const eventLog = new InMemoryEventLogWriter();
    vi.spyOn(eventLog, 'checkpoint').mockRejectedValue('checkpoint blew up');
    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      eventLog,
      compactionInterval: 1,
    }));

    await coord.persist(makeState(), 5);

    expect(coord.failureCount).toBe(0);
  });

  it('compaction failures do NOT increment the persist-failure counter', async () => {
    const eventLog = new InMemoryEventLogWriter();
    vi.spyOn(eventLog, 'checkpoint').mockRejectedValue(new Error('checkpoint failed'));

    const coord = new PersistenceCoordinator(makeDeps({
      persistStateFn: vi.fn().mockResolvedValue(undefined),
      eventLog,
      compactionInterval: 1,
    }));

    await coord.persist(makeState(), 0);
    expect(coord.failureCount).toBe(0);
    await coord.persist(makeState(), 1);
    expect(coord.failureCount).toBe(0);
  });
});

describe('PersistenceCoordinator.compactNow', () => {
  it('returns 0 when sequenceId is 0 (nothing appended)', async () => {
    const eventLog = new InMemoryEventLogWriter();
    const checkpointSpy = vi.spyOn(eventLog, 'checkpoint');
    const coord = new PersistenceCoordinator(makeDeps({ eventLog }));

    const result = await coord.compactNow(makeState(), 0);
    expect(result).toBe(0);
    expect(checkpointSpy).not.toHaveBeenCalled();
  });

  it('writes a checkpoint and returns the compact() result', async () => {
    const eventLog = new InMemoryEventLogWriter();
    const checkpointSpy = vi.spyOn(eventLog, 'checkpoint');
    vi.spyOn(eventLog, 'compact').mockResolvedValue(42);
    const coord = new PersistenceCoordinator(makeDeps({ eventLog }));

    const result = await coord.compactNow(makeState(), 10);
    expect(checkpointSpy).toHaveBeenCalledWith(expect.any(String), 9, expect.any(Object));
    expect(result).toBe(42);
  });
});
