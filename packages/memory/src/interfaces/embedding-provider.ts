/**
 * Embedding Provider Interface
 *
 * Consumers inject their own embedding implementation (OpenAI, Anthropic,
 * local models, etc.). This package never couples to a specific provider.
 *
 * Shape-aligned with `@cycgraph/context-engine`'s EmbeddingProvider so one
 * implementation serves both stacks: batch-only `embed`, plus `dimensions`.
 * Embed a single text by passing a one-element array.
 *
 * @module interfaces/embedding-provider
 */

export interface EmbeddingProvider {
  /** Embed a batch of texts. One-element array for a single text. */
  embed(texts: string[]): Promise<number[][]>;

  /** The dimensionality of produced embeddings. */
  readonly dimensions: number;
}
