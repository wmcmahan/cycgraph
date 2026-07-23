/**
 * Memory Index Interface
 *
 * Embedding similarity search over memory records. Separated from
 * MemoryStore so that simple backends don't need vector search,
 * and Postgres backends can use pgvector HNSW.
 *
 * @module interfaces/memory-index
 */

import type { Entity } from '../schemas/entity.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type { Episode } from '../schemas/episode.js';
import type { MemoryStore } from './memory-store.js';

/** A search result with similarity score. */
export interface ScoredResult<T> {
  item: T;
  score: number;
}

/** Options for similarity search. */
export interface SearchOptions {
  limit?: number;
  minSimilarity?: number;
}

/**
 * Embedding similarity search over memory records.
 *
 * Implementations maintain internal indexes that can be rebuilt
 * from a MemoryStore via `rebuild()`.
 */
export interface MemoryIndex {
  searchEntities(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Entity>[]>;
  searchFacts(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<SemanticFact>[]>;
  searchThemes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Theme>[]>;
  searchEpisodes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Episode>[]>;

  /** Rebuild all indexes from the store (e.g. after bulk inserts). */
  rebuild(store: MemoryStore): Promise<void>;
}
