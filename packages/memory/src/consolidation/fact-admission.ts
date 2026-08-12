/**
 * Fact Admission Gate
 *
 * Decides whether a candidate fact may enter the store. Reflection loops
 * re-read their own past lessons and re-derive them, so the same insight
 * arrives again under a new id. Exact-match dedup does not catch that: the
 * pool grows, retrieval fills with restatements of one idea, and a lesson
 * an eval gate deliberately evicted walks back in.
 *
 * The gate answers two questions about a candidate:
 *
 * 1. Is it another statement of something already stored?
 * 2. Is it another statement of something that was retired?
 *
 * Both are similarity questions. With an {@link EmbeddingProvider} the gate
 * uses cosine over embeddings, which compares meaning. Without one it falls
 * back to token-set overlap, which is deterministic and dependency-free but
 * only compares vocabulary.
 *
 * Choose deliberately between them. Token overlap catches near-verbatim
 * repeats and little else. Measured against real reflection output, claims
 * restated with fresh specifics — "costs run 2-4x lithium-ion" returning as
 * "$160-300/kWh versus $80-100/kWh" — scored 0.11-0.27, while unrelated
 * facts reached 0.31. Those ranges overlap, so on that content no lexical
 * threshold separates duplicates from new material. A reflection loop that
 * re-derives claims rather than repeating them needs `embeddings`.
 *
 * @module consolidation/fact-admission
 */

import type { MemoryStore } from '../interfaces/memory-store.js';
import type { EmbeddingProvider } from '../interfaces/embedding-provider.js';
import type { SemanticFact } from '../schemas/semantic.js';

/** Why a candidate was refused. */
export type FactRejectionReason =
  /** Too close to a fact that is still live. */
  | 'duplicate'
  /** Too close to a fact that was invalidated, including eval-gate evictions. */
  | 'evicted_reentry';

/** The gate's decision about one candidate. */
export type FactAdmissionVerdict =
  | { admit: true }
  | {
      admit: false;
      reason: FactRejectionReason;
      /** The stored fact the candidate collided with. */
      matched: SemanticFact;
      /** Similarity to `matched`, in `[0, 1]`. */
      similarity: number;
    };

/** Tuning for {@link checkFactAdmission}. */
export interface FactAdmissionOptions {
  /**
   * Similarity at or above which two facts are the same lesson.
   *
   * `0.85` suits cosine over sentence embeddings. Token-overlap scores run
   * much lower for the same pair, so the fallback path applies
   * {@link LEXICAL_THRESHOLD} unless this is set explicitly. Neither
   * default is calibrated against a paraphrase corpus; tune per content.
   */
  threshold?: number;
  /** Compare only against facts carrying any of these tags. */
  tags?: readonly string[];
  /** How many stored facts to compare against. */
  limit?: number;
  /**
   * Embeddings for paraphrase-aware comparison. Omit to use token overlap,
   * which needs no provider and no network.
   */
  embeddings?: EmbeddingProvider;
}

/** Default cosine threshold when embeddings are supplied. */
export const EMBEDDING_THRESHOLD = 0.85;

/**
 * Default threshold for the token-overlap fallback. Lower than the
 * embedding threshold because overlap scores the same pair far more
 * conservatively. Set to reject near-verbatim repeats without flagging
 * merely same-topic facts; it will not catch semantic duplicates.
 */
export const LEXICAL_THRESHOLD = 0.6;

/** Words carrying no topical signal, dropped before comparison. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'for',
  'from', 'had', 'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'their', 'they', 'this', 'to', 'was', 'were', 'which', 'will',
  'with',
]);

/** Normalize to a bag of meaningful lowercase word stems. */
function tokenSet(content: string): Set<string> {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return new Set(words);
}

/** Jaccard overlap of two token sets, in `[0, 1]`. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Cosine similarity of two equal-length vectors, in `[-1, 1]`. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Decide whether `candidate` may be written.
 *
 * Compares against stored facts INCLUDING invalidated ones, because a
 * retired lesson returning as a paraphrase is the failure this exists to
 * prevent. A collision with a live fact is a `duplicate`; a collision with
 * an invalidated one is an `evicted_reentry`, since something removed it
 * on purpose.
 *
 * @param store - Where existing facts live.
 * @param candidate - The fact about to be written; only `content` is read.
 * @param options - Threshold, tag scope, and optional embeddings.
 * @returns Whether to admit, and what it collided with if not.
 *
 * @example
 * ```ts
 * const verdict = await checkFactAdmission(store, { content }, { tags: ['lesson'] });
 * if (verdict.admit) await store.putFact(fact);
 * ```
 */
export async function checkFactAdmission(
  store: MemoryStore,
  candidate: { content: string },
  options?: FactAdmissionOptions,
): Promise<FactAdmissionVerdict> {
  const existing = await store.findFacts({
    includeInvalidated: true,
    ...(options?.tags ? { tags: options.tags } : {}),
    limit: options?.limit ?? 1000,
  });

  if (existing.length === 0) return { admit: true };

  const scores = options?.embeddings
    ? await embeddingScores(options.embeddings, candidate.content, existing)
    : lexicalScores(candidate.content, existing);

  const threshold =
    options?.threshold ?? (options?.embeddings ? EMBEDDING_THRESHOLD : LEXICAL_THRESHOLD);

  let best = -1;
  let bestIndex = -1;
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] > best) {
      best = scores[i];
      bestIndex = i;
    }
  }

  if (bestIndex === -1 || best < threshold) return { admit: true };

  const matched = existing[bestIndex];
  return {
    admit: false,
    reason: matched.invalidated_by !== undefined ? 'evicted_reentry' : 'duplicate',
    matched,
    similarity: best,
  };
}

/** Score the candidate against every stored fact by token overlap. */
function lexicalScores(content: string, existing: SemanticFact[]): number[] {
  const candidateTokens = tokenSet(content);
  return existing.map((fact) => jaccard(candidateTokens, tokenSet(fact.content)));
}

/**
 * Score by cosine over embeddings. Stored embeddings are reused when
 * present; the rest are embedded in one batched call alongside the
 * candidate, so the gate costs at most a single provider round trip.
 */
async function embeddingScores(
  embeddings: EmbeddingProvider,
  content: string,
  existing: SemanticFact[],
): Promise<number[]> {
  const missing: number[] = [];
  for (let i = 0; i < existing.length; i += 1) {
    if (!existing[i].embedding) missing.push(i);
  }

  const vectors = await embeddings.embed([content, ...missing.map((i) => existing[i].content)]);
  const candidateVector = vectors[0];

  const resolved = new Map<number, number[]>();
  missing.forEach((factIndex, order) => resolved.set(factIndex, vectors[order + 1]));

  return existing.map((fact, i) => {
    const vector = fact.embedding ?? resolved.get(i);
    return vector ? cosine(candidateVector, vector) : 0;
  });
}
