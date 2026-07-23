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

describe('Full pipeline integration', () => {
  it('messages → episodes → facts → themes → query', async () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 60_000 });
    const extractor = new SimpleSemanticExtractor();
    const clusterer = new SimpleThemeClusterer();

    // Step 1: Create messages with two distinct time groups
    const t1 = new Date('2024-01-01T10:00:00Z');
    const t2 = new Date('2024-01-01T10:01:00Z');
    const t3 = new Date('2024-01-01T12:00:00Z'); // 2 hour gap → new episode
    const t4 = new Date('2024-01-01T12:01:00Z');

    const messages: Message[] = [
      { id: crypto.randomUUID(), role: 'user', content: 'Tell me about project architecture', timestamp: t1, metadata: {} },
      { id: crypto.randomUUID(), role: 'assistant', content: 'The project uses a graph-based workflow engine', timestamp: t2, metadata: {} },
      { id: crypto.randomUUID(), role: 'user', content: 'What are the team members?', timestamp: t3, metadata: {} },
      { id: crypto.randomUUID(), role: 'assistant', content: 'Alice and Bob work on the project', timestamp: t4, metadata: {} },
    ];

    // Step 2: Segment into episodes
    const episodes = await segmenter.segment(messages);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].messages).toHaveLength(2);
    expect(episodes[1].messages).toHaveLength(2);

    // Step 3: Store episodes
    for (const ep of episodes) {
      await store.putEpisode(ep);
    }

    // Step 4: Extract facts from each episode
    const allFacts = [];
    for (const ep of episodes) {
      const { facts } = await extractor.extract(ep);
      for (const fact of facts) {
        // Give facts fake embeddings for testing
        const embedding = ep === episodes[0] ? [1, 0, 0] : [0, 1, 0];
        const withEmbed = { ...fact, embedding };
        await store.putFact(withEmbed);
        allFacts.push(withEmbed);
      }

      // Link facts to episode
      const updatedEp = { ...ep, fact_ids: facts.map((f) => f.id) };
      await store.putEpisode(updatedEp);
    }

    // Step 5: Cluster facts into themes
    const themes = await clusterer.cluster(allFacts);
    expect(themes.length).toBeGreaterThanOrEqual(1);

    // Assign theme_ids to facts and store themes
    for (const theme of themes) {
      await store.putTheme(theme);
      for (const factId of theme.fact_ids) {
        const fact = await store.getFact(factId);
        if (fact) {
          await store.putFact({ ...fact, theme_id: theme.id });
        }
      }
    }

    // Step 6: Rebuild index
    await index.rebuild(store);

    // Step 7: Query using embedding similar to first episode
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

  it('RuleBasedExtractor populates entities and relationships in store', async () => {
    const store = new InMemoryMemoryStore();
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 60_000 });
    const extractor = new RuleBasedExtractor();

    const t1 = new Date('2024-01-01T10:00:00Z');
    const t2 = new Date('2024-01-01T10:01:00Z');

    const messages: Message[] = [
      { id: crypto.randomUUID(), role: 'user', content: 'Alice Smith works at Acme Corp.', timestamp: t1, metadata: {} },
      { id: crypto.randomUUID(), role: 'assistant', content: 'She manages the Widget Project there.', timestamp: t2, metadata: {} },
    ];

    // Segment → Extract → Persist
    const episodes = await segmenter.segment(messages);
    expect(episodes).toHaveLength(1);
    await store.putEpisode(episodes[0]);

    const { facts, entities, relationships } = await extractor.extract(episodes[0]);

    // Persist entities
    for (const entity of entities) {
      await store.putEntity(entity);
    }

    // Persist relationships
    for (const rel of relationships) {
      await store.putRelationship(rel);
    }

    // Persist facts
    for (const fact of facts) {
      await store.putFact(fact);
    }

    // Verify entities are in store
    expect(entities.length).toBeGreaterThanOrEqual(2);
    const alice = entities.find((e) => e.name === 'Alice Smith');
    expect(alice).toBeDefined();
    const storedAlice = await store.getEntity(alice!.id);
    expect(storedAlice).toBeDefined();
    expect(storedAlice!.entity_type).toBe('person');

    // Verify relationships are in store and traversable
    expect(relationships.length).toBeGreaterThanOrEqual(1);
    const aliceRels = await store.getRelationshipsForEntity(alice!.id);
    expect(aliceRels.length).toBeGreaterThanOrEqual(1);

    // Verify subgraph extraction works
    const subgraph = await extractSubgraph(store, [alice!.id], { maxHops: 1 });
    expect(subgraph.entities.length).toBeGreaterThanOrEqual(2);
    expect(subgraph.relationships.length).toBeGreaterThanOrEqual(1);
  });

  it('empty messages produce no episodes', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const episodes = await segmenter.segment([]);
    expect(episodes).toHaveLength(0);
  });

  it('single message produces one episode', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const messages: Message[] = [
      { id: crypto.randomUUID(), role: 'user', content: 'Hello', timestamp: new Date(), metadata: {} },
    ];
    const episodes = await segmenter.segment(messages);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].messages).toHaveLength(1);
  });
});
