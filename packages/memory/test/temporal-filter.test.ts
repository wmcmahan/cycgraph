/**
 * Tests for retrieval/temporal-filter: point-in-time validity, recency, and
 * list filtering over records with `valid_from` / `valid_until`.
 */

import { describe, it, expect } from 'vitest';
import { isValidAt, isChangedSince, filterValid } from '../src/index.js';
import type { TemporalRecord } from '../src/index.js';

const JAN1 = new Date('2024-01-01');
const FEB1 = new Date('2024-02-01');
const MAR1 = new Date('2024-03-01');
const APR1 = new Date('2024-04-01');

describe('isValidAt', () => {
  it('returns true when date is within the validity window', () => {
    const record: TemporalRecord = { valid_from: JAN1, valid_until: MAR1 };

    expect(isValidAt(record, FEB1)).toBe(true);
  });

  it('returns false before valid_from', () => {
    const record: TemporalRecord = { valid_from: FEB1 };

    expect(isValidAt(record, JAN1)).toBe(false);
  });

  it('returns false at valid_until', () => {
    const record: TemporalRecord = { valid_from: JAN1, valid_until: MAR1 };

    expect(isValidAt(record, MAR1)).toBe(false);
  });

  it('returns false after valid_until', () => {
    const record: TemporalRecord = { valid_from: JAN1, valid_until: MAR1 };

    expect(isValidAt(record, APR1)).toBe(false);
  });

  it('returns true when no valid_until is set', () => {
    const record: TemporalRecord = { valid_from: JAN1 };

    expect(isValidAt(record, APR1)).toBe(true);
  });

  it('returns true at the exact valid_from instant', () => {
    const record: TemporalRecord = { valid_from: JAN1 };

    expect(isValidAt(record, JAN1)).toBe(true);
  });
});

describe('isChangedSince', () => {
  it('returns true when valid_from is after the date', () => {
    const record: TemporalRecord = { valid_from: MAR1 };

    expect(isChangedSince(record, FEB1)).toBe(true);
  });

  it('returns true when valid_until is after the date', () => {
    const record: TemporalRecord = { valid_from: JAN1, valid_until: MAR1 };

    expect(isChangedSince(record, FEB1)).toBe(true);
  });

  it('returns false when the record neither started nor ended after the date', () => {
    const record: TemporalRecord = { valid_from: JAN1, valid_until: FEB1 };

    expect(isChangedSince(record, MAR1)).toBe(false);
  });

  it('returns false when the record started before and has no end', () => {
    const record: TemporalRecord = { valid_from: JAN1 };

    expect(isChangedSince(record, FEB1)).toBe(false);
  });
});

describe('filterValid', () => {
  const records: (TemporalRecord & { id: string })[] = [
    { id: 'a', valid_from: JAN1, valid_until: MAR1 },
    { id: 'b', valid_from: FEB1 },
    { id: 'c', valid_from: JAN1, invalidated_by: 'x' },
  ];

  it('excludes invalidated records by default', () => {
    const result = filterValid(records);

    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('includes invalidated records when requested', () => {
    const result = filterValid(records, { includeInvalidated: true });

    expect(result).toHaveLength(3);
  });

  it('filters by validAt', () => {
    const result = filterValid(records, { validAt: FEB1 });

    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('filters by changedSince, excluding records unchanged at the boundary', () => {
    const result = filterValid(records, { changedSince: FEB1 });

    expect(result.map((r) => r.id)).toEqual(['a']);
  });
});
