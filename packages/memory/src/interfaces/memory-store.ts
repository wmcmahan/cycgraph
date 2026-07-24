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
  entityType?: string;
  includeInvalidated?: boolean;
}

/** Filter options for fact queries. */
export interface FactFilter {
  themeId?: string;
  entityId?: string;
  includeInvalidated?: boolean;
  /**
   * Match facts carrying **any** of these tags (OR semantics). Pushed into
   * SQL by DB-backed stores (a GIN-indexed `tags ?| array[...]` on Postgres)
   * so tag-scoped retrieval — the reflection-loop hot path — no longer pages
   * the whole table client-side. Empty/undefined means "no tag filter".
   */
  tags?: readonly string[];
  /**
   * Exclude facts carrying **any** of these tags (AND-NOT semantics). Applied
   * after `tags`. Used to keep quarantined/poisoned facts (see
   * {@link QUARANTINE_TAG}) out of retrieval and consolidation without deleting
   * them — a fact learned during a failed/poisoned run must not resurface as a
   * trusted lesson. Empty/undefined means "no exclusion".
   */
  excludeTags?: readonly string[];
}

/**
 * Well-known tag marking a fact as quarantined: learned during a
 * failed/poisoned/tainted run and therefore untrusted. Read and consolidation
 * paths exclude it by default so a poisoned fact can never be retrieved as a
 * lesson or promoted by the gate, while remaining recoverable for audit.
 */
export const QUARANTINE_TAG = 'quarantined';

/** Filter options for relationship queries. */
export interface RelationshipFilter {
  direction?: 'outgoing' | 'incoming' | 'both';
  relationType?: string;
  includeInvalidated?: boolean;
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

  // ── Usage Tracking (optional) ──

  /**
   * Record retrieval usage for the given facts: increment `access_count` and
   * set `last_accessed_at`. Retrieval calls this after serving facts, so
   * consolidation's decay scoring can favor load-bearing facts over merely
   * recent ones. Optional — stores that omit it get age-only decay. Missing
   * IDs are ignored.
   */
  touchFacts?(ids: string[], at?: Date): Promise<void>;

  // ── Lifecycle ──

  /** Clear all stored data (for test teardown). */
  clear(): Promise<void>;
}
