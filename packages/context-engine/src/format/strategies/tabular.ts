/**
 * Tabular Serialization Strategy
 *
 * TOON-inspired header + rows format for uniform object arrays.
 * Produces a compact representation with column headers on the first
 * line and values on subsequent lines.
 *
 * @module format/strategies/tabular
 */

/**
 * Serialize a uniform array of objects into tabular format.
 *
 * @example
 * ```ts
 * serializeTabular([
 *   { name: 'Alice', role: 'researcher', score: 92 },
 *   { name: 'Bob', role: 'writer', score: 87 },
 * ]);
 * // => "@name @role @score\nAlice researcher 92\nBob writer 87"
 * ```
 */
export function serializeTabular(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '';

  const keys = Object.keys(data[0]);
  const header = keys.map(k => `@${k}`).join(' ');

  const rows = data.map(row =>
    keys.map(k => formatCellValue(row[k])).join(' '),
  );

  return [header, ...rows].join('\n');
}

/** Whether a cell value would break space-delimited column alignment. */
export function needsQuoting(value: string): boolean {
  return /[ ;,=\n"]/.test(value);
}

/** CSV-style quoting with doubled-quote escaping. */
export function quoteValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '_';

  let raw: string;
  if (Array.isArray(value)) {
    raw = value.map(v => formatPrimitive(v)).join(';');
  } else if (typeof value === 'object') {
    raw = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${formatPrimitive(v)}`)
      .join(',');
  } else {
    raw = formatPrimitive(value);
  }

  return needsQuoting(raw) ? quoteValue(raw) : raw;
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return '_';
  if (value instanceof Date) return value.toISOString();
  // Structure nested deeper than this format flattens: preserve as JSON
  // rather than degrading to '[object Object]'.
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
