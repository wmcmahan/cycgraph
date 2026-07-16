/**
 * Hierarchy Formatter
 *
 * Formats pre-built xMemory hierarchy payloads (themes → facts → episodes)
 * into token-efficient prompt blocks. Uses top-down structure: themes first,
 * facts grouped by theme, episodes as summaries.
 *
 * @module memory/hierarchy/hierarchy-formatter
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import type {
  MemoryPayload,
  HierarchyTheme,
  HierarchyFact,
  HierarchyEpisode,
} from './types.js';

export interface HierarchyFormatOptions {
  /** Include full message content for episodes (default: false, show summary). */
  includeMessages?: boolean;
  /** Maximum episodes to include (default: 10, most recent). */
  maxEpisodes?: number;
  /** Maximum facts per theme (default: 20). */
  maxFactsPerTheme?: number;
  /** Date format: 'date' (2026-04-01) or 'datetime' (2026-04-01T14:00) (default: 'date'). */
  dateFormat?: 'date' | 'datetime';
  /** Omit themes with zero matching facts (default: true). */
  skipEmptyThemes?: boolean;
}

/**
 * Format a memory payload into a token-efficient hierarchical string.
 *
 * Output structure:
 * - Themes with grouped facts (most recent first)
 * - Orphan facts under "Ungrouped"
 * - Episode summaries (most recent first)
 */
export function formatHierarchy(
  payload: MemoryPayload,
  options?: HierarchyFormatOptions,
): string {
  const includeMessages = options?.includeMessages ?? false;
  const maxEpisodes = options?.maxEpisodes ?? 10;
  const maxFactsPerTheme = options?.maxFactsPerTheme ?? 20;
  const dateFormat = options?.dateFormat ?? 'date';
  const skipEmptyThemes = options?.skipEmptyThemes ?? true;

  // Defensive: ensure Date objects are actual Dates (handles both Date and string inputs)
  // This avoids mutating the caller's payload by only converting when needed.
  const facts = (payload.facts ?? []).map(f => ({
    ...f,
    valid_from: f.valid_from instanceof Date ? f.valid_from : new Date(f.valid_from as unknown as string),
    valid_until: f.valid_until
      ? (f.valid_until instanceof Date ? f.valid_until : new Date(f.valid_until as unknown as string))
      : undefined,
  }));
  const episodes = (payload.episodes ?? []).map(e => ({
    ...e,
    started_at: e.started_at instanceof Date ? e.started_at : new Date(e.started_at as unknown as string),
    ended_at: e.ended_at instanceof Date ? e.ended_at : new Date(e.ended_at as unknown as string),
  }));

  const lines: string[] = [];

  // Build fact lookup
  const factMap = new Map<string, HierarchyFact>();
  for (const fact of facts) {
    factMap.set(fact.id, fact);
  }

  // ── Themes with grouped facts ──
  const themes = payload.themes ?? [];
  if (themes.length > 0) {
    lines.push('Themes:');

    for (const theme of themes) {
      const themeFacts = theme.fact_ids
        .map(id => factMap.get(id))
        .filter((f): f is HierarchyFact => f !== undefined)
        .sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime())
        .slice(0, maxFactsPerTheme);

      if (skipEmptyThemes && themeFacts.length === 0) continue;

      lines.push(`  - ${theme.label}`);
      if (themeFacts.length > 0) {
        lines.push('    Facts:');
        for (const fact of themeFacts) {
          const date = formatDate(fact.valid_from, dateFormat);
          const validity = fact.valid_until
            ? ` (${date} – ${formatDate(fact.valid_until, dateFormat)})`
            : ` (${date})`;
          lines.push(`      - ${fact.content}${validity}`);
        }
      }
    }
  }

  // ── Orphan facts (no theme_id or theme not in themes list) ──
  const themedFactIds = new Set(themes.flatMap(t => t.fact_ids));
  const orphanFacts = facts
    .filter(f => !themedFactIds.has(f.id))
    .sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime());

  if (orphanFacts.length > 0) {
    lines.push('Ungrouped Facts:');
    for (const fact of orphanFacts.slice(0, maxFactsPerTheme)) {
      const date = formatDate(fact.valid_from, dateFormat);
      lines.push(`  - ${fact.content} (${date})`);
    }
  }

  // ── Episodes ──
  const sortedEpisodes = episodes
    .sort((a, b) => b.ended_at.getTime() - a.ended_at.getTime())
    .slice(0, maxEpisodes);

  if (sortedEpisodes.length > 0) {
    lines.push('Recent Episodes:');
    for (const ep of sortedEpisodes) {
      const timeRange = `${formatDate(ep.started_at, 'datetime')} – ${formatDate(ep.ended_at, 'datetime')}`;
      const summary = `${ep.topic} (${timeRange}, ${ep.messages.length} msgs, ${ep.fact_ids.length} facts)`;
      lines.push(`  - ${summary}`);

      if (includeMessages) {
        for (const msg of ep.messages) {
          lines.push(`    [${msg.role}] ${msg.content}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Create a pipeline stage that formats hierarchy data.
 *
 * Detects segments with `metadata.contentType === 'hierarchy'`,
 * parses as MemoryPayload, and formats. Other segments pass through.
 */
export function createHierarchyFormatterStage(options?: HierarchyFormatOptions): CompressionStage {
  return {
    name: 'hierarchy-formatter',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      return {
        segments: segments.map(seg => {
          if (seg.metadata?.contentType !== 'hierarchy') return seg;

          try {
            // JSON.parse produces a fresh object — safe to revive in place
            const payload = JSON.parse(seg.content) as MemoryPayload;
            reviveDates(payload);
            const formatted = formatHierarchy(payload, options);
            return { ...seg, content: formatted };
          } catch {
            return seg; // not valid JSON or not a MemoryPayload — pass through
          }
        }),
      };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatDate(d: Date | string, format: 'date' | 'datetime'): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (format === 'date') {
    return date.toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** Revive Date strings from JSON.parse back to Date objects. */
function reviveDates(payload: MemoryPayload): void {
  for (const fact of payload.facts ?? []) {
    if (typeof fact.valid_from === 'string') fact.valid_from = new Date(fact.valid_from);
    if (typeof fact.valid_until === 'string') fact.valid_until = new Date(fact.valid_until as string);
  }
  for (const ep of payload.episodes ?? []) {
    if (typeof ep.started_at === 'string') ep.started_at = new Date(ep.started_at);
    if (typeof ep.ended_at === 'string') ep.ended_at = new Date(ep.ended_at);
    for (const msg of ep.messages) {
      if (typeof msg.timestamp === 'string') msg.timestamp = new Date(msg.timestamp);
    }
  }
}
