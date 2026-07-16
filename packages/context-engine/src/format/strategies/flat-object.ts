/**
 * Flat Object Serialization Strategy
 *
 * Key-value format with minimal delimiters for objects whose
 * properties are all primitives.
 *
 * @module format/strategies/flat-object
 */

/**
 * Serialize a flat object (all primitive values) into compact key-value format.
 *
 * @example
 * ```ts
 * serializeFlatObject({ name: 'Alice', role: 'researcher', score: 92 });
 * // => "name: Alice\nrole: researcher\nscore: 92"
 * ```
 */
export function serializeFlatObject(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '_';
  if (value instanceof Date) return value.toISOString();
  // Only reachable via forceShape (auto-detection guarantees primitives):
  // preserve structure as JSON rather than degrading to '[object Object]'.
  if (typeof value === 'object') return JSON.stringify(value);
  // A raw newline would break the line-per-key structure — quote it away.
  if (typeof value === 'string' && value.includes('\n')) return JSON.stringify(value);
  return String(value);
}
