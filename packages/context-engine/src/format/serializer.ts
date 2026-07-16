/**
 * Format Serializer
 *
 * Main entry point for structural format compression. Auto-detects
 * data shape and applies the optimal serialization strategy.
 * Also provides a pipeline stage wrapper.
 *
 * @module format/serializer
 */

import { detectShape, type DataShape } from './detector.js';
import { serializeTabular } from './strategies/tabular.js';
import { serializeFlatObject } from './strategies/flat-object.js';
import { serializeNested } from './strategies/nested.js';
import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';

export interface FormatOptions {
  /** Force a specific serialization strategy instead of auto-detecting. */
  forceShape?: DataShape;
}

/**
 * Serialize any JavaScript value into a token-efficient string format.
 *
 * Auto-detects the data shape and selects the optimal strategy:
 * - `tabular` → TOON-inspired header + rows
 * - `flat-object` → key: value lines
 * - `nested` → YAML-like indentation
 * - `primitive` → String coercion
 * - `mixed` → Falls back to nested serialization
 */
export function serialize(data: unknown, options?: FormatOptions): string {
  const shape = options?.forceShape ?? detectShape(data);

  switch (shape) {
    case 'tabular':
      return serializeTabular(data as Record<string, unknown>[]);
    case 'flat-object':
      return serializeFlatObject(data as Record<string, unknown>);
    case 'nested':
      return serializeNested(data);
    case 'primitive':
      return data === null || data === undefined ? '_' : String(data);
    case 'mixed':
      return serializeNested(data);
  }
}

/**
 * Create a pipeline compression stage that applies format compression.
 *
 * For each segment, attempts to parse content as JSON. If successful,
 * serializes into token-efficient format. Non-JSON segments pass through.
 */
export function createFormatStage(options?: FormatOptions): CompressionStage {
  return {
    name: 'format-compression',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      return {
        segments: segments.map(seg => {
          const compressed = tryFormatCompress(seg.content, options);
          return compressed !== null ? { ...seg, content: compressed } : seg;
        }),
      };
    },
  };
}

/**
 * Attempt to parse content as JSON and serialize to compact format.
 * Returns null if the content is not valid JSON.
 */
function tryFormatCompress(content: string, options?: FormatOptions): string | null {
  const trimmed = content.trim();
  // Quick check: must start with { or [ to be JSON
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;

  try {
    const parsed = JSON.parse(trimmed);
    return serialize(parsed, options);
  } catch {
    return null;
  }
}
