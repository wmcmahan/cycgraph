/**
 * UUID Validation
 *
 * Validates agent IDs before they reach the database layer to prevent
 * PostgreSQL "invalid input syntax for type uuid" errors.
 *
 * @module agent-factory/validation
 */

/** RFC 4122 UUID pattern (case-insensitive). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Test whether a string is a valid UUID (RFC 4122 format).
 *
 * Used as a pre-check before database queries to avoid sending malformed
 * IDs to PostgreSQL, which would throw a driver-level error.
 *
 * @param value - The string to validate.
 * @returns `true` if the string matches UUID format, `false` otherwise.
 *
 * @example
 * ```ts
 * isValidUUID('550e8400-e29b-41d4-a716-446655440000'); // true
 * isValidUUID('not-a-uuid');                            // false
 * ```
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}
