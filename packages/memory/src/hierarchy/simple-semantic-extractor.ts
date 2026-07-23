/**
 * Simple Semantic Extractor
 *
 * Minimal rule-based extraction: one fact per episode.
 * The fact's content is the episode topic. Real implementations
 * would use an LLM to extract multiple atomic facts.
 *
 * @module hierarchy/simple-semantic-extractor
 */

import type { Episode } from '../schemas/episode.js';
import type { SemanticExtractor, ExtractionResult } from '../interfaces/semantic-extractor.js';

export class SimpleSemanticExtractor implements SemanticExtractor {
  async extract(episode: Episode): Promise<ExtractionResult> {
    const now = new Date();

    const fact = {
      id: crypto.randomUUID(),
      content: episode.topic,
      source_episode_ids: [episode.id],
      entity_ids: [],
      provenance: {
        // 'derived', matching the other extractors: a fact distilled from an
        // episode is derived knowledge regardless of extraction sophistication.
        source: 'derived' as const,
        created_at: now,
      },
      valid_from: episode.started_at,
      tags: [],
    };

    // Episode → facts back-link (the schema's `fact_ids` contract) —
    // callers persist the episode after extraction.
    episode.fact_ids = [fact.id];

    return {
      facts: [fact],
      entities: [],
      relationships: [],
    };
  }
}
