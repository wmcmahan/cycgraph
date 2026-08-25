/**
 * The parameter-form model, pure: how a schema field renders into a control
 * value and how control values assemble back into the nested params object.
 * The React form is a thin skin over these; the round-trip tests target
 * them directly.
 */

export interface FormField {
  path: string;
  kind: string;
  default?: unknown;
  options?: string[];
  description?: string;
}

/**
 * The string a control shows for a field's default. Arrays render as the
 * comma list they are parsed back from: rendering JSON and reading CSV is
 * how `["a","b"]` becomes three broken strings.
 */
export function displayValue(field: FormField): string {
  if (field.default === undefined) return '';
  if (Array.isArray(field.default)) return field.default.join(',');
  if (typeof field.default === 'object') return JSON.stringify(field.default);
  return String(field.default);
}

/** Parse one control's value by its field kind. Empty means "omit". */
export function parseValue(kind: string, raw: string): unknown {
  if (raw === '') return undefined;
  if (kind === 'number' || kind === 'integer') return Number(raw);
  if (kind === 'boolean') return raw === 'true';
  if (kind === 'array') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'json') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Rebuild the nested params object from dotted paths and raw values. */
export function assembleParams(
  entries: ReadonlyArray<{ path: string; kind: string; value: string }>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const entry of entries) {
    const value = parseValue(entry.kind, entry.value);
    if (value === undefined) continue;

    const segments = entry.path.split('.');
    let cursor = params;
    while (segments.length > 1) {
      const key = segments.shift()!;
      cursor[key] = cursor[key] ?? {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[segments[0]!] = value;
  }
  return params;
}
