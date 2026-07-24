/**
 * Hierarchical Retriever
 *
 * Implements xMemory top-down retrieval: themes → facts → episodes.
 * Queries start at the highest abstraction level and drill down
 * only as needed, producing compact, relevant context.
 *
 * Also supports entity-based subgraph retrieval for graph queries.
 *
 * @module retrieval/hierarchical-retriever
 */

import type { MemoryQuery, MemoryResult } from '../schemas/query.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Entity } from '../schemas/entity.js';
import type { Theme } from '../schemas/theme.js';
import type { Episode } from '../schemas/episode.js';
import type { Relationship } from '../schemas/relationship.js';
import { QUARANTINE_TAG, type MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex } from '../interfaces/memory-index.js';
import { extractSubgraph } from './subgraph-extractor.js';
import { filterValid } from './temporal-filter.js';

/**
 * Retrieve memory using hierarchical top-down search.
 *
 * Strategy:
 * - If query has `entityIds`: use subgraph extraction, then attach related facts/themes
 * - If query has `embedding`: search themes by similarity, expand to facts → episodes
 * - Else if query has `tags`: list facts by tag (no embedding needed). Used by
 *   `reflection` consumers that just want "lessons from graph X" without an
 *   embedding provider.
 * - All paths apply tag + temporal filtering and respect limits.
 */
export async function retrieveMemory(
  store: MemoryStore,
  index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const result = await dispatch(store, index, query);

  // Usage bookkeeping: served facts get their access_count bumped so
  // consolidation's decay scoring can favor load-bearing facts. No-op for
  // stores that don't implement touchFacts.
  if (result.facts.length > 0) {
    await store.touchFacts?.(result.facts.map((f) => f.id));
  }

  return result;
}

function dispatch(
  store: MemoryStore,
  index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  // Entity-based path: subgraph extraction
  if (query.entityIds && query.entityIds.length > 0) {
    return retrieveByEntities(store, index, query);
  }

  // Embedding-based path: top-down hierarchical
  if (query.embedding) {
    return retrieveByEmbedding(store, index, query);
  }

  // Tag-only path: list facts by tag. Used by reflection consumers that
  // just want lessons from a specific graph/category, without requiring
  // an embedding provider or pre-known entity ids.
  if (query.tags && query.tags.length > 0) {
    return retrieveByTags(store, query);
  }

  // No embedding, no entityIds, no tags: empty result.
  return Promise.resolve({ themes: [], facts: [], episodes: [], entities: [], relationships: [] });
}

async function retrieveByEmbedding(
  store: MemoryStore,
  index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const embedding = query.embedding!;
  const { limit, minSimilarity, includeInvalidated } = query;

  // Step 1: Search themes by similarity
  const scoredThemes = await index.searchThemes(embedding, { limit, minSimilarity });
  const themes: Theme[] = scoredThemes.map((s) => s.item);

  // Step 2: Expand themes to facts via fact_ids
  const factIds = new Set<string>();
  for (const theme of themes) {
    for (const factId of theme.fact_ids) {
      factIds.add(factId);
    }
  }

  // Also search facts directly by embedding for coverage
  const scoredFacts = await index.searchFacts(embedding, { limit, minSimilarity });
  for (const sf of scoredFacts) {
    factIds.add(sf.item.id);
  }

  const factsMap = await store.getFacts([...factIds]);
  const allFacts: SemanticFact[] = excludeQuarantined(
    filterByTags([...factsMap.values()], query.tags),
    query.tags,
  );

  // Apply temporal filters
  const filteredFacts = filterValid(allFacts, {
    validAt: query.validAt,
    changedSince: query.changedSince,
    includeInvalidated,
  }).slice(0, limit);

  // Step 3: Expand facts to episodes
  const episodeIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const epId of fact.source_episode_ids) {
      episodeIds.add(epId);
    }
  }

  const episodesMap = await store.getEpisodes([...episodeIds]);
  const episodes: Episode[] = [...episodesMap.values()];

  // Step 4: Collect entities from facts
  const entityIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const eId of fact.entity_ids) {
      entityIds.add(eId);
    }
  }

  const entitiesMap = await store.getEntities([...entityIds]);
  const entities: Entity[] = [...entitiesMap.values()];

  // Step 5: Get relationships between collected entities
  const relationships = await getRelationshipsBetween(store, entityIds, {
    validAt: query.validAt,
    includeInvalidated,
  });

  return {
    themes,
    facts: filteredFacts,
    episodes: episodes.slice(0, limit),
    entities: entities.slice(0, limit),
    relationships: relationships.slice(0, limit),
  };
}

async function retrieveByEntities(
  store: MemoryStore,
  _index: MemoryIndex,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const { entityIds, maxHops, validAt, includeInvalidated, limit } = query;

  // Subgraph extraction via BFS
  const subgraph = await extractSubgraph(store, entityIds!, {
    maxHops,
    validAt,
    includeInvalidated,
  });

  // Find facts referencing these entities
  const entityIdSet = new Set(subgraph.entities.map((e) => e.id));
  const allFacts: SemanticFact[] = [];
  const seenFactIds = new Set<string>();
  const auditingQuarantine = query.tags?.includes(QUARANTINE_TAG) ?? false;
  for (const entityId of entityIdSet) {
    const facts = await store.findFacts({
      entityId,
      includeInvalidated,
      ...(auditingQuarantine ? {} : { excludeTags: [QUARANTINE_TAG] }),
    });
    for (const fact of facts) {
      if (!seenFactIds.has(fact.id)) {
        seenFactIds.add(fact.id);
        allFacts.push(fact);
      }
    }
  }

  const filteredFacts = filterValid(excludeQuarantined(filterByTags(allFacts, query.tags), query.tags), {
    validAt,
    changedSince: query.changedSince,
    includeInvalidated,
  }).slice(0, limit);

  // Collect themes from facts
  const themeIds = new Set<string>();
  for (const fact of filteredFacts) {
    if (fact.theme_id) themeIds.add(fact.theme_id);
  }

  const themesMap = await store.getThemes([...themeIds]);
  const themes: Theme[] = [...themesMap.values()];

  // Collect episodes from facts
  const episodeIds = new Set<string>();
  for (const fact of filteredFacts) {
    for (const epId of fact.source_episode_ids) {
      episodeIds.add(epId);
    }
  }

  const episodesMap = await store.getEpisodes([...episodeIds]);
  const episodes: Episode[] = [...episodesMap.values()];

  return {
    themes: themes.slice(0, limit),
    facts: filteredFacts,
    episodes: episodes.slice(0, limit),
    entities: subgraph.entities.slice(0, limit),
    relationships: subgraph.relationships.slice(0, limit),
  };
}

/**
 * Tag-only retrieval. Walks the store in pages, retains only facts whose
 * `tags` intersect `query.tags`, applies temporal filtering, then expands
 * to themes and episodes. Stops early once `limit` qualifying facts have
 * been collected to bound work for large stores.
 *
 * No entities or relationships are returned — those require entity-driven
 * traversal. Callers that need the knowledge-graph view should query with
 * `entityIds` instead.
 */
async function retrieveByTags(
  store: MemoryStore,
  query: MemoryQuery,
): Promise<MemoryResult> {
  const { limit, includeInvalidated } = query;
  const PAGE_SIZE = Math.max(limit * 4, 100);
  const auditingQuarantine = query.tags?.includes(QUARANTINE_TAG) ?? false;

  const matching: SemanticFact[] = [];
  let offset = 0;
  // Page through facts until we have `limit` matches or run out.
  // findFacts returning fewer than PAGE_SIZE rows signals end-of-data.
  while (matching.length < limit) {
    const page = await store.findFacts({
      includeInvalidated,
      // Push the tag filter into the store. DB-backed stores resolve this via
      // a GIN-indexed `tags ?| array[...]` instead of scanning the whole
      // table; the client-side `filterByTags` below stays as a correctness
      // backstop for stores that don't honor the hint.
      ...(query.tags && query.tags.length > 0 ? { tags: query.tags } : {}),
      ...(auditingQuarantine ? {} : { excludeTags: [QUARANTINE_TAG] }),
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    const taggedPage = excludeQuarantined(filterByTags(page, query.tags), query.tags);
    const validPage = filterValid(taggedPage, {
      validAt: query.validAt,
      changedSince: query.changedSince,
      includeInvalidated,
    });
    for (const fact of validPage) {
      matching.push(fact);
      if (matching.length >= limit) break;
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const facts = matching.slice(0, limit);

  // Expand to themes and episodes
  const themeIds = new Set<string>();
  const episodeIds = new Set<string>();
  for (const fact of facts) {
    if (fact.theme_id) themeIds.add(fact.theme_id);
    for (const epId of fact.source_episode_ids) episodeIds.add(epId);
  }

  const themesMap = await store.getThemes([...themeIds]);
  const episodesMap = await store.getEpisodes([...episodeIds]);

  return {
    themes: [...themesMap.values()].slice(0, limit),
    facts,
    episodes: [...episodesMap.values()].slice(0, limit),
    entities: [],
    relationships: [],
  };
}

/**
 * Keep only facts carrying at least one of the requested tags.
 * Empty / omitted `tags` is a no-op so existing callers are unaffected.
 */
function filterByTags(facts: SemanticFact[], tags: readonly string[] | undefined): SemanticFact[] {
  if (!tags || tags.length === 0) return facts;
  const wanted = new Set(tags);
  return facts.filter((fact) => fact.tags.some((t) => wanted.has(t)));
}

/**
 * Drop quarantined facts unless the query explicitly asks for the quarantine
 * tag (an audit query). Enforces the {@link QUARANTINE_TAG} contract on the
 * main read path: a fact learned during a failed/poisoned run must not
 * resurface through ordinary retrieval, while staying recoverable on request.
 */
function excludeQuarantined(
  facts: SemanticFact[],
  queryTags: readonly string[] | undefined,
): SemanticFact[] {
  if (queryTags?.includes(QUARANTINE_TAG)) return facts;
  return facts.filter((fact) => !(fact.tags ?? []).includes(QUARANTINE_TAG));
}

async function getRelationshipsBetween(
  store: MemoryStore,
  entityIds: Set<string>,
  opts: { validAt?: Date; includeInvalidated?: boolean },
): Promise<Relationship[]> {
  const seen = new Set<string>();
  const result: Relationship[] = [];

  for (const entityId of entityIds) {
    const rels = await store.getRelationshipsForEntity(entityId, {
      direction: 'both',
      includeInvalidated: opts.includeInvalidated,
    });
    for (const rel of rels) {
      if (seen.has(rel.id)) continue;
      // Only include relationships where both endpoints are in our set
      if (!entityIds.has(rel.source_id) || !entityIds.has(rel.target_id)) continue;
      seen.add(rel.id);
      result.push(rel);
    }
  }

  return result;
}
