/**
 * Data Shape Detector
 *
 * Inspects a parsed JavaScript value and classifies it into one of
 * five structural shapes. The detected shape drives format strategy
 * selection in the serializer.
 *
 * @module format/detector
 */

export type DataShape = 'tabular' | 'flat-object' | 'nested' | 'primitive' | 'mixed';

/**
 * Detect the structural shape of a parsed data value.
 *
 * - `tabular`: array of objects that all share the same keys
 * - `flat-object`: plain object with all primitive-valued properties
 * - `nested`: plain object with at least one non-primitive property
 * - `primitive`: string, number, boolean, or null
 * - `mixed`: non-uniform arrays or anything else
 */
export function detectShape(data: unknown): DataShape {
  if (data === null || data === undefined) return 'primitive';
  if (typeof data !== 'object') return 'primitive';

  if (Array.isArray(data)) {
    return detectArrayShape(data);
  }

  return detectObjectShape(data as Record<string, unknown>);
}

function detectArrayShape(arr: unknown[]): DataShape {
  if (arr.length === 0) return 'mixed';

  // Check if all elements are plain objects with identical keys
  const firstItem = arr[0];
  if (firstItem === null || typeof firstItem !== 'object' || Array.isArray(firstItem)) {
    return 'mixed';
  }

  // Fingerprint via JSON so keys containing the join delimiter can't collide
  // (e.g. a single key "a,b" vs the two keys "a" and "b").
  const firstKeys = Object.keys(firstItem as Record<string, unknown>);
  if (firstKeys.length === 0) return 'mixed';
  const referenceKeys = JSON.stringify(firstKeys.sort());

  for (let i = 1; i < arr.length; i++) {
    const item = arr[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return 'mixed';
    }
    const keys = JSON.stringify(Object.keys(item as Record<string, unknown>).sort());
    if (keys !== referenceKeys) return 'mixed';
  }

  return 'tabular';
}

function detectObjectShape(obj: Record<string, unknown>): DataShape {
  const keys = Object.keys(obj);
  if (keys.length === 0) return 'flat-object';

  for (const key of keys) {
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      return 'nested';
    }
  }

  return 'flat-object';
}
