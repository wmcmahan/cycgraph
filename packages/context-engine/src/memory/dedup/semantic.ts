/**
 * Semantic Deduplication
 *
 * Embedding-based near-duplicate detection via cosine similarity.
 * Requires an EmbeddingProvider — semantic features are disabled
 * without one. Supports pre-computed embeddings for sync pipeline
 * execution.
 *
 * @module memory/dedup/semantic
 */

import type { EmbeddingProvider } from '../../providers/types.js';
import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';
import { fnv1a } from '../dedup/exact.js';

export interface SemanticDedupOptions {
  /** Cosine similarity threshold for duplicate detection (default 0.90). */
  threshold?: number;
  /** Minimum character length for comparison (default 20). */
  minLength?: number;
  /** Embedding provider (required). */
  provider: EmbeddingProvider;
  /** Pre-computed embeddings keyed by text content. */
  precomputed?: Map<string, number[]>;
  /** Maximum items to compare (default 2000). When over 200 items, SimHash LSH pre-filters candidate pairs to avoid O(n²). Items beyond the cap pass through undeduped. */
  maxItems?: number;
}

/**
 * Pre-compute embeddings for all paragraph-level content in segments.
 * Call this async function before pipeline.compress() to enable
 * synchronous semantic dedup inside the pipeline.
 */
export async function precomputeEmbeddings(
  segments: PromptSegment[],
  provider: EmbeddingProvider,
  minLength: number = 20,
): Promise<Map<string, number[]>> {
  const texts: string[] = [];
  const textSet = new Set<string>();

  for (const seg of segments) {
    const paragraphs = seg.content.includes('\n\n')
      ? seg.content.split('\n\n')
      : seg.content.split('\n');

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length >= minLength && !textSet.has(trimmed)) {
        texts.push(trimmed);
        textSet.add(trimmed);
      }
    }
  }

  if (texts.length === 0) return new Map();

  const vectors = await provider.embed(texts);
  const map = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    map.set(texts[i], vectors[i]);
  }
  return map;
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

/**
 * Create a pipeline stage that deduplicates paragraphs by semantic similarity.
 *
 * Uses union-find clustering for correct transitive dedup: if A~B and B~C,
 * all three are grouped and only the longest survives.
 *
 * Uses pre-computed embeddings when available; otherwise skips paragraphs
 * without embeddings (does not call the provider at runtime since the
 * pipeline is synchronous).
 */
export function createSemanticDedupStage(options: SemanticDedupOptions): CompressionStage {
  const threshold = options.threshold ?? 0.90;
  const minLength = options.minLength ?? 20;
  const precomputed = options.precomputed;

  return {
    name: 'semantic-dedup',
    // Clusters across ALL segments, so it must run on the full set — see the
    // note in exact-dedup. Without this the incremental pipeline would only
    // dedup within the fresh subset.
    scope: 'cross-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      if (!precomputed || precomputed.size === 0) {
        // No pre-computed embeddings — pass through (graceful degradation)
        return { segments };
      }

      // Collect all paragraphs across segments
      const allParagraphs: { segIdx: number; text: string }[] = [];
      const segmentMeta: { hasDoubleLine: boolean }[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const hasDoubleLine = seg.content.includes('\n\n');
        segmentMeta.push({ hasDoubleLine });
        const paragraphs = hasDoubleLine ? seg.content.split('\n\n') : seg.content.split('\n');
        for (const para of paragraphs) {
          allParagraphs.push({ segIdx: i, text: para });
        }
      }

      // Build vectors for eligible paragraphs
      const maxItems = options.maxItems ?? 2000;
      if (allParagraphs.length > maxItems) {
        console.warn(`context-engine: semantic dedup capped at ${maxItems} items (${allParagraphs.length} provided)`);
      }
      const compareLimit = Math.min(allParagraphs.length, maxItems);

      const vectors: (number[] | null)[] = allParagraphs.map(p => {
        const trimmed = p.text.trim();
        if (trimmed.length < minLength) return null;
        return precomputed.get(trimmed) ?? null;
      });

      const uf = makeUnionFind(allParagraphs.length);

      // Pairwise comparison — union similar paragraphs (capped at maxItems)
      if (compareLimit > 200) {
        // Use SimHash LSH pre-filter to reduce pairwise comparisons
        const candidates = simHashBuckets(vectors, compareLimit, 64, 16);
        for (const key of candidates) {
          const sep = key.indexOf(':');
          const i = parseInt(key.substring(0, sep), 10);
          const j = parseInt(key.substring(sep + 1), 10);
          const vecA = vectors[i];
          const vecB = vectors[j];
          if (!vecA || !vecB) continue;
          if (cosineSimilarity(vecA, vecB) >= threshold) {
            uf.union(i, j);
          }
        }
      } else {
        for (let i = 0; i < compareLimit; i++) {
          const vecA = vectors[i];
          if (!vecA) continue;

          for (let j = i + 1; j < compareLimit; j++) {
            const vecB = vectors[j];
            if (!vecB) continue;

            if (cosineSimilarity(vecA, vecB) >= threshold) {
              uf.union(i, j);
            }
          }
        }
      }

      // Group by cluster root (only for items within the compare limit)
      const clusters = new Map<number, number[]>();
      for (let i = 0; i < compareLimit; i++) {
        if (!vectors[i]) continue;
        const root = uf.find(i);
        let group = clusters.get(root);
        if (!group) {
          group = [];
          clusters.set(root, group);
        }
        group.push(i);
      }

      // From each cluster, keep the longest paragraph; mark the rest as removed
      const removed = new Set<number>();
      for (const members of clusters.values()) {
        if (members.length <= 1) continue;
        let longest = members[0];
        for (let k = 1; k < members.length; k++) {
          if (allParagraphs[members[k]].text.length > allParagraphs[longest].text.length) {
            longest = members[k];
          }
        }
        for (const idx of members) {
          if (idx !== longest) removed.add(idx);
        }
      }

      // Reconstruct segments
      const keptBySegment = new Map<number, string[]>();
      for (let i = 0; i < segments.length; i++) {
        keptBySegment.set(i, []);
      }

      for (let i = 0; i < allParagraphs.length; i++) {
        if (!removed.has(i)) {
          keptBySegment.get(allParagraphs[i].segIdx)!.push(allParagraphs[i].text);
        }
      }

      const output = segments.map((seg, i) => {
        const kept = keptBySegment.get(i) ?? [];
        const separator = segmentMeta[i].hasDoubleLine ? '\n\n' : '\n';
        return { ...seg, content: kept.join(separator) };
      });

      return { segments: output };
    },
  };
}

// ─── SimHash LSH Pre-Filter ──────────────────────────────────────

/**
 * Generate candidate duplicate pairs using SimHash-style locality-sensitive hashing.
 *
 * Algorithm:
 * 1. Generate `numBits` random hyperplanes (deterministic via fnv1a seeding).
 * 2. For each vector, compute a bit string: bit_i = sign(dot(vector, hyperplane_i)).
 * 3. Band the bits into `numBands` bands and hash each band.
 * 4. Items sharing a band bucket are candidate pairs.
 *
 * @param vectors  - Embedding vectors (null entries are skipped).
 * @param limit    - Number of items to consider.
 * @param numBits  - Total hash bits (default 64).
 * @param numBands - Number of bands to split bits into (default 16 => 4 bits/band).
 * @returns Set of candidate pair keys "i:j" where i < j.
 */
export function simHashBuckets(
  vectors: (number[] | null)[],
  limit: number,
  numBits: number = 64,
  numBands: number = 16,
): Set<string> {
  // Determine embedding dimension from first non-null vector
  let dim = 0;
  for (let i = 0; i < limit; i++) {
    if (vectors[i]) { dim = vectors[i]!.length; break; }
  }
  if (dim === 0) return new Set();

  // Generate deterministic random hyperplanes using fnv1a seeding
  const hyperplanes: number[][] = [];
  for (let b = 0; b < numBits; b++) {
    const plane = new Array<number>(dim);
    let mag = 0;
    for (let d = 0; d < dim; d++) {
      // Map fnv1a hash to [-1, 1]
      const h = fnv1a('hp:' + b + ':' + d);
      const val = (h / 0xFFFFFFFF) * 2 - 1;
      plane[d] = val;
      mag += val * val;
    }
    // Normalize to unit vector
    mag = Math.sqrt(mag);
    if (mag > 0) {
      for (let d = 0; d < dim; d++) {
        plane[d] /= mag;
      }
    }
    hyperplanes.push(plane);
  }

  // Compute hash bits for each vector
  const bitsPerBand = numBits / numBands;
  // Store band hashes per item: bandHashes[itemIndex][bandIndex] = hash number
  const bandHashes: (number[] | null)[] = new Array(limit);

  for (let i = 0; i < limit; i++) {
    const vec = vectors[i];
    if (!vec) { bandHashes[i] = null; continue; }

    const hashes = new Array<number>(numBands);
    for (let band = 0; band < numBands; band++) {
      let bandHash = 0x811c9dc5; // fnv1a offset basis
      const startBit = band * bitsPerBand;
      for (let k = 0; k < bitsPerBand; k++) {
        const bitIdx = startBit + k;
        const plane = hyperplanes[bitIdx];
        // Compute dot product
        let dot = 0;
        for (let d = 0; d < dim; d++) {
          dot += vec[d] * plane[d];
        }
        const bit = dot >= 0 ? 1 : 0;
        // Mix bit into band hash
        bandHash ^= bit;
        bandHash = (bandHash * 0x01000193) | 0;
      }
      hashes[band] = bandHash >>> 0;
    }
    bandHashes[i] = hashes;
  }

  // Bucket items by band hash and collect candidate pairs
  const candidates = new Set<string>();

  for (let band = 0; band < numBands; band++) {
    const buckets = new Map<number, number[]>();

    for (let i = 0; i < limit; i++) {
      const hashes = bandHashes[i];
      if (!hashes) continue;
      const h = hashes[band];
      let bucket = buckets.get(h);
      if (!bucket) {
        bucket = [];
        buckets.set(h, bucket);
      }
      bucket.push(i);
    }

    // All pairs within a bucket are candidates
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (let a = 0; a < bucket.length; a++) {
        for (let b = a + 1; b < bucket.length; b++) {
          const lo = bucket[a] < bucket[b] ? bucket[a] : bucket[b];
          const hi = bucket[a] < bucket[b] ? bucket[b] : bucket[a];
          candidates.add(lo + ':' + hi);
        }
      }
    }
  }

  return candidates;
}

// ─── Cosine Similarity (private, reimplemented) ───────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
