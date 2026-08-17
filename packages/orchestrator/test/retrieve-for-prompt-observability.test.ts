/**
 * What a retrieval reports about itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithContext } from '../src/index.js';
import { resetLogLevelCache } from '../src/observability/logger.js';
import { retrieveForPrompt } from '../src/memory/retrieve-for-prompt.js';
import type { LogEntry, StateView } from '../src/index.js';
import type { MemoryRetriever } from '../src/memory/memory-retriever.js';

const view = (): StateView => ({ goal: 'find something', memory: {}, constraints: [] } as unknown as StateView);

const capture = async (
  retriever: MemoryRetriever | undefined,
  query: Parameters<typeof retrieveForPrompt>[1],
  nodeId?: string,
): Promise<LogEntry[]> => {
  const entries: LogEntry[] = [];
  await runWithContext({ logger: (e) => entries.push(e) }, async () => {
    await retrieveForPrompt(retriever, query, view(), 'test-model', nodeId);
  });
  return entries;
};

const retrieved = (entries: LogEntry[]) =>
  entries.find((e) => e.event.endsWith('memory_retrieved'))?.context;

describe('retrieveForPrompt reporting', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.LOG_LEVEL = 'info';
    resetLogLevelCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    resetLogLevelCache();
  });

  it('reports what came back and which node asked', async () => {
    const retriever: MemoryRetriever = async () => ({
      facts: [{ content: 'a', validFrom: new Date(), id: 'f1' }],
      entities: [{ name: 'e', type: 't' }],
      themes: [],
    });

    const context = retrieved(await capture(retriever, { tags: ['lesson'] }, 'research'));

    expect({ node: context?.['node_id'], facts: context?.['facts'], entities: context?.['entities'] })
      .toEqual({ node: 'research', facts: 1, entities: 1 });
  });

  it('reports a query that found nothing, which is not the same as no query', async () => {
    const retriever: MemoryRetriever = async () => ({ facts: [], entities: [], themes: [] });

    const context = retrieved(await capture(retriever, { tags: ['absent'] }, 'research'));

    expect(context?.['facts']).toBe(0);
  });

  it('counts facts arriving without an id, which disables outcome attribution', async () => {
    const retriever: MemoryRetriever = async () => ({
      facts: [
        { content: 'a', validFrom: new Date(), id: 'f1' },
        { content: 'b', validFrom: new Date() },
      ],
      entities: [],
      themes: [],
    });

    const context = retrieved(await capture(retriever, {}, 'research'));

    expect(context?.['facts_without_id']).toBe(1);
  });

  it('names the tags the query used', async () => {
    const retriever: MemoryRetriever = async () => ({ facts: [], entities: [], themes: [] });

    const context = retrieved(await capture(retriever, { tags: ['lesson', 'graph:x'] }, 'research'));

    expect(context?.['tags']).toEqual(['lesson', 'graph:x']);
  });

  it('stays silent when no retriever is wired', async () => {
    const entries = await capture(undefined, { tags: ['lesson'] }, 'research');

    expect(retrieved(entries)).toBeUndefined();
  });

  it('reports a failure with the node that was asking', async () => {
    const retriever: MemoryRetriever = async () => { throw new Error('store unreachable'); };

    const entries = await capture(retriever, { tags: ['lesson'] }, 'research');
    const failure = entries.find((e) => e.event.endsWith('memory_retriever_failed'));

    expect({ node: failure?.context?.['node_id'], error: failure?.context?.['error'] })
      .toEqual({ node: 'research', error: 'store unreachable' });
  });
});

describe('retrieveForPrompt score reporting', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.env.LOG_LEVEL = 'info';
    resetLogLevelCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    resetLogLevelCache();
  });

  it('reports the spread when the adapter ranks', async () => {
    const retriever: MemoryRetriever = async () => ({
      facts: [
        { content: 'a', validFrom: new Date(), id: 'f1', score: 0.91 },
        { content: 'b', validFrom: new Date(), id: 'f2', score: 0.42 },
      ],
      entities: [],
      themes: [],
    });

    const context = retrieved(await capture(retriever, {}, 'research'));

    expect({ min: context?.['score_min'], max: context?.['score_max'] })
      .toEqual({ min: 0.42, max: 0.91 });
  });

  it('omits the spread when the path selects rather than ranks', async () => {
    const retriever: MemoryRetriever = async () => ({
      facts: [{ content: 'a', validFrom: new Date(), id: 'f1' }],
      entities: [],
      themes: [],
    });

    const context = retrieved(await capture(retriever, { tags: ['lesson'] }, 'research'));

    expect('score_min' in (context ?? {})).toBe(false);
  });
});
