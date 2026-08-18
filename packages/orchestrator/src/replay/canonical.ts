/**
 * Canonical JSON
 *
 * Serialization with object keys sorted, so two values that differ only in
 * field order compare equal.
 *
 * This is not tidiness. A value that has been through a durable round-trip is
 * field-order-different from the value the run held: Postgres `jsonb` stores
 * object keys in its own order and hands them back that way. So a replayed
 * state and the live state it reconstructs serialize differently while being
 * the same state, and any comparison between them — a run diff, a fidelity
 * check — must not read that as a difference.
 *
 * @module replay/canonical
 */

/** Serialize with object keys sorted, recursively. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // A key whose value is `undefined` vanishes through JSON, so treating it
    // as absent here keeps the live and round-tripped forms equal.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Whether two values are the same once field order is disregarded. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
