/**
 * Community Formatter
 *
 * Formats pre-clustered community summaries (from GraphRAG/Leiden)
 * into compact hierarchical prompt blocks.
 *
 * @module memory/graph/community-formatter
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import type { CommunitySummary } from '../hierarchy/types.js';

export interface CommunityFormatOptions {
  /** Maximum communities to include (default: 20). */
  maxCommunities?: number;
  /** Maximum summary length in characters per community (default: 500). */
  maxSummaryLength?: number;
  /** Sort by weight descending (default: true). */
  sortByRelevance?: boolean;
  /** Only include communities at or below this level (default: no filter). */
  maxLevel?: number;
}

/**
 * Format community summaries into compact prompt text.
 */
export function formatCommunities(
  communities: CommunitySummary[],
  options?: CommunityFormatOptions,
): string {
  const maxCommunities = options?.maxCommunities ?? 20;
  const maxSummaryLength = options?.maxSummaryLength ?? 500;
  const sortByRelevance = options?.sortByRelevance ?? true;
  const maxLevel = options?.maxLevel;

  let filtered = maxLevel !== undefined
    ? communities.filter(c => c.level <= maxLevel)
    : [...communities];

  if (sortByRelevance) {
    filtered.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  }

  filtered = filtered.slice(0, maxCommunities);

  if (filtered.length === 0) return '';

  const lines: string[] = ['Communities:'];

  for (const community of filtered) {
    const header = `${community.label} (level ${community.level}, ${community.entity_ids.length} entities)`;
    const summary = community.summary.length > maxSummaryLength
      ? community.summary.slice(0, maxSummaryLength) + '...'
      : community.summary;

    lines.push(`  - ${header}`);
    lines.push(`    ${summary}`);
  }

  return lines.join('\n');
}

/**
 * Create a pipeline stage that formats community summaries.
 * Detects segments with `metadata.contentType === 'community'`.
 */
export function createCommunityFormatterStage(options?: CommunityFormatOptions): CompressionStage {
  return {
    name: 'community-formatter',
    // Each segment is transformed independently — safe for per-segment caching.
    scope: 'per-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      return {
        segments: segments.map(seg => {
          if (seg.metadata?.contentType !== 'community') return seg;

          try {
            const parsed = JSON.parse(seg.content) as CommunitySummary[];
            const formatted = formatCommunities(parsed, options);
            return { ...seg, content: formatted };
          } catch {
            return seg;
          }
        }),
      };
    },
  };
}
