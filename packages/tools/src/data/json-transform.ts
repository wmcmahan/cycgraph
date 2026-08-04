/**
 * json_transform — pure JSON reshaping
 *
 * Extract a value at a dot/bracket path and optionally project a subset of
 * keys, from either a JSON value or a JSON string (LLMs frequently pass
 * stringified payloads). Pure: no taint, no external calls.
 *
 * @module data/json-transform
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link createJsonTransformTool}. */
export interface JsonTransformToolOptions {
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Resolve a dot/bracket path ("orders[0].total", "a.b.0.c") against a value. */
function resolvePath(data: unknown, path: string): unknown {
  const segments = path.split(/[.[\]]+/).filter((s) => s.length > 0);
  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

/** Project an object (or each element of an array of objects) to a key subset. */
function pickKeys(value: unknown, keys: string[]): unknown {
  const pickOne = (obj: Record<string, unknown>) =>
    Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? pickOne(item as Record<string, unknown>)
        : item,
    );
  }
  if (value !== null && typeof value === 'object') {
    return pickOne(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Create the `json_transform` tool.
 */
export function createJsonTransformTool(options: JsonTransformToolOptions = {}): DefinedTool {
  return defineTool({
    name: 'json_transform',
    description:
      'Extract and reshape JSON: resolve a dot/bracket path like "orders[0].total" and ' +
      'optionally pick a subset of keys from the result. Accepts a JSON value or a JSON string.',
    parameters: z.object({
      data: z.unknown().describe('The JSON value, or a JSON-encoded string'),
      path: z.string().optional().describe('Dot/bracket path to resolve, e.g. "orders[0].total"'),
      pick: z
        .array(z.string())
        .optional()
        .describe('Keys to keep on the result object (or each element of a result array)'),
    }),
    timeoutMs: options.timeoutMs ?? 5_000,
    execute: ({ data, path, pick }) => {
      let value: unknown = data;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          throw new Error('data is a string but not valid JSON');
        }
      }

      if (path) value = resolvePath(value, path);
      if (pick && pick.length > 0) value = pickKeys(value, pick);

      return { result: value === undefined ? null : value };
    },
  });
}
