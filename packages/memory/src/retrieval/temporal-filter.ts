/**
 * Temporal Filter Utilities
 *
 * Filter records by temporal validity windows. Works on any record
 * with `valid_from` and optional `valid_until` fields (Relationship,
 * SemanticFact).
 *
 * @module retrieval/temporal-filter
 */

/** A record with temporal validity fields. */
export interface TemporalRecord {
  valid_from: Date;
  valid_until?: Date;
  invalidated_by?: string;
}

/** Filter options for temporal queries. */
export interface TemporalFilterOptions {
  validAt?: Date;
  changedSince?: Date;
  includeInvalidated?: boolean;
}

/**
 * Check if a record is valid at a specific point in time.
 *
 * A record is valid when `valid_from <= date` and either
 * `valid_until` is not set or `valid_until > date`.
 */
export function isValidAt(record: TemporalRecord, date: Date): boolean {
  if (record.valid_from > date) return false;
  if (record.valid_until && record.valid_until <= date) return false;
  return true;
}

/**
 * Check if a record changed after a specific point in time.
 *
 * A record "changed" if it became valid after the date or
 * was invalidated after the date.
 */
export function isChangedSince(record: TemporalRecord, date: Date): boolean {
  if (record.valid_from > date) return true;
  if (record.valid_until && record.valid_until > date) return true;
  return false;
}

/**
 * Filter a list of temporal records by validity and recency.
 */
export function filterValid<T extends TemporalRecord>(
  records: T[],
  opts: TemporalFilterOptions = {},
): T[] {
  const { validAt, changedSince, includeInvalidated = false } = opts;

  return records.filter((record) => {
    if (!includeInvalidated && record.invalidated_by) return false;
    if (validAt && !isValidAt(record, validAt)) return false;
    if (changedSince && !isChangedSince(record, changedSince)) return false;
    return true;
  });
}
