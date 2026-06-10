/**
 * Subgraph Extractor
 *
 * BFS traversal from seed entity IDs to extract a relevant subgraph
 * from the knowledge graph. Respects temporal validity and hop limits.
 *
 * @module retrieval/subgraph-extractor
 */

import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { MemoryStore } from '../interfaces/memory-store.js';
import { isValidAt } from './temporal-filter.js';

/**
 * Default cap on entities visited by a single subgraph extraction. A densely
 * connected graph can expand the frontier near-exponentially per hop; without
 * a ceiling one retrieval can pull thousands of entities (and as many
 * relationship queries) into a prompt. Bounds work and prompt size.
 */
export const DEFAULT_MAX_SUBGRAPH_ENTITIES = 500;

export interface SubgraphOptions {
  /** Maximum BFS hops from seed entities (default: 2). */
  max_hops?: number;
  /** Only include relationships valid at this time. */
  valid_at?: Date;
  /** Include invalidated relationships (default: false). */
  include_invalidated?: boolean;
  /**
   * Hard cap on the number of entities visited (and therefore on relationship
   * fan-out). Once reached, the BFS stops expanding. Defaults to
   * {@link DEFAULT_MAX_SUBGRAPH_ENTITIES}.
   */
  max_entities?: number;
}

export interface SubgraphResult {
  entities: Entity[];
  relationships: Relationship[];
}

/**
 * Extract a subgraph via BFS from seed entity IDs.
 *
 * At each hop, fetches relationships for frontier entities,
 * applies temporal filtering, and expands to connected entities.
 * A visited set prevents cycles.
 */
export async function extractSubgraph(
  store: MemoryStore,
  seedEntityIds: string[],
  opts: SubgraphOptions = {},
): Promise<SubgraphResult> {
  const {
    max_hops = 2,
    valid_at,
    include_invalidated = false,
    max_entities = DEFAULT_MAX_SUBGRAPH_ENTITIES,
  } = opts;

  const visitedEntities = new Set<string>();
  const collectedRelationships = new Map<string, Relationship>();
  let frontier = new Set(seedEntityIds);

  for (let hop = 0; hop <= max_hops && frontier.size > 0; hop++) {
    const nextFrontier = new Set<string>();

    for (const entityId of frontier) {
      if (visitedEntities.has(entityId)) continue;
      // Stop expanding once the entity budget is reached — the frontier can
      // grow near-exponentially in a dense graph.
      if (visitedEntities.size >= max_entities) break;
      visitedEntities.add(entityId);

      if (hop < max_hops) {
        const relationships = await store.getRelationshipsForEntity(entityId, {
          direction: 'both',
          include_invalidated,
        });

        for (const rel of relationships) {
          if (valid_at && !isValidAt(rel, valid_at)) continue;
          if (collectedRelationships.has(rel.id)) continue;

          collectedRelationships.set(rel.id, rel);

          const neighborId = rel.source_id === entityId ? rel.target_id : rel.source_id;
          if (!visitedEntities.has(neighborId)) {
            nextFrontier.add(neighborId);
          }
        }
      }
    }

    if (visitedEntities.size >= max_entities) break;
    frontier = nextFrontier;
  }

  // Batch-fetch full entity records for all visited IDs (one query instead of
  // one round-trip per entity).
  const entitiesMap = await store.getEntities([...visitedEntities]);
  const entities = [...entitiesMap.values()];

  return {
    entities,
    relationships: [...collectedRelationships.values()],
  };
}
