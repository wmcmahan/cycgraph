/**
 * Format Selector
 *
 * Selects the optimal compression format based on the target model's
 * capability profile. Small models that need JSON get compact JSON;
 * capable models get TOON-style tabular or YAML-like nested formats.
 *
 * @module routing/format-selector
 */

import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';
import type { DataShape } from '../format/detector.js';
import { detectShape } from '../format/detector.js';
import { serialize } from '../format/serializer.js';
import { resolveModelProfile, type ModelProfile } from './model-profiles.js';

export interface FormatSelectorOptions {
  /** Custom model profiles, matched by prefix before the built-ins. */
  customProfiles?: Record<string, ModelProfile>;
  /** Override: force JSON output regardless of model. */
  forceJson?: boolean;
}

export interface FormatSelection {
  /**
   * Format decision: `'json'` = compact JSON, `'nested'` = force the nested
   * strategy (model can't read tabular), `'auto'` = detect shape per value.
   */
  dataShape: DataShape | 'json' | 'auto';
  /** Whether to use compact JSON (no indent) instead of custom formats. */
  useCompactJson: boolean;
}

/** Resolve a profile, checking custom profiles (by prefix) before built-ins. */
function resolveProfile(
  model?: string,
  customProfiles?: Record<string, ModelProfile>,
): ModelProfile | undefined {
  if (model && customProfiles) {
    const lower = model.toLowerCase();
    for (const [prefix, profile] of Object.entries(customProfiles)) {
      if (lower.startsWith(prefix.toLowerCase())) return profile;
    }
  }
  return resolveModelProfile(model);
}

/**
 * Select the optimal format for a given model.
 *
 * - Models with `prefersJson: true` → compact JSON
 * - Models without tabular support → nested only
 * - Default / unknown model → auto-detect shape
 */
export function selectFormat(model?: string, options?: FormatSelectorOptions): FormatSelection {
  if (options?.forceJson) {
    return { dataShape: 'json', useCompactJson: true };
  }

  const profile = resolveProfile(model, options?.customProfiles);

  if (!profile) {
    // No profile — fall back to auto-detect
    return { dataShape: 'auto', useCompactJson: false };
  }

  if (profile.prefersJson) {
    return { dataShape: 'json', useCompactJson: true };
  }

  if (!profile.supportsTabular) {
    return { dataShape: 'nested', useCompactJson: false };
  }

  // Full support — use auto-detect
  return { dataShape: 'auto', useCompactJson: false };
}

/**
 * Create a pipeline stage that selects format based on model profile.
 *
 * For segments with JSON content:
 * - If model prefers JSON → replace with compact JSON (no indent)
 * - If model lacks tabular support → force nested format
 * - Otherwise → auto-detect shape (default behavior)
 */
export function createFormatSelectorStage(options?: FormatSelectorOptions): CompressionStage {
  return {
    name: 'format-selector',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], context: StageContext) {
      const selection = selectFormat(context.model, options);

      return {
        segments: segments.map(seg => {
          // Skip segments tagged for specialized formatters (hierarchy, graph, community)
          if (seg.metadata?.contentType) return seg;

          const trimmed = seg.content.trim();
          if (trimmed[0] !== '{' && trimmed[0] !== '[') return seg;

          try {
            const parsed = JSON.parse(trimmed);

            if (selection.useCompactJson) {
              // Compact JSON — no indent, minimal whitespace
              return { ...seg, content: JSON.stringify(parsed) };
            }

            if (selection.dataShape === 'nested') {
              // Model can't read tabular — force the nested strategy
              return { ...seg, content: serialize(parsed, { forceShape: 'nested' }) };
            }

            // Auto-detect shape
            const shape = detectShape(parsed);
            return { ...seg, content: serialize(parsed, { forceShape: shape }) };
          } catch {
            return seg;
          }
        }),
      };
    },
  };
}
