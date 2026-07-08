/**
 * Fuzzy Deduplication
 *
 * Trigram Jaccard similarity for near-duplicate detection.
 * Catches duplicates that differ by a few words — what exact
 * dedup misses. Runs after exact dedup to reduce the O(n^2) input.
 *
 * @module memory/dedup/fuzzy
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import { fnv1a, isStructuredContent } from './exact.js';

export interface FuzzyDedupResult {
  /** Items after deduplication. */
  unique: string[];
  /** Number of near-duplicates removed. */
  removed: number;
}

export interface FuzzyDedupOptions {
  /** Jaccard similarity threshold (0-1, default 0.85). */
  threshold?: number;
  /** Minimum character length for comparison (default 20). */
  minLength?: number;
  /** Maximum items to compare pairwise (default 2000). Items beyond the cap pass through undeduped. */
  maxItems?: number;
}

/**
 * Generate the set of character trigrams from a string.
 */
export function trigramSet(text: string): Set<string> {
  const lower = text.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Compute Jaccard similarity between two trigram sets.
 * Returns 0-1 where 1 = identical trigram sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// --- Union-Find for order-independent clustering ---

function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { parent[ra] = rb; }
    else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
    else { parent[rb] = ra; rank[ra]++; }
  }

  return { find, union };
}

// --- MinHash LSH pre-filter for large inputs ---

/**
 * Compute a MinHash signature for a trigram set.
 * For each of k hash functions, takes the minimum hash value across all trigrams.
 * Uses fnv1a with different seeds (appended index) to simulate k independent hash functions.
 */
export function minHashSignature(trigrams: Set<string>, numHashes: number): number[] {
  const signature = new Array<number>(numHashes).fill(0xFFFFFFFF);
  for (const t of trigrams) {
    for (let h = 0; h < numHashes; h++) {
      const val = fnv1a(t + ':' + h);
      if (val < signature[h]) {
        signature[h] = val;
      }
    }
  }
  return signature;
}

/**
 * Locality-Sensitive Hashing: band MinHash signatures and return candidate pairs.
 * Splits each signature into `bands` bands of `rowsPerBand` rows.
 * Items sharing a bucket in ANY band are candidate pairs.
 *
 * @returns Set of pair keys as "i:j" strings where i < j.
 */
export function lshCandidatePairs(
  signatures: number[][],
  bands: number,
  rowsPerBand: number,
): Set<string> {
  const candidates = new Set<string>();
  const n = signatures.length;

  for (let b = 0; b < bands; b++) {
    const offset = b * rowsPerBand;
    // Map bucket hash -> list of item indices
    const buckets = new Map<number, number[]>();

    for (let i = 0; i < n; i++) {
      // Hash the band's rows together
      let bandHash = 0x811c9dc5;
      for (let r = 0; r < rowsPerBand; r++) {
        const val = signatures[i][offset + r];
        // Mix each row value into the band hash
        bandHash ^= val;
        bandHash = (bandHash * 0x01000193) | 0;
      }
      const key = bandHash >>> 0;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      // Add candidate pairs with all existing items in this bucket
      for (const j of bucket) {
        const lo = j < i ? j : i;
        const hi = j < i ? i : j;
        candidates.add(lo + ':' + hi);
      }
      bucket.push(i);
    }
  }

  return candidates;
}

/**
 * Run pairwise fuzzy comparison and return the set of removed indices.
 * Uses union-find clustering so results are order-independent: from each
 * cluster of similar items, the shortest is kept.
 *
 * For inputs > 200 items, uses MinHash LSH pre-filtering to avoid O(n^2)
 * pairwise comparisons. Only candidate pairs identified by LSH are compared.
 *
 * Shared between fuzzyDedup() and the pipeline stage to avoid logic duplication.
 */
function computeRemovedIndices(
  items: string[],
  threshold: number,
  minLength: number,
): Set<number> {
  // Pre-compute trigram sets for eligible items
  const trigramSets = items.map(item => {
    const trimmed = item.trim();
    if (trimmed.length < minLength) return null;
    return { text: trimmed, trigrams: trigramSet(trimmed) };
  });

  const uf = makeUnionFind(items.length);

  const useLSH = items.length > 200;

  if (useLSH) {
    // MinHash LSH pre-filter: 100 hashes, 20 bands of 5 rows
    const numHashes = 100;
    const bands = 20;
    const rowsPerBand = 5;

    // Compute MinHash signatures for eligible items
    const signatures: (number[] | null)[] = trigramSets.map(entry =>
      entry ? minHashSignature(entry.trigrams, numHashes) : null,
    );

    // Build index of eligible items for LSH
    const eligibleIndices: number[] = [];
    const eligibleSignatures: number[][] = [];
    for (let i = 0; i < items.length; i++) {
      if (signatures[i]) {
        eligibleIndices.push(i);
        eligibleSignatures.push(signatures[i]!);
      }
    }

    // Get candidate pairs from LSH
    const candidateKeys = lshCandidatePairs(eligibleSignatures, bands, rowsPerBand);

    // Only compare candidate pairs with full Jaccard
    for (const key of candidateKeys) {
      const sep = key.indexOf(':');
      const ei = parseInt(key.slice(0, sep), 10);
      const ej = parseInt(key.slice(sep + 1), 10);
      // Map back to original indices
      const i = eligibleIndices[ei];
      const j = eligibleIndices[ej];
      const a = trigramSets[i]!;
      const b = trigramSets[j]!;
      if (jaccardSimilarity(a.trigrams, b.trigrams) >= threshold) {
        uf.union(i, j);
      }
    }
  } else {
    // Small input: O(n^2) pairwise comparison
    for (let i = 0; i < items.length; i++) {
      const a = trigramSets[i];
      if (!a) continue;

      for (let j = i + 1; j < items.length; j++) {
        const b = trigramSets[j];
        if (!b) continue;

        if (jaccardSimilarity(a.trigrams, b.trigrams) >= threshold) {
          uf.union(i, j);
        }
      }
    }
  }

  // Group by cluster root
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    if (!trigramSets[i]) continue;
    const root = uf.find(i);
    let group = clusters.get(root);
    if (!group) {
      group = [];
      clusters.set(root, group);
    }
    group.push(i);
  }

  // From each cluster, keep the shortest item; mark the rest as removed
  const removed = new Set<number>();
  for (const members of clusters.values()) {
    if (members.length <= 1) continue;
    let shortest = members[0];
    for (let k = 1; k < members.length; k++) {
      if (trigramSets[members[k]]!.text.length < trigramSets[shortest]!.text.length) {
        shortest = members[k];
      }
    }
    for (const idx of members) {
      if (idx !== shortest) removed.add(idx);
    }
  }

  return removed;
}

/**
 * Deduplicate items by fuzzy similarity, keeping the shorter of duplicates.
 */
export function fuzzyDedup(items: string[], options?: FuzzyDedupOptions): FuzzyDedupResult {
  const threshold = options?.threshold ?? 0.85;
  const minLength = options?.minLength ?? 20;
  const maxItems = options?.maxItems ?? 2000;

  if (items.length > maxItems) {
    console.warn(`context-engine: fuzzy dedup capped at ${maxItems} items (${items.length} provided)`);
    const capped = items.slice(0, maxItems);
    const uncapped = items.slice(maxItems);
    const removed = computeRemovedIndices(capped, threshold, minLength);
    const unique = capped.filter((_, i) => !removed.has(i));
    return { unique: [...unique, ...uncapped], removed: removed.size };
  }

  const removed = computeRemovedIndices(items, threshold, minLength);
  const unique = items.filter((_, i) => !removed.has(i));
  return { unique, removed: removed.size };
}

/**
 * Create a pipeline stage that performs fuzzy deduplication.
 *
 * Splits each segment by paragraph, deduplicates near-duplicates
 * across all segments, and reassembles.
 */
export function createFuzzyDedupStage(options?: FuzzyDedupOptions): CompressionStage {
  return {
    name: 'fuzzy-dedup',
    scope: 'cross-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      // Collect all paragraphs with their segment origin. Structured segments
      // (JSON / CSV) are excluded from the dedup pool entirely — dropping a
      // near-duplicate structural line would corrupt them — and passed through
      // unchanged during reassembly.
      const allParagraphs: { segIdx: number; text: string }[] = [];
      const segmentMeta: { hasDoubleLine: boolean; structured: boolean }[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const structured = isStructuredContent(seg.content);
        const hasDoubleLine = seg.content.includes('\n\n');
        segmentMeta.push({ hasDoubleLine, structured });
        if (structured) continue;
        const paragraphs = hasDoubleLine ? seg.content.split('\n\n') : seg.content.split('\n');
        for (const para of paragraphs) {
          allParagraphs.push({ segIdx: i, text: para });
        }
      }

      // Compute which paragraph indices are near-duplicates
      const texts = allParagraphs.map(p => p.text);
      const threshold = options?.threshold ?? 0.85;
      const minLength = options?.minLength ?? 20;
      const maxItems = options?.maxItems ?? 2000;

      let removedIndices: Set<number>;
      if (texts.length > maxItems) {
        console.warn(`context-engine: fuzzy dedup capped at ${maxItems} items (${texts.length} provided)`);
        const cappedTexts = texts.slice(0, maxItems);
        removedIndices = computeRemovedIndices(cappedTexts, threshold, minLength);
      } else {
        removedIndices = computeRemovedIndices(texts, threshold, minLength);
      }

      // Reconstruct segments from kept paragraphs
      const keptBySegment = new Map<number, string[]>();
      for (let i = 0; i < segments.length; i++) {
        keptBySegment.set(i, []);
      }

      for (let i = 0; i < allParagraphs.length; i++) {
        if (!removedIndices.has(i)) {
          keptBySegment.get(allParagraphs[i].segIdx)!.push(allParagraphs[i].text);
        }
      }

      const output = segments.map((seg, i) => {
        // Structured segments were never added to the pool — return them as-is.
        if (segmentMeta[i].structured) return seg;
        const kept = keptBySegment.get(i) ?? [];
        const separator = segmentMeta[i].hasDoubleLine ? '\n\n' : '\n';
        return { ...seg, content: kept.join(separator) };
      });

      return { segments: output };
    },
  };
}
