/**
 * Nested Serialization Strategy
 *
 * YAML-like indentation-based format for complex nested objects.
 * Uses 2-space indentation, `- ` for array items, and unquoted
 * strings where possible.
 *
 * @module format/strategies/nested
 */

/**
 * Serialize a nested value into indentation-based format.
 *
 * @example
 * ```ts
 * serializeNested({ user: { name: 'Alice', tags: ['a', 'b'] } });
 * // => "user:\n  name: Alice\n  tags:\n    - a\n    - b"
 * ```
 */
export function serializeNested(data: unknown, indent: number = 0): string {
  if (data === null || data === undefined) return '_';

  if (typeof data !== 'object') {
    return formatPrimitive(data);
  }

  if (Array.isArray(data)) {
    return serializeArray(data, indent);
  }

  return serializeObject(data as Record<string, unknown>, indent);
}

function serializeObject(obj: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';

  const prefix = ' '.repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      lines.push(`${prefix}${key}: _`);
    } else if (typeof value !== 'object') {
      lines.push(`${prefix}${key}: ${formatPrimitive(value)}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${prefix}${key}: []`);
      } else {
        lines.push(`${prefix}${key}:`);
        lines.push(serializeArray(value, indent + 2));
      }
    } else {
      const childEntries = Object.keys(value as Record<string, unknown>);
      if (childEntries.length === 0) {
        lines.push(`${prefix}${key}: {}`);
      } else {
        lines.push(`${prefix}${key}:`);
        lines.push(serializeObject(value as Record<string, unknown>, indent + 2));
      }
    }
  }

  return lines.join('\n');
}

function serializeArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) return '[]';

  const prefix = ' '.repeat(indent);
  const lines: string[] = [];

  for (const item of arr) {
    if (item === null || item === undefined || typeof item !== 'object') {
      lines.push(`${prefix}- ${formatPrimitive(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${prefix}-`);
      lines.push(serializeArray(item, indent + 2));
    } else {
      // Inline first key on the `- ` line, indent rest
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${prefix}- {}`);
      } else {
        const [firstKey, firstVal] = entries[0];
        const firstLine = formatInlineValue(firstKey, firstVal, indent + 2);
        lines.push(`${prefix}- ${firstLine}`);

        for (let i = 1; i < entries.length; i++) {
          const [key, value] = entries[i];
          const line = formatInlineValue(key, value, indent + 2);
          lines.push(`${' '.repeat(indent + 2)}${line}`);
        }
      }
    }
  }

  return lines.join('\n');
}

function formatInlineValue(key: string, value: unknown, indent: number): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return `${key}: ${formatPrimitive(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return `${key}:\n${serializeArray(value, indent + 2)}`;
  }

  const entries = Object.keys(value as Record<string, unknown>);
  if (entries.length === 0) return `${key}: {}`;
  return `${key}:\n${serializeObject(value as Record<string, unknown>, indent + 2)}`;
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return '_';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    // Quote strings that contain special characters
    if (value === '' || /^[\s#\-[\]{},:|>!&*?'"@$`]/.test(value) || value.includes(': ') || value.includes('\n')) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}
