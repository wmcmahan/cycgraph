/**
 * Unit tests for InMemoryMemoryStore batch reads and the batchGetFallback mixin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/index.js';
import { batchGetFallback } from '../src/store/batch-mixin.js';
import { makeEntity, makeFact, makeEpisode, makeTheme } from './helpers.js';

describe('InMemoryMemoryStore', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  describe('getEntities', () => {
    it('returns every requested entity', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      const e2 = makeEntity({ name: 'Bob' });
      await store.putEntity(e1);
      await store.putEntity(e2);

      const result = await store.getEntities([e1.id, e2.id]);

      expect(result.size).toBe(2);
      expect(result.get(e1.id)).toEqual(e1);
      expect(result.get(e2.id)).toEqual(e2);
    });

    it('silently omits missing ids', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      await store.putEntity(e1);

      const result = await store.getEntities([e1.id, 'nonexistent']);

      expect(result.size).toBe(1);
      expect(result.has('nonexistent')).toBe(false);
    });

    it('returns an empty map for an empty id list', async () => {
      const result = await store.getEntities([]);

      expect(result.size).toBe(0);
    });

    it('returns an empty map when no id matches', async () => {
      const result = await store.getEntities(['a', 'b', 'c']);

      expect(result.size).toBe(0);
    });

    it('clones entities so caller mutations do not leak back', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      await store.putEntity(e1);

      const retrieved = (await store.getEntities([e1.id])).get(e1.id)!;
      retrieved.name = 'Mutated';

      const fresh = await store.getEntity(e1.id);
      expect(fresh!.name).toBe('Alice');
    });
  });

  describe('getFacts', () => {
    it('returns every requested fact', async () => {
      const f1 = makeFact({ content: 'Fact 1' });
      const f2 = makeFact({ content: 'Fact 2' });
      await store.putFact(f1);
      await store.putFact(f2);

      const result = await store.getFacts([f1.id, f2.id]);

      expect(result.size).toBe(2);
      expect(result.get(f1.id)!.content).toBe('Fact 1');
    });

    it('silently omits missing ids', async () => {
      const f1 = makeFact();
      await store.putFact(f1);

      const result = await store.getFacts([f1.id, 'missing']);

      expect(result.size).toBe(1);
    });
  });

  describe('getEpisodes', () => {
    it('returns every requested episode', async () => {
      const ep1 = makeEpisode({ topic: 'Episode 1' });
      const ep2 = makeEpisode({ topic: 'Episode 2' });
      await store.putEpisode(ep1);
      await store.putEpisode(ep2);

      const result = await store.getEpisodes([ep1.id, ep2.id]);

      expect(result.size).toBe(2);
      expect(result.get(ep1.id)!.topic).toBe('Episode 1');
    });

    it('silently omits missing ids', async () => {
      const result = await store.getEpisodes(['nonexistent']);

      expect(result.size).toBe(0);
    });
  });

  describe('getThemes', () => {
    it('returns every requested theme', async () => {
      const t1 = makeTheme({ label: 'Theme 1' });
      const t2 = makeTheme({ label: 'Theme 2' });
      await store.putTheme(t1);
      await store.putTheme(t2);

      const result = await store.getThemes([t1.id, t2.id]);

      expect(result.size).toBe(2);
      expect(result.get(t1.id)!.label).toBe('Theme 1');
    });

    it('silently omits missing ids', async () => {
      const t1 = makeTheme({ label: 'Theme 1' });
      await store.putTheme(t1);

      const result = await store.getThemes([t1.id, 'missing']);

      expect(result.size).toBe(1);
      expect(result.has('missing')).toBe(false);
    });

    it('collapses duplicate ids into a single entry', async () => {
      const t1 = makeTheme({ label: 'Theme 1' });
      await store.putTheme(t1);

      const result = await store.getThemes([t1.id, t1.id, t1.id]);

      expect(result.size).toBe(1);
    });
  });
});

describe('batchGetFallback', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('resolves each id through the single-get function', async () => {
    const e1 = makeEntity({ name: 'Alice' });
    const e2 = makeEntity({ name: 'Bob' });
    await store.putEntity(e1);
    await store.putEntity(e2);

    const result = await batchGetFallback([e1.id, e2.id], (id) => store.getEntity(id));

    expect(result.size).toBe(2);
    expect(result.get(e1.id)!.name).toBe('Alice');
  });

  it('omits null results from the map', async () => {
    const e1 = makeEntity({ name: 'Alice' });
    await store.putEntity(e1);

    const result = await batchGetFallback([e1.id, 'missing'], (id) => store.getEntity(id));

    expect(result.size).toBe(1);
    expect(result.has('missing')).toBe(false);
  });

  it('returns an empty map for empty input without calling getSingle', async () => {
    let calls = 0;
    const getSingle = async (id: string) => {
      calls += 1;
      return id;
    };

    const result = await batchGetFallback([], getSingle);

    expect(result.size).toBe(0);
    expect(calls).toBe(0);
  });
});
