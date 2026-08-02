/**
 * state-hydration.test.ts
 *
 * Tests for hydrateWorkflowState — the load-boundary parser that restores
 * Date fields after JSON/jsonb round-trips and applies schema migrations.
 * Regression coverage for the bug where a recovered HITL workflow compared
 * `new Date() >= waiting_timeout_at` against a *string* (always false), so
 * approval timeouts never fired after recovery.
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createWorkflowState,
  hydrateWorkflowState,
  CURRENT_STATE_SCHEMA_VERSION,
} from '../src/types/state.js';
import { InMemoryEventLogWriter } from '../src/db/event-log.js';
import { InMemoryPersistenceProvider } from '../src/persistence/in-memory.js';

describe('hydrateWorkflowState', () => {
  it('restores Date fields after a JSON round-trip', () => {
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

  it('hydrated waiting_timeout_at supports real Date comparison (HITL expiry)', () => {
    const original = createWorkflowState({
      workflow_id: uuidv4(),
      goal: 'test',
      status: 'waiting',
      waiting_for: 'human_approval',
      waiting_timeout_at: new Date(Date.now() - 60_000),
    });

    const hydrated = hydrateWorkflowState(JSON.parse(JSON.stringify(original)));
    expect(new Date() >= hydrated.waiting_timeout_at!).toBe(true);
    expect(() => hydrated.waiting_timeout_at!.toISOString()).not.toThrow();
  });

  it('hydrates nested timestamps (supervisor_history, memory_drops)', () => {
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

  it('treats unversioned (legacy) snapshots as v1', () => {
    const original = createWorkflowState({ workflow_id: uuidv4(), goal: 'test' });
    const legacy = JSON.parse(JSON.stringify(original));
    delete legacy.state_schema_version;

    const hydrated = hydrateWorkflowState(legacy);
    expect(hydrated.state_schema_version).toBe(CURRENT_STATE_SCHEMA_VERSION);
  });

  it('rejects snapshots from a newer engine version', () => {
    const original = createWorkflowState({ workflow_id: uuidv4(), goal: 'test' });
    const fromTheFuture = {
      ...JSON.parse(JSON.stringify(original)),
      state_schema_version: CURRENT_STATE_SCHEMA_VERSION + 1,
    };

    expect(() => hydrateWorkflowState(fromTheFuture)).toThrow(/newer/);
  });

  it('rejects structurally invalid state instead of letting it into the loop', () => {
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
  it('InMemoryEventLogWriter.loadCheckpoint returns real Dates', async () => {
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

  it('InMemoryPersistenceProvider.loadLatestWorkflowState returns real Dates', async () => {
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

describe('state schema v1 → v2 migration', () => {
  const v1Snapshot = () => ({
    state_schema_version: 1,
    workflow_id: '11111111-1111-4111-8111-111111111111',
    run_id: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    goal: 'migrate me',
    constraints: [],
    status: 'waiting',
    memory: {
      user_key: 'stays',
      _taint_registry: { user_key: { source: 'mcp_tool', tool_name: 'fetch', created_at: '2026-01-01T00:00:00.000Z' } },
      _lesson_provenance: { e1: { node_id: 'n', fact_ids: ['f1'], retrieved_at: '2026-01-01T00:00:00.000Z' } },
      _pending_approval: { node_id: 'review' },
      _policy_approved: { sink: true },
      _subgraph_stack: ['g1'],
      _swarm_handoff_count: 3,
      '_subgraph_resume_sub-node': { child: 'checkpoint' },
      _unknown_system_key: 'preserved-not-destroyed',
    },
  });

  it('lifts engine-owned keys into first-class fields', () => {
    const state = hydrateWorkflowState(v1Snapshot());

    expect(state.state_schema_version).toBe(2);
    expect(state.taint_registry.user_key).toMatchObject({ source: 'mcp_tool' });
    expect(state.lesson_provenance.e1.fact_ids).toEqual(['f1']);
    expect(state.pending_approval).toEqual({ node_id: 'review' });
    expect(state.policy_approvals).toEqual({ sink: true });
    expect(state.subgraph_stack).toEqual(['g1']);
    expect(state.swarm_handoff_count).toBe(3);
    expect(state.subgraph_checkpoints['sub-node']).toEqual({ child: 'checkpoint' });
  });

  it('cleans lifted keys from memory but never destroys unknown ones', () => {
    const state = hydrateWorkflowState(v1Snapshot());

    expect(state.memory.user_key).toBe('stays');
    expect(state.memory._taint_registry).toBeUndefined();
    expect(state.memory._lesson_provenance).toBeUndefined();
    expect(state.memory._pending_approval).toBeUndefined();
    expect(state.memory._unknown_system_key).toBe('preserved-not-destroyed');
  });

  it('a v1 snapshot without system keys migrates to empty defaults', () => {
    const raw = v1Snapshot();
    raw.memory = { user_key: 'stays' } as never;
    const state = hydrateWorkflowState(raw);

    expect(state.state_schema_version).toBe(2);
    expect(state.taint_registry).toEqual({});
    expect(state.lesson_provenance).toEqual({});
    expect(state.subgraph_checkpoints).toEqual({});
    expect(state.swarm_handoff_count).toBe(0);
  });

  it('a v2 snapshot passes through unchanged', () => {
    const v2 = { ...v1Snapshot(), state_schema_version: 2, memory: { user_key: 'x' }, taint_registry: {}, lesson_provenance: {}, policy_approvals: {}, subgraph_checkpoints: {}, subgraph_stack: [], swarm_handoff_count: 1 };
    const state = hydrateWorkflowState(v2);
    expect(state.swarm_handoff_count).toBe(1);
  });
});
