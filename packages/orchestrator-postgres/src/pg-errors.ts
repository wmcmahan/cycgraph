/**
 * SQLSTATE predicates
 *
 * Postgres reports constraint failures as codes on the driver error, which
 * `drizzle` wraps. These walk the `cause` chain so a wrapped error is
 * recognised the same as a bare one.
 *
 * @module pg-errors
 */

/** Match a SQLSTATE code on an error or anywhere in its cause chain. */
function hasSqlState(error: unknown, code: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const err = error as { code?: string; cause?: unknown };
  if (err.code === code) return true;
  return hasSqlState(err.cause, code);
}

/** Unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, '23505');
}

/**
 * Foreign-key violation (SQLSTATE 23503).
 *
 * For run-scoped tables this means the referenced run or graph row was never
 * persisted, which otherwise surfaces only as repeated write failures.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasSqlState(error, '23503');
}
