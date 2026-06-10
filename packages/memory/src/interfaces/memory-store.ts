/**
 * Memory Store Interface
 *
 * CRUD contract for all memory record types. The store handles
 * persistence — concrete implementations range from in-memory Maps
 * to Postgres with pgvector.
 *
 * @module interfaces/memory-store
 */

import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';

/** Filter options for entity queries. */
export interface EntityFilter {
  entity_type?: string;
  include_invalidated?: boolean;
}

/** Filter options for fact queries. */
export interface FactFilter {
  theme_id?: string;
  entity_id?: string;
  include_invalidated?: boolean;
  /**
   * Match facts carrying **any** of these tags (OR semantics). Pushed into
   * SQL by DB-backed stores (a GIN-indexed `tags ?| array[...]` on Postgres)
   * so tag-scoped retrieval — the reflection-loop hot path — no longer pages
   * the whole table client-side. Empty/undefined means "no tag filter".
   */
  tags?: readonly string[];
}

/** Filter options for relationship queries. */
export interface RelationshipFilter {
  direction?: 'outgoing' | 'incoming' | 'both';
  relation_type?: string;
  include_invalidated?: boolean;
}

/** Pagination options. */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

/**
 * Primary persistence interface for memory records.
 *
 * All methods are async to support both in-memory and database backends.
 */
export interface MemoryStore {
  // ── Entity Operations ──

  putEntity(entity: Entity): Promise<void>;
  getEntity(id: string): Promise<Entity | null>;
  findEntities(filter?: EntityFilter & PaginationOptions): Promise<Entity[]>;
  deleteEntity(id: string): Promise<boolean>;

  // ── Relationship Operations ──

  putRelationship(relationship: Relationship): Promise<void>;
  getRelationship(id: string): Promise<Relationship | null>;
  getRelationshipsForEntity(entityId: string, filter?: RelationshipFilter): Promise<Relationship[]>;
  deleteRelationship(id: string): Promise<boolean>;

  // ── Episode Operations ──

  putEpisode(episode: Episode): Promise<void>;
  getEpisode(id: string): Promise<Episode | null>;
  listEpisodes(opts?: PaginationOptions): Promise<Episode[]>;
  deleteEpisode(id: string): Promise<boolean>;

  // ── Semantic Fact Operations ──

  putFact(fact: SemanticFact): Promise<void>;
  getFact(id: string): Promise<SemanticFact | null>;
  findFacts(filter?: FactFilter & PaginationOptions): Promise<SemanticFact[]>;
  deleteFact(id: string): Promise<boolean>;

  // ── Theme Operations ──

  putTheme(theme: Theme): Promise<void>;
  getTheme(id: string): Promise<Theme | null>;
  listThemes(): Promise<Theme[]>;
  deleteTheme(id: string): Promise<boolean>;

  // ── Batch Operations ──

  /** Get multiple entities by ID. Missing IDs are silently absent from the result. */
  getEntities(ids: string[]): Promise<Map<string, Entity>>;
  /** Get multiple facts by ID. Missing IDs are silently absent from the result. */
  getFacts(ids: string[]): Promise<Map<string, SemanticFact>>;
  /** Get multiple episodes by ID. Missing IDs are silently absent from the result. */
  getEpisodes(ids: string[]): Promise<Map<string, Episode>>;
  /** Get multiple themes by ID. Missing IDs are silently absent from the result. */
  getThemes(ids: string[]): Promise<Map<string, Theme>>;

  // ── Lifecycle ──

  /** Clear all stored data (for test teardown). */
  clear(): Promise<void>;
}
