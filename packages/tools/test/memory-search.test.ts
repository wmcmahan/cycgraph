/**
 * Tests for memory_search (src/memory/memory-search.ts) against real
 * in-memory @cycgraph/memory store/index implementations.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore, InMemoryMemoryIndex } from '@cycgraph/memory';
import type { SemanticFact } from '@cycgraph/memory';
import { createMemorySearchTool } from '../src/memory/memory-search.js';

type SearchResult = {
  facts: Array<{ id: string; content: string; validFrom: string; tags?: string[] }>;
  entities: Array<{ id: string; name: string; type: string }>;
  themes: Array<{ label: string }>;
};

const LESSON_FACT_ID = '00000000-0000-0000-0000-00000000000a';
const QUERY_EMBEDDING = [1, 0, 0];

function fact(overrides: Partial<SemanticFact>): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Alice works at Acme',
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system' },
    valid_from: new Date('2026-01-01T00:00:00.000Z'),
    tags: [],
    ...overrides,
  };
}

async function seededStore() {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  await store.putFact(fact({
    id: LESSON_FACT_ID,
    content: 'Retries need exponential backoff',
    tags: ['lesson', 'graph:research-v1'],
    embedding: QUERY_EMBEDDING,
  }));
  await store.putFact(fact({ content: 'Unrelated fact', tags: ['other'] }));
  await index.rebuild(store);
  return { store, index };
}

describe('createMemorySearchTool', () => {
  it('retrieves facts by tag with ids and validity timestamps', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({ store, index });

    const result = (await tool.execute({ tags: ['lesson'] })) as SearchResult;

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toEqual(
      expect.objectContaining({
        id: LESSON_FACT_ID,
        content: 'Retries need exponential backoff',
        validFrom: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('ANDs factory scope tags onto every search', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({ store, index, scopeTags: ['graph:research-v1'] });

    const scoped = (await tool.execute({ tags: ['other'] })) as SearchResult;

    expect(scoped.facts).toHaveLength(0);
  });

  it('rejects an empty search with guidance', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({ store, index });

    await expect(tool.execute({})).rejects.toThrow(/query, entityIds, or tags/);
  });

  it('rejects free-text queries when no embed hook is configured', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({ store, index });

    await expect(tool.execute({ query: 'backoff' })).rejects.toThrow(/embed hook/);
  });

  it('supports free-text queries through the embed hook', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({
      store,
      index,
      embed: async () => QUERY_EMBEDDING,
    });

    const result = (await tool.execute({ query: 'backoff strategy' })) as SearchResult;

    expect(result.facts.map((f) => f.id)).toContain(LESSON_FACT_ID);
  });

  it('returns entities from a seed-entity subgraph query', async () => {
    const { store, index } = await seededStore();
    const entityId = '11111111-1111-4111-8111-0000000000e1';
    await store.putEntity({
      id: entityId,
      name: 'Acme',
      entity_type: 'organization',
      attributes: {},
      provenance: { source: 'system' },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    } as never);
    const tool = createMemorySearchTool({ store, index });

    const result = (await tool.execute({ entityIds: [entityId] })) as SearchResult;

    expect(result.entities).toEqual([{ id: entityId, name: 'Acme', type: 'organization' }]);
  });

  it('returns theme labels alongside semantically matched facts', async () => {
    const { store, index } = await seededStore();
    await store.putTheme({
      id: '00000000-0000-0000-0000-0000000000f1',
      label: 'Resilience',
      description: '',
      fact_ids: [LESSON_FACT_ID],
      provenance: { source: 'system' },
      embedding: QUERY_EMBEDDING,
    } as never);
    await index.rebuild(store);
    const tool = createMemorySearchTool({ store, index, embed: async () => QUERY_EMBEDDING });

    const result = (await tool.execute({ query: 'resilience lessons' })) as SearchResult;

    expect(result.themes).toEqual([{ label: 'Resilience' }]);
  });

  it('caps the limit at the factory maximum', async () => {
    const { store, index } = await seededStore();
    const tool = createMemorySearchTool({ store, index, maxResults: 1 });

    const result = (await tool.execute({ tags: ['lesson', 'other'], limit: 50 })) as SearchResult;

    expect(result.facts.length).toBeLessThanOrEqual(1);
  });

  it('defaults to untainted and honors the untrusted flag', () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();

    expect(createMemorySearchTool({ store, index }).taints).toBe(false);
    expect(createMemorySearchTool({ store, index, untrusted: true }).taints).toBe(true);
  });
});
