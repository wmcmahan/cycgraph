/**
 * Memory Retriever — Type & Wiring Tests
 *
 * Validates that the MemoryRetriever type is correctly exported,
 * satisfiable, and wired through GraphRunnerOptions.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  MemoryRetriever,
  MemoryRetrievalResult,
  GraphRunnerOptions,
} from '@cycgraph/orchestrator';

describe('MemoryRetriever type exports', () => {
  it('MemoryRetriever type is importable from @cycgraph/orchestrator', () => {
    // Type-level check — if this compiles, the type is exported.
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(null);
    expect(retriever).toBeDefined();
  });

  it('MemoryRetrievalResult type is importable from @cycgraph/orchestrator', () => {
    const result: MemoryRetrievalResult = {
      facts: [{ content: 'test', validFrom: new Date() }],
      entities: [{ name: 'Entity', type: 'person' }],
      themes: [{ label: 'theme1' }],
    };
    expect(result.facts).toHaveLength(1);
    expect(result.entities).toHaveLength(1);
    expect(result.themes).toHaveLength(1);
  });

  it('GraphRunnerOptions accepts memoryRetriever', () => {
    const options: GraphRunnerOptions = {
      memoryRetriever: vi.fn().mockResolvedValue(null),
    };
    expect(options.memoryRetriever).toBeDefined();
  });
});

describe('MemoryRetriever function contract', () => {
  it('a mock function satisfies the MemoryRetriever signature', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue({
      facts: [],
      entities: [],
      themes: [],
    });
    const result = await retriever({ text: 'hello' });
    expect(result).toBeDefined();
    expect(retriever).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('returning null is valid', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(null);
    const result = await retriever({ text: 'query' });
    expect(result).toBeNull();
  });

  it('returning a full result is valid', async () => {
    const fullResult: MemoryRetrievalResult = {
      facts: [
        { content: 'The sky is blue', validFrom: new Date('2025-01-01') },
        { content: 'Water is wet', validFrom: new Date('2025-06-01') },
      ],
      entities: [
        { name: 'Sky', type: 'object' },
        { name: 'Water', type: 'substance' },
      ],
      themes: [
        { label: 'Nature' },
      ],
    };
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(fullResult);
    const result = await retriever({ text: 'nature' });
    expect(result).toEqual(fullResult);
    expect(result!.facts).toHaveLength(2);
    expect(result!.entities).toHaveLength(2);
    expect(result!.themes).toHaveLength(1);
  });

  it('query with text only', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(null);
    await retriever({ text: 'semantic search query' });
    expect(retriever).toHaveBeenCalledWith({ text: 'semantic search query' });
  });

  it('query with entityIds only', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(null);
    await retriever({ entityIds: ['entity-1', 'entity-2'] });
    expect(retriever).toHaveBeenCalledWith({ entityIds: ['entity-1', 'entity-2'] });
  });

  it('query with both text and entityIds', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue(null);
    await retriever({ text: 'search', entityIds: ['e1'] });
    expect(retriever).toHaveBeenCalledWith({ text: 'search', entityIds: ['e1'] });
  });

  it('options with maxFacts and model', async () => {
    const retriever: MemoryRetriever = vi.fn().mockResolvedValue({
      facts: [{ content: 'fact', validFrom: new Date() }],
      entities: [],
      themes: [],
    });
    await retriever({ text: 'query' }, { maxFacts: 5, model: 'claude-sonnet-4-6' });
    expect(retriever).toHaveBeenCalledWith(
      { text: 'query' },
      { maxFacts: 5, model: 'claude-sonnet-4-6' },
    );
  });
});
