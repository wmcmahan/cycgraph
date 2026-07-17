/**
 * Segment Relevance Scoring
 *
 * Zero-dependency BM25 ranking of segments against a query. Used by the
 * allocator's relevance allocation mode to decide WHICH segments deserve
 * budget — the retrieval-reranker idea applied inside the compressor.
 *
 * Granularity matters (measured): query signals help when they choose
 * which documents get budget, and hurt when they choose which tokens
 * survive — query-similar is not answer-bearing at token level for
 * multi-hop tasks. This module is the segment-level half of that split.
 *
 * @module budget/relevance
 */

import type { PromptSegment } from '../pipeline/types.js';

/** BM25 term-frequency saturation. */
const K1 = 1.2;
/** BM25 length normalization. */
const B = 0.75;

/** Minimal stopword set for query/document tokenization. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been',
  'it', 'its', 'this', 'that', 'these', 'those', 'which', 'who', 'whom',
  'what', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'has', 'have',
  'had', 'not', 'no', 'so', 'if', 'then', 'than', 'into', 'about',
]);

/**
 * Light suffix stemming so morphological variants match ("headquarters" /
 * "headquartered", "location" / "located"). Crude by design — ranking only
 * needs variants to collide, not linguistic correctness.
 */
function stem(token: string): string {
  let t = token.replace(/(ations|ation)$/, 'at');
  const suffix = t.match(/(ed|ing|ly|es|s)$/);
  if (suffix && t.length - suffix[1].length >= 4) {
    t = t.slice(0, -suffix[1].length);
  }
  return t;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$%]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Default PRF configuration — measured-best on the MuSiQue tuning slice
 * (400 items, seed distinct from the reporting subset): vs single-round
 * PRF, 2 rounds × 12 terms × 0.7 weight flipped full-chain evidence
 * survival +48/−15 questions at a 0.5 budget (sign test p < 0.001; gains
 * concentrated in 3-hop chains) and +26/−20 at 0.3.
 */
const DEFAULT_PRF_ROUNDS = 2;
/** Weight of expansion terms relative to original query terms. */
const EXPANSION_WEIGHT = 0.7;
/** Max expansion terms taken per feedback round. */
const MAX_EXPANSION_TERMS = 12;

/** Tuning knobs for pseudo-relevance feedback. Defaults are the
 * measured-best configuration (see {@link scoreSegmentRelevance}). */
export interface RelevanceOptions {
  /**
   * Pseudo-relevance feedback rounds (default 2). Round r expands from
   * the highest-ranked segment not yet used as an expansion source, at
   * weight `expansionWeight^r` — so round 2 lets a hop-2 segment (pulled
   * in by round 1) pull in a hop-3 segment. More rounds only help
   * genuinely chained evidence; each round's influence decays
   * geometrically, bounding topic-drift risk.
   */
  prfRounds?: number;
  /** Max expansion terms taken per round (default 12). */
  expansionTerms?: number;
  /** Per-round weight decay for expansion terms (default 0.7). */
  expansionWeight?: number;
}

interface DocStats {
  counts: Map<string, number>;
  length: number;
}

function buildDocs(segments: PromptSegment[]): DocStats[] {
  return segments.map(s => {
    const tokens = tokenize(s.content);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { counts, length: tokens.length };
  });
}

function bm25(
  segments: PromptSegment[],
  docs: DocStats[],
  terms: string[],
  weight: number,
  into: Map<string, number>,
): void {
  const n = segments.length;
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n || 1;

  for (const term of terms) {
    const df = docs.filter(d => d.counts.has(term)).length;
    if (df === 0) continue;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));

    segments.forEach((seg, i) => {
      const tf = docs[i].counts.get(term) ?? 0;
      if (tf === 0) return;
      const saturation =
        (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * docs[i].length) / avgLength));
      into.set(seg.id, (into.get(seg.id) ?? 0) + weight * idf * saturation);
    });
  }
}

/**
 * Score each segment's relevance to the query: BM25 plus iterated
 * pseudo-relevance feedback (default 2 rounds; see {@link RelevanceOptions}).
 *
 * The feedback round handles the MULTI-HOP bridge problem: the segment
 * holding the answer often shares no terms with the question — only with
 * the intermediate segment the question does name ("which city is the HQ
 * of the company that acquired X?" → the X segment names the company; the
 * company's own segment holds the city). Distinctive terms from the
 * top-ranked segment are added to the query at reduced weight, letting
 * hop-1 segments pull in hop-2 segments.
 *
 * Returns a Map from segment id to a non-negative score; segments matching
 * neither the query nor the expansion score 0. Deterministic.
 */
export function scoreSegmentRelevance(
  segments: PromptSegment[],
  query: string,
  options?: RelevanceOptions,
): Map<string, number> {
  const prfRounds = options?.prfRounds ?? DEFAULT_PRF_ROUNDS;
  const maxExpansionTerms = options?.expansionTerms ?? MAX_EXPANSION_TERMS;
  const expansionWeight = options?.expansionWeight ?? EXPANSION_WEIGHT;

  const scores = new Map<string, number>(segments.map(s => [s.id, 0]));
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || segments.length === 0) return scores;

  const docs = buildDocs(segments);
  bm25(segments, docs, queryTerms, 1, scores);

  // Pseudo-relevance feedback: each round expands with distinctive terms
  // from the highest-ranked segment not yet used as an expansion source.
  // With decaying weight, round 2+ chains: a hop-2 segment pulled in by
  // round 1 can itself pull in a hop-3 segment.
  const n = segments.length;
  const usedTerms = new Set(queryTerms);
  const usedSources = new Set<number>();

  for (let round = 1; round <= prfRounds; round++) {
    let topIndex = -1;
    let topScore = 0;
    segments.forEach((seg, i) => {
      const s = scores.get(seg.id)!;
      if (s > topScore && !usedSources.has(i)) {
        topScore = s;
        topIndex = i;
      }
    });
    if (topIndex < 0) break;
    usedSources.add(topIndex);

    const expansion = [...docs[topIndex].counts.entries()]
      .filter(([term]) => !usedTerms.has(term) && term.length > 2)
      // Distinctive: appears in at most half the segments
      .filter(([term]) => docs.filter(d => d.counts.has(term)).length <= Math.ceil(n / 2))
      // Rank by tf within the source doc, alphabetical tiebreak for determinism
      .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, maxExpansionTerms)
      .map(([term]) => term);
    if (expansion.length === 0) continue;

    for (const term of expansion) usedTerms.add(term);
    bm25(segments, docs, expansion, expansionWeight ** round, scores);
  }

  return scores;
}
