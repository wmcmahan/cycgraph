/**
 * Tests for the fact admission gate (consolidation/fact-admission.ts).
 *
 * The gate exists because reflection loops re-emit their own lessons
 * reworded, so the cases that matter are paraphrases rather than exact
 * repeats, and paraphrases of facts that were deliberately retired.
 */

import { describe, it, expect } from 'vitest';
import { checkFactAdmission } from '../src/consolidation/fact-admission.js';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import type { EmbeddingProvider } from '../src/interfaces/embedding-provider.js';
import { makeFact } from './helpers.js';

const SOLID_STATE = 'Solid-state cells reached pilot scale in 2026 with sulfide electrolytes leading adoption';
const SOLID_STATE_REWORDED = 'Sulfide electrolytes led adoption as solid-state cells reached pilot scale during 2026';
const UNRELATED = 'Sodium-ion undercuts lithium on cost for stationary grid storage deployments';

async function storeWith(...facts: Parameters<typeof makeFact>[0][]): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  for (const overrides of facts) await store.putFact(makeFact(overrides));
  return store;
}

/** Embeddings that key off the first meaningful word, so paraphrases collide. */
function stubEmbeddings(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    dimensions: 3,
    embed: async (texts: string[]) =>
      texts.map((text) => {
        const key = Object.keys(vectors).find((k) => text.includes(k));
        return key ? vectors[key] : [0, 0, 1];
      }),
  };
}

describe('checkFactAdmission', () => {
  it('admits into an empty store', async () => {
    const store = new InMemoryMemoryStore();

    expect(await checkFactAdmission(store, { content: SOLID_STATE })).toEqual({ admit: true });
  });

  it('admits a fact unrelated to anything stored', async () => {
    const store = await storeWith({ content: SOLID_STATE });

    expect(await checkFactAdmission(store, { content: UNRELATED })).toEqual({ admit: true });
  });

  it('refuses an exact repeat as a duplicate', async () => {
    const store = await storeWith({ content: SOLID_STATE });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE });

    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toBe('duplicate');
  });

  it('refuses a reworded restatement that exact matching would let through', async () => {
    const store = await storeWith({ content: SOLID_STATE });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE_REWORDED });

    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toBe('duplicate');
  });

  it('reports what the candidate collided with', async () => {
    const store = await storeWith({ content: SOLID_STATE });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE_REWORDED });

    expect(verdict.admit === false && verdict.matched.content).toBe(SOLID_STATE);
    expect(verdict.admit === false && verdict.similarity).toBeGreaterThan(0.6);
  });

  it('refuses a paraphrase of an eval-gate eviction as re-entry', async () => {
    const store = await storeWith({ content: SOLID_STATE, invalidated_by: 'eval-gate:harmful' });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE_REWORDED });

    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toBe('evicted_reentry');
  });

  it('distinguishes re-entry from duplication by the stored fact validity', async () => {
    const live = await storeWith({ content: SOLID_STATE });
    const retired = await storeWith({ content: SOLID_STATE, invalidated_by: 'eval-gate:no_lift' });

    const fromLive = await checkFactAdmission(live, { content: SOLID_STATE });
    const fromRetired = await checkFactAdmission(retired, { content: SOLID_STATE });

    expect(fromLive.admit === false && fromLive.reason).toBe('duplicate');
    expect(fromRetired.admit === false && fromRetired.reason).toBe('evicted_reentry');
  });

  it('compares only against facts carrying the requested tags', async () => {
    const store = await storeWith({ content: SOLID_STATE, tags: ['other-graph'] });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE }, { tags: ['lesson'] });

    expect(verdict).toEqual({ admit: true });
  });

  it('admits a near-miss below an explicit threshold', async () => {
    const store = await storeWith({ content: SOLID_STATE });

    const verdict = await checkFactAdmission(store, { content: SOLID_STATE_REWORDED }, { threshold: 0.99 });

    expect(verdict).toEqual({ admit: true });
  });

  it('uses embeddings for similarity when a provider is supplied', async () => {
    const store = await storeWith({ content: SOLID_STATE });
    const embeddings = stubEmbeddings({
      'Solid-state': [1, 0, 0],
      'Entirely different wording': [1, 0, 0],
    });

    const verdict = await checkFactAdmission(
      store,
      { content: 'Entirely different wording sharing no vocabulary whatsoever' },
      { embeddings },
    );

    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.similarity).toBeCloseTo(1);
  });

  it('reuses a stored embedding instead of re-embedding it', async () => {
    const store = await storeWith({ content: SOLID_STATE, embedding: [1, 0, 0] });
    const embedded: string[][] = [];
    const embeddings: EmbeddingProvider = {
      dimensions: 3,
      embed: async (texts: string[]) => {
        embedded.push(texts);
        return texts.map(() => [1, 0, 0]);
      },
    };

    await checkFactAdmission(store, { content: UNRELATED }, { embeddings });

    expect(embedded).toEqual([[UNRELATED]]);
  });
});
