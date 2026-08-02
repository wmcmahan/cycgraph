/**
 * Prompt-time memory retrieval — resolves a node's `memory_query` directive
 * against the injected MemoryRetriever before prompt construction.
 */

import { describe, it, expect, vi } from 'vitest';
import { retrieveForPrompt } from '../src/agent/retrieve-for-prompt.js';
import type { MemoryRetriever, MemoryRetrievalResult } from '../src/agent/memory-retriever.js';
import type { StateView } from '../src/types/state.js';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeStateView(overrides: Partial<StateView> = {}): StateView {
  return {
    workflow_id: 'wf-1',
    run_id: 'run-1',
    goal: 'Summarise the quarterly report',
    constraints: [],
    memory: {},
    ...overrides,
  };
}

const EMPTY_RESULT: MemoryRetrievalResult = { facts: [], entities: [], themes: [] };

function makeRetriever(): MemoryRetriever {
  return vi.fn().mockResolvedValue(EMPTY_RESULT);
}

describe('retrieveForPrompt', () => {
  it('returns null when no retriever is provided', async () => {
    const result = await retrieveForPrompt(undefined, { text: 'q' }, makeStateView(), 'model');

    expect(result).toBeNull();
  });

  it('returns null when no query is provided', async () => {
    const result = await retrieveForPrompt(makeRetriever(), undefined, makeStateView(), 'model');

    expect(result).toBeNull();
  });

  it('passes an explicit text query through to the retriever', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, { text: 'find risks' }, makeStateView(), 'model-x');

    expect(retriever).toHaveBeenCalledWith({ text: 'find risks' }, { model: 'model-x' });
  });

  it('includes entityIds when the query supplies a non-empty list', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, { entityIds: ['e1', 'e2'] }, makeStateView(), 'model');

    expect(retriever).toHaveBeenCalledWith({ entityIds: ['e1', 'e2'] }, { model: 'model' });
  });

  it('includes tags when the query supplies a non-empty list', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, { tags: ['lesson'] }, makeStateView(), 'model');

    expect(retriever).toHaveBeenCalledWith({ tags: ['lesson'] }, { model: 'model' });
  });

  it('defaults text to the goal when the query is empty', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, {}, makeStateView({ goal: 'the goal' }), 'model');

    expect(retriever).toHaveBeenCalledWith({ text: 'the goal' }, { model: 'model' });
  });

  it('does not default text to the goal when tags are present', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, { tags: ['lesson'] }, makeStateView({ goal: 'the goal' }), 'model');

    expect(retriever).toHaveBeenCalledWith({ tags: ['lesson'] }, { model: 'model' });
  });

  it('forwards maxFacts to the retriever when set', async () => {
    const retriever = makeRetriever();

    await retrieveForPrompt(retriever, { text: 'q', maxFacts: 7 }, makeStateView(), 'model');

    expect(retriever).toHaveBeenCalledWith({ text: 'q' }, { maxFacts: 7, model: 'model' });
  });

  it('swallows a retriever rejection and returns null', async () => {
    const retriever = vi.fn().mockRejectedValue(new Error('store down'));

    const result = await retrieveForPrompt(retriever, { text: 'q' }, makeStateView(), 'model');

    expect(result).toBeNull();
  });

  it('swallows a non-Error rejection and returns null', async () => {
    const retriever = vi.fn().mockRejectedValue('string failure');

    const result = await retrieveForPrompt(retriever, { text: 'q' }, makeStateView(), 'model');

    expect(result).toBeNull();
  });

  it('returns the retriever result on success', async () => {
    const facts: MemoryRetrievalResult = {
      facts: [{ content: 'a fact', validFrom: new Date() }],
      entities: [],
      themes: [],
    };
    const retriever = vi.fn().mockResolvedValue(facts);

    const result = await retrieveForPrompt(retriever, { text: 'q' }, makeStateView(), 'model');

    expect(result).toBe(facts);
  });
});
