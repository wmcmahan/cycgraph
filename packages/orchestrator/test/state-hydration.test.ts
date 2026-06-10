/**
 * state-hydration.test.ts
 *
 * Tests for hydrateWorkflowState — the load-boundary parser that restores
 * Date fields after JSON/jsonb round-trips and applies schema migrations.
 * Regression coverage for the bug where a recovered HITL workflow compared
 * `new Date() >= waiting_timeout_at` against a *string* (always false), so
 * approval timeouts never fired after recovery.
 */
import { describe, test, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createWorkflowState,
  hydrateWorkflowState,
  CURRENT_STATE_SCHEMA_VERSION,
} from '../src/types/state.js';
import { InMemoryEventLogWriter } from '../src/db/event-log.js';
import { InMemoryPersistenceProvider } from '../src/persistence/in-memory.js';

describe('hydrateWorkflowState', () => {
  test('restores Date fields after a JSON round-trip', () => {
    const original = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      started_at: new Date('2026-03-15T12:00:00Z'),
      waiting_since: new Date('2026-03-15T12:30:00Z'),
      waiting_timeout_at: new Date('2026-03-16T12:30:00Z'),
    });

    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(typeof roundTripped.waiting_timeout_at).toBe('string');

    const hydrated = hydrateWorkflowState(roundTripped);
    expect(hydrated.created_at).toBeInstanceOf(Date);
    expect(hydrated.updated_at).toBeInstanceOf(Date);
    expect(hydrated.started_at).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(hydrated.waiting_since).toEqual(new Date('2026-03-15T12:30:00Z'));
    expect(hydrated.waiting_timeout_at).toEqual(new Date('2026-03-16T12:30:00Z'));
  });

  test('hydrated waiting_timeout_at supports real Date comparison (HITL expiry)', () => {
    const original = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      status: 'waiting',
      waiting_for: 'human_approval',
      // Deadline in the past — an expired approval gate.
      waiting_timeout_at: new Date(Date.now() - 60_000),
    });

    const hydrated = hydrateWorkflowState(JSON.parse(JSON.stringify(original)));
    // Pre-fix, this comparison was string-vs-Date and always false.
    expect(new Date() >= hydrated.waiting_timeout_at!).toBe(true);
    expect(() => hydrated.waiting_timeout_at!.toISOString()).not.toThrow();
  });

  test('hydrates nested timestamps (supervisor_history, memory_drops)', () => {
    const original = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      supervisor_history: [{
        supervisor_id: 's1',
        delegated_to: 'worker',
        reasoning: 'because',
        iteration: 1,
        timestamp: new Date('2026-03-15T12:00:00Z'),
      }],
      memory_drops: [{
        key: 'big',
        reason: 'oversized',
        bytes: 999999,
        timestamp: new Date('2026-03-15T12:01:00Z'),
      }],
    });

    const hydrated = hydrateWorkflowState(JSON.parse(JSON.stringify(original)));
    expect(hydrated.supervisor_history[0].timestamp).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(hydrated.memory_drops[0].timestamp).toEqual(new Date('2026-03-15T12:01:00Z'));
  });

  test('treats unversioned (legacy) snapshots as v1', () => {
    const original = createWorkflowState({ workflow_id: uuidv4(), goal: 'test' });
    const legacy = JSON.parse(JSON.stringify(original));
    delete legacy.state_schema_version;

    const hydrated = hydrateWorkflowState(legacy);
    expect(hydrated.state_schema_version).toBe(CURRENT_STATE_SCHEMA_VERSION);
  });

  test('rejects snapshots from a newer engine version', () => {
    const original = createWorkflowState({ workflow_id: uuidv4(), goal: 'test' });
    const fromTheFuture = {
      ...JSON.parse(JSON.stringify(original)),
      state_schema_version: CURRENT_STATE_SCHEMA_VERSION + 1,
    };

    expect(() => hydrateWorkflowState(fromTheFuture)).toThrow(/newer/);
  });

  test('rejects structurally invalid state instead of letting it into the loop', () => {
    expect(() => hydrateWorkflowState(null)).toThrow();
    expect(() => hydrateWorkflowState({ goal: 'missing everything else' })).toThrow();
    expect(() =>
      hydrateWorkflowState({
        workflow_id: 'not-a-uuid',
        run_id: uuidv4(),
        goal: 'test',
      }),
    ).toThrow();
  });
});

describe('load boundaries hydrate state', () => {
  test('InMemoryEventLogWriter.loadCheckpoint returns real Dates', async () => {
    const eventLog = new InMemoryEventLogWriter();
    const state = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      waiting_timeout_at: new Date('2026-03-16T12:30:00Z'),
    });

    await eventLog.checkpoint(state.run_id, 5, state);
    const checkpoint = await eventLog.loadCheckpoint(state.run_id);

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.state.created_at).toBeInstanceOf(Date);
    expect(checkpoint!.state.waiting_timeout_at).toEqual(new Date('2026-03-16T12:30:00Z'));
  });

  test('InMemoryPersistenceProvider.loadLatestWorkflowState returns real Dates', async () => {
    const persistence = new InMemoryPersistenceProvider();
    const state = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      started_at: new Date('2026-03-15T12:00:00Z'),
    });

    await persistence.saveWorkflowState(state);
    const loaded = await persistence.loadLatestWorkflowState(state.run_id);

    expect(loaded).not.toBeNull();
    expect(loaded!.created_at).toBeInstanceOf(Date);
    expect(loaded!.started_at).toEqual(new Date('2026-03-15T12:00:00Z'));
  });
});
