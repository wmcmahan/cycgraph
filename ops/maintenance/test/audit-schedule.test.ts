/**
 * Tests for the audit patrol scheduler (src/audit-schedule.ts) — charter
 * ordering and the persisted last-audited state.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '@cycgraph/memory';
import {
  AUDIT_SCHEDULE_FACT_ID,
  loadAuditSchedule,
  pairKey,
  saveAuditSchedule,
  scheduleCharters,
} from '../src/audit-schedule.js';

const PAIRS = [
  { lens: 'a', scope: 'packages/x' },
  { lens: 'a', scope: 'packages/y' },
  { lens: 'b', scope: 'packages/x' },
  { lens: 'b', scope: 'packages/y' },
];

describe('scheduleCharters', () => {
  it('keeps the incoming order when there is no state at all', () => {
    expect(scheduleCharters(PAIRS, {})).toEqual(PAIRS);
  });

  it('puts changed scopes first, keeping their relative order', () => {
    const ordered = scheduleCharters(PAIRS, { changedScopes: new Set(['packages/y']) });

    expect(ordered.map((p) => p.scope)).toEqual(['packages/y', 'packages/y', 'packages/x', 'packages/x']);
    expect(ordered[0]!.lens).toBe('a');
  });

  it('fills the unchanged remainder oldest-audited-first with never-audited ahead', () => {
    const schedule = {
      pairs: {
        [pairKey('a', 'packages/x')]: '2026-09-09T12:00:00Z',
        [pairKey('b', 'packages/x')]: '2026-09-01T12:00:00Z',
        [pairKey('b', 'packages/y')]: '2026-09-05T12:00:00Z',
      },
    };

    const ordered = scheduleCharters(PAIRS, { schedule });

    expect(ordered.map((p) => pairKey(p.lens, p.scope))).toEqual([
      'a|packages/y',
      'b|packages/x',
      'b|packages/y',
      'a|packages/x',
    ]);
  });

  it('orders changed scopes ahead of even never-audited unchanged pairs', () => {
    const ordered = scheduleCharters(PAIRS, {
      changedScopes: new Set(['packages/x']),
      schedule: { pairs: { [pairKey('a', 'packages/x')]: '2026-09-09T12:00:00Z' } },
    });

    expect(ordered.map((p) => p.scope).slice(0, 2)).toEqual(['packages/x', 'packages/x']);
  });
});

describe('saveAuditSchedule', () => {
  it('round-trips head and per-pair timestamps through the store', async () => {
    const store = new InMemoryMemoryStore();
    const at = new Date('2026-09-09T15:00:00Z');

    await saveAuditSchedule(store, { head: 'abc1234', auditedPairs: [PAIRS[0]!, PAIRS[2]!], at });
    const loaded = await loadAuditSchedule(store);

    expect(loaded?.head).toBe('abc1234');
    expect(loaded?.pairs[pairKey('a', 'packages/x')]).toBe(at.toISOString());
    expect(loaded?.pairs[pairKey('b', 'packages/y')]).toBeUndefined();
  });

  it('merges over prior state so a capped run only advances its own pairs', async () => {
    const store = new InMemoryMemoryStore();

    await saveAuditSchedule(store, {
      head: 'aaa0000', auditedPairs: [PAIRS[0]!], at: new Date('2026-09-08T00:00:00Z'),
    });
    await saveAuditSchedule(store, {
      head: 'bbb1111', auditedPairs: [PAIRS[1]!], at: new Date('2026-09-09T00:00:00Z'),
    });
    const loaded = await loadAuditSchedule(store);

    expect(loaded?.head).toBe('bbb1111');
    expect(loaded?.pairs[pairKey('a', 'packages/x')]).toBe('2026-09-08T00:00:00.000Z');
    expect(loaded?.pairs[pairKey('a', 'packages/y')]).toBe('2026-09-09T00:00:00.000Z');
  });

  it('upserts one fixed-id fact rather than appending state rows', async () => {
    const store = new InMemoryMemoryStore();

    await saveAuditSchedule(store, { head: 'a', auditedPairs: PAIRS, at: new Date() });
    await saveAuditSchedule(store, { head: 'b', auditedPairs: PAIRS, at: new Date() });

    expect(await store.getFact(AUDIT_SCHEDULE_FACT_ID)).not.toBeNull();
    const all = await store.findFacts({ tags: ['audit-schedule'], includeInvalidated: true, limit: 10 });
    expect(all).toHaveLength(1);
  });

  it('returns undefined for missing or corrupt state', async () => {
    const store = new InMemoryMemoryStore();

    expect(await loadAuditSchedule(store)).toBeUndefined();

    await store.putFact({
      id: AUDIT_SCHEDULE_FACT_ID, content: 'not json', source_episode_ids: [], entity_ids: [],
      provenance: { source: 'derived', created_at: new Date() }, valid_from: new Date(), tags: ['audit-schedule'],
    });
    expect(await loadAuditSchedule(store)).toBeUndefined();
  });
});
