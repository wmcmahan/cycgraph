/**
 * Cross-module integration smoke tests: messages flow through segmentation,
 * extraction, clustering, storage, indexing and retrieval end to end.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  SimpleSemanticExtractor,
  RuleBasedExtractor,
  SimpleThemeClusterer,
  retrieveMemory,
  extractSubgraph,
} from '../src/index.js';
import type { Message, MemoryQuery } from '../src/index.js';
import { makeMessage } from './helpers.js';

describe('Full pipeline integration', () => {
  it('flows messages through episodes, facts, themes and query', async () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 60_000 });
    const extractor = new SimpleSemanticExtractor();
    const clusterer = new SimpleThemeClusterer();

    const firstGroupStart = new Date('2024-01-01T10:00:00Z');
    const firstGroupEnd = new Date('2024-01-01T10:01:00Z');
    const secondGroupStart = new Date('2024-01-01T12:00:00Z');
    const secondGroupEnd = new Date('2024-01-01T12:01:00Z');
    const messages: Message[] = [
      makeMessage({ role: 'user', content: 'Tell me about project architecture', timestamp: firstGroupStart }),
      makeMessage({ role: 'assistant', content: 'The project uses a graph-based workflow engine', timestamp: firstGroupEnd }),
      makeMessage({ role: 'user', content: 'What are the team members?', timestamp: secondGroupStart }),
      makeMessage({ role: 'assistant', content: 'Alice and Bob work on the project', timestamp: secondGroupEnd }),
    ];

    const episodes = await segmenter.segment(messages);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].messages).toHaveLength(2);
    expect(episodes[1].messages).toHaveLength(2);

    for (const ep of episodes) {
      await store.putEpisode(ep);
    }

    const allFacts = [];
    for (const ep of episodes) {
      const { facts } = await extractor.extract(ep);
      for (const fact of facts) {
        const embedding = ep === episodes[0] ? [1, 0, 0] : [0, 1, 0];
        const withEmbed = { ...fact, embedding };
        await store.putFact(withEmbed);
        allFacts.push(withEmbed);
      }
      await store.putEpisode({ ...ep, fact_ids: facts.map((f) => f.id) });
    }

    const themes = await clusterer.cluster(allFacts);
    expect(themes.length).toBeGreaterThanOrEqual(1);

    for (const theme of themes) {
      await store.putTheme(theme);
      for (const factId of theme.fact_ids) {
        const fact = await store.getFact(factId);
        if (fact) {
          await store.putFact({ ...fact, theme_id: theme.id });
        }
      }
    }

    await index.rebuild(store);

    const query: MemoryQuery = {
      embedding: [1, 0, 0],
      maxHops: 2,
      limit: 20,
      minSimilarity: 0.5,
      includeInvalidated: false,
    };
    const result = await retrieveMemory(store, index, query);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.themes.length).toBeGreaterThanOrEqual(1);
  });

  it('populates entities and relationships from RuleBasedExtractor into the store', async () => {
    const store = new InMemoryMemoryStore();
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 60_000 });
    const extractor = new RuleBasedExtractor();

    const messages: Message[] = [
      makeMessage({ role: 'user', content: 'Alice Smith works at Acme Corp.', timestamp: new Date('2024-01-01T10:00:00Z') }),
      makeMessage({ role: 'assistant', content: 'She manages the Widget Project there.', timestamp: new Date('2024-01-01T10:01:00Z') }),
    ];

    const episodes = await segmenter.segment(messages);
    expect(episodes).toHaveLength(1);
    await store.putEpisode(episodes[0]);

    const { facts, entities, relationships } = await extractor.extract(episodes[0]);
    for (const entity of entities) {
      await store.putEntity(entity);
    }
    for (const rel of relationships) {
      await store.putRelationship(rel);
    }
    for (const fact of facts) {
      await store.putFact(fact);
    }

    expect(entities.length).toBeGreaterThanOrEqual(2);
    const alice = entities.find((e) => e.name === 'Alice Smith');
    expect(alice).toBeDefined();
    const storedAlice = await store.getEntity(alice!.id);
    expect(storedAlice!.entity_type).toBe('person');

    expect(relationships.length).toBeGreaterThanOrEqual(1);
    const aliceRels = await store.getRelationshipsForEntity(alice!.id);
    expect(aliceRels.length).toBeGreaterThanOrEqual(1);

    const subgraph = await extractSubgraph(store, [alice!.id], { maxHops: 1 });
    expect(subgraph.entities.length).toBeGreaterThanOrEqual(2);
    expect(subgraph.relationships.length).toBeGreaterThanOrEqual(1);
  });

  it('produces no episodes from an empty message list', async () => {
    const segmenter = new SimpleEpisodeSegmenter();

    const episodes = await segmenter.segment([]);

    expect(episodes).toHaveLength(0);
  });

  it('produces one episode from a single message', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const messages: Message[] = [makeMessage({ role: 'user', content: 'Hello' })];

    const episodes = await segmenter.segment(messages);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].messages).toHaveLength(1);
  });
});
