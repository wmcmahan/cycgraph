/**
 * Tests for the recency helpers (src/insights/recency.ts).
 */

import { describe, it, expect } from 'vitest';
import { latestStart, seenAt, startTimes } from '../../src/insights/recency.js';
import { run } from './helpers.js';

const EARLY = '2026-08-01T00:00:00.000Z';
const LATE = '2026-08-17T00:00:00.000Z';

describe('startTimes', () => {
  it('indexes start times by run id', () => {
    const times = startTimes([run({ runId: 'a', startedAt: EARLY })]);

    expect(times.get('a')).toBe(EARLY);
  });

  it('omits runs that recorded no start time', () => {
    const times = startTimes([run({ runId: 'a' })]);

    expect(times.size).toBe(0);
  });
});

describe('latestStart', () => {
  it('returns the most recent start among the runs', () => {
    const times = startTimes([
      run({ runId: 'a', startedAt: EARLY }),
      run({ runId: 'b', startedAt: LATE }),
    ]);

    expect(latestStart(['a', 'b'], times)).toBe(LATE);
  });

  it('ignores run ids the index does not know', () => {
    const times = startTimes([run({ runId: 'a', startedAt: EARLY })]);

    expect(latestStart(['a', 'missing'], times)).toBe(EARLY);
  });

  it('returns nothing when no run recorded a start time', () => {
    expect(latestStart(['a'], new Map())).toBeUndefined();
  });
});

describe('seenAt', () => {
  it('produces a lastSeen field when a time is known', () => {
    const times = startTimes([run({ runId: 'a', startedAt: LATE })]);

    expect(seenAt(['a'], times)).toEqual({ lastSeen: LATE });
  });

  it('produces nothing to spread when no time is known', () => {
    expect(seenAt(['a'], new Map())).toEqual({});
  });
});
