/**
 * Semantic Extractor Interface
 *
 * Distills episodes into atomic semantic facts, entities, and relationships.
 * Level 1 → Level 2 of the xMemory hierarchy.
 *
 * @module interfaces/semantic-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';

/** Result of extracting semantic knowledge from an episode. */
export interface ExtractionResult {
  /** Atomic facts extracted from the episode. */
  facts: SemanticFact[];
  /** Entities detected in the episode (knowledge graph nodes). */
  entities: Entity[];
  /** Relationships between entities (knowledge graph edges). */
  relationships: Relationship[];
}

export interface SemanticExtractor {
  /**
   * Extract facts, entities, and relationships from an episode.
   *
   * Implementations set `fact_ids` on the passed episode to the extracted
   * facts' IDs (the schema's episode → facts back-link) — persist the
   * episode after extraction to store it.
   */
  extract(episode: Episode): Promise<ExtractionResult>;
}
