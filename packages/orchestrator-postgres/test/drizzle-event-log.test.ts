/**
 * Tests for `drizzle-event-log.ts` — the Postgres-backed EventLogWriter:
 * event append/load, sequence bookkeeping, checkpoint retention, compaction,
 * and split-brain conflict detection.
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDatabaseTests, isDatabaseAvailable, seedRun, getDb } from './setup.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { workflow_checkpoints } from '../src/schema.js';
import { createWorkflowState, EventSequenceConflictError } from '@cycgraph/orchestrator';
import type { WorkflowState } from '@cycgraph/orchestrator';

function makeState(): WorkflowState {
  return createWorkflowState({ workflow_id: crypto.randomUUID(), goal: 'Test' });
}

describe('DrizzleEventLogWriter constructor', () => {
  it('rejects a retain_checkpoints below 1', () => {
    expect(() => new DrizzleEventLogWriter({ retain_checkpoints: 0 })).toThrow(/retain_checkpoints must be >= 1/);
  });

  it('accepts the minimum useful retention of 1', () => {
    expect(() => new DrizzleEventLogWriter({ retain_checkpoints: 1 })).not.toThrow();
  });
});

describe.skipIf(!isDatabaseAvailable())('DrizzleEventLogWriter', () => {
  setupDatabaseTests();

  const writer = new DrizzleEventLogWriter();

  describe('append / loadEvents', () => {
    it('appends and loads events in sequence order', async () => {
      const rid = await seedRun(crypto.randomUUID());
      await writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' });
      await writer.append({ run_id: rid, sequence_id: 1, event_type: 'node_started', node_id: 'start' });

      const events = await writer.loadEvents(rid);

      expect(events).toHaveLength(2);
      expect(events[0].event_type).toBe('workflow_started');
      expect(events[0].sequence_id).toBe(0);
      expect(events[1].event_type).toBe('node_started');
      expect(events[1].node_id).toBe('start');
    });
  });

  describe('loadEventsAfter', () => {
    it('loads only events after the given sequence id', async () => {
      const rid = await seedRun(crypto.randomUUID());
      for (let i = 0; i < 5; i++) {
        await writer.append({
          run_id: rid,
          sequence_id: i,
          event_type: i === 0 ? 'workflow_started' : 'node_started',
          node_id: i > 0 ? `node-${i}` : undefined,
        });
      }

      const after = await writer.loadEventsAfter(rid, 2);

      expect(after).toHaveLength(2);
      expect(after[0].sequence_id).toBe(3);
      expect(after[1].sequence_id).toBe(4);
    });
  });

  describe('getLatestSequenceId', () => {
    it('returns -1 for a run with no events', async () => {
      const latest = await writer.getLatestSequenceId(crypto.randomUUID());

      expect(latest).toBe(-1);
    });

    it('returns the highest sequence id', async () => {
      const rid = await seedRun(crypto.randomUUID());
      await writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' });
      await writer.append({ run_id: rid, sequence_id: 1, event_type: 'node_started' });

      const latest = await writer.getLatestSequenceId(rid);

      expect(latest).toBe(1);
    });
  });

  describe('checkpoint / loadCheckpoint', () => {
    it('saves and loads a checkpoint', async () => {
      const rid = await seedRun(crypto.randomUUID());

      await writer.checkpoint(rid, 5, makeState());
      const cp = await writer.loadCheckpoint(rid);

      expect(cp).not.toBeNull();
      expect(cp!.sequence_id).toBe(5);
      expect(cp!.state.goal).toBe('Test');
    });

    it('returns null when no checkpoint exists', async () => {
      const cp = await writer.loadCheckpoint(crypto.randomUUID());

      expect(cp).toBeNull();
    });

    it('returns the highest-sequence checkpoint when multiple exist', async () => {
      const rid = await seedRun(crypto.randomUUID());

      await writer.checkpoint(rid, 3, makeState());
      await writer.checkpoint(rid, 7, makeState());

      const cp = await writer.loadCheckpoint(rid);

      expect(cp!.sequence_id).toBe(7);
    });

    it('prunes checkpoints beyond the retention window', async () => {
      const RETAIN = 2;
      const retainingWriter = new DrizzleEventLogWriter({ retain_checkpoints: RETAIN });
      const rid = await seedRun(crypto.randomUUID());

      for (const seq of [1, 2, 3, 4]) {
        await retainingWriter.checkpoint(rid, seq, makeState());
      }

      const db = await getDb();
      const rows = await db
        .select({ sequence_id: workflow_checkpoints.sequence_id })
        .from(workflow_checkpoints)
        .where(eq(workflow_checkpoints.run_id, rid));

      expect(rows).toHaveLength(RETAIN);
      expect(rows.map(r => r.sequence_id).sort((a, b) => a - b)).toEqual([3, 4]);
    });
  });

  describe('compact', () => {
    it('deletes events at or before the given sequence id', async () => {
      const rid = await seedRun(crypto.randomUUID());
      for (let i = 0; i < 5; i++) {
        await writer.append({
          run_id: rid,
          sequence_id: i,
          event_type: i === 0 ? 'workflow_started' : 'node_started',
        });
      }

      const deleted = await writer.compact(rid, 2);

      expect(deleted).toBe(3);
      const remaining = await writer.loadEvents(rid);
      expect(remaining).toHaveLength(2);
      expect(remaining[0].sequence_id).toBe(3);
    });
  });

  describe('duplicate-sequence conflict detection', () => {
    it('rejects a duplicate (run_id, sequence_id) with EventSequenceConflictError', async () => {
      const rid = await seedRun(crypto.randomUUID());
      await writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' });

      await expect(
        writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' }),
      ).rejects.toBeInstanceOf(EventSequenceConflictError);

      const events = await writer.loadEvents(rid);
      expect(events).toHaveLength(1);
    });
  });
});
