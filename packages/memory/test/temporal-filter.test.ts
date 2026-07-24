import { describe, it, expect } from 'vitest';
import { isValidAt, isChangedSince, filterValid } from '../src/index.js';
import type { TemporalRecord } from '../src/index.js';

const jan1 = new Date('2024-01-01');
const feb1 = new Date('2024-02-01');
const mar1 = new Date('2024-03-01');
const apr1 = new Date('2024-04-01');

describe('isValidAt', () => {
  it('returns true when date is within validity window', () => {
    const record: TemporalRecord = { valid_from: jan1, valid_until: mar1 };
    expect(isValidAt(record, feb1)).toBe(true);
  });

  it('returns false before valid_from', () => {
    const record: TemporalRecord = { valid_from: feb1 };
    expect(isValidAt(record, jan1)).toBe(false);
  });

  it('returns false at or after valid_until', () => {
    const record: TemporalRecord = { valid_from: jan1, valid_until: mar1 };
    expect(isValidAt(record, mar1)).toBe(false);
    expect(isValidAt(record, apr1)).toBe(false);
  });

  it('returns true when no valid_until (still valid)', () => {
    const record: TemporalRecord = { valid_from: jan1 };
    expect(isValidAt(record, apr1)).toBe(true);
  });

  it('returns true at exact valid_from', () => {
    const record: TemporalRecord = { valid_from: jan1 };
    expect(isValidAt(record, jan1)).toBe(true);
  });
});

describe('isChangedSince', () => {
  it('returns true when valid_from is after date', () => {
    const record: TemporalRecord = { valid_from: mar1 };
    expect(isChangedSince(record, feb1)).toBe(true);
  });

  it('returns true when valid_until is after date', () => {
    const record: TemporalRecord = { valid_from: jan1, valid_until: mar1 };
    expect(isChangedSince(record, feb1)).toBe(true);
  });

  it('returns false when no changes after date', () => {
    const record: TemporalRecord = { valid_from: jan1, valid_until: feb1 };
    expect(isChangedSince(record, mar1)).toBe(false);
  });

  it('returns false when record started before and has no end', () => {
    const record: TemporalRecord = { valid_from: jan1 };
    expect(isChangedSince(record, feb1)).toBe(false);
  });
});

describe('filterValid', () => {
  const records: (TemporalRecord & { id: string })[] = [
    { id: 'a', valid_from: jan1, valid_until: mar1 },
    { id: 'b', valid_from: feb1 },
    { id: 'c', valid_from: jan1, invalidated_by: 'x' },
  ];

  it('excludes invalidated by default', () => {
    const result = filterValid(records);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('includes invalidated when requested', () => {
    const result = filterValid(records, { includeInvalidated: true });
    expect(result).toHaveLength(3);
  });

  it('filters by validAt', () => {
    const result = filterValid(records, { validAt: feb1 });
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('filters by changedSince', () => {
    const result = filterValid(records, { changedSince: feb1 });
    // 'a' changed (valid_until=mar1 > feb1), 'b' changed (valid_from=feb1 is NOT > feb1)
    expect(result.map((r) => r.id)).toEqual(['a']);
  });
});
