/**
 * Vector Similarity Utilities
 *
 * @module utils/similarity
 */

/**
 * Cosine similarity between two vectors, in the range [-1, 1].
 *
 * Returns 0 when the vectors differ in length, are empty, or either has
 * zero magnitude. A 0 result is therefore ambiguous between "orthogonal"
 * and "invalid input", so validate dimensionality upstream when that
 * distinction matters (see `EmbeddingDimensionMismatchError`).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
