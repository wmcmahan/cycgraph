/**
 * Exact Deduplication
 *
 * Hash-based exact duplicate removal using FNV-1a. Splits content
 * into paragraphs, hashes each, and keeps only the first occurrence.
 * Works across multiple segments (cross-segment dedup).
 *
 * @module memory/dedup/exact
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';

export interface DedupResult {
  /** Unique items after deduplication. */
  unique: string[];
  /** Number of duplicates removed. */
  removed: number;
}

/**
 * Deduplicate an array of strings, keeping the first occurrence of each.
 * Uses FNV-1a hash for fast, deterministic duplicate detection.
 */
export function dedup(items: string[]): DedupResult {
  const seen = new Set<number>();
  const unique: string[] = [];
  let removed = 0;

  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === '') {
      unique.push(item);
      continue;
    }

    const hash = fnv1a(trimmed);
    if (seen.has(hash)) {
      removed++;
    } else {
      seen.add(hash);
      unique.push(item);
    }
  }

  return { unique, removed };
}

/**
 * Create a pipeline stage that performs exact deduplication.
 *
 * Splits each segment's content by double-newline (paragraph boundaries),
 * deduplicates across all mutable segments, and reassembles.
 */
export function createExactDedupStage(): CompressionStage {
  return {
    name: 'exact-dedup',
    // Dedup runs across ALL segments (shared `seen` set below), so it must be
    // declared cross-segment. Otherwise the incremental pipeline runs it on the
    // fresh-segment subset only and a duplicate spanning a cached + a fresh
    // segment survives — batch and incremental would diverge for identical input.
    scope: 'cross-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      // Collect all paragraphs across segments with their origin
      const seen = new Set<number>();
      const output: PromptSegment[] = [];

      for (const seg of segments) {
        // Structured content (JSON / CSV) must never be line-deduped: dropping a
        // repeated structural line (`},`, an identical CSV row, a duplicate
        // import) produces invalid JSON or silently loses data rows. Pass it
        // through untouched.
        if (isStructuredContent(seg.content)) {
          output.push(seg);
          continue;
        }

        const hasDoubleLine = seg.content.includes('\n\n');
        const paragraphs = splitParagraphs(seg.content);
        const kept: string[] = [];

        for (const para of paragraphs) {
          const trimmed = para.trim();
          if (trimmed === '') {
            kept.push(para);
            continue;
          }

          const hash = fnv1a(trimmed);
          if (!seen.has(hash)) {
            seen.add(hash);
            kept.push(para);
          }
        }

        const separator = hasDoubleLine ? '\n\n' : '\n';
        output.push({ ...seg, content: kept.join(separator) });
      }

      return { segments: output };
    },
  };
}

/**
 * Split content into paragraphs (double-newline separated).
 * Preserves line-based content by also splitting on single newlines
 * when no double-newlines are present.
 */
function splitParagraphs(content: string): string[] {
  if (content.includes('\n\n')) {
    return content.split('\n\n');
  }
  return content.split('\n');
}

/**
 * Whether content is structured data (JSON or CSV/TSV) whose lines are NOT
 * safely deduplicable — dropping a repeated line would corrupt it. Shared by
 * the exact and fuzzy dedup stages.
 */
export function isStructuredContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '') return false;

  // Valid JSON object/array.
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not valid JSON — fall through to the delimiter check.
    }
  }

  // CSV/TSV: two or more non-empty lines that all share a common delimiter.
  const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
  if (lines.length >= 2) {
    for (const delim of [',', '\t', ';']) {
      if (lines.every((l) => l.includes(delim))) return true;
    }
  }

  return false;
}

/**
 * FNV-1a hash (32-bit). Fast, deterministic, good distribution.
 * Pure TypeScript — no crypto dependency.
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0; // FNV prime, force 32-bit integer
  }
  return hash >>> 0; // Ensure unsigned
}
