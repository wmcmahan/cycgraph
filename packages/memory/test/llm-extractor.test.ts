/**
 * Tests for hierarchy/llm-extractor: LLM-backed fact extraction with JSON
 * parsing, a timeout guard, a consecutive-failure circuit breaker, and a
 * RuleBasedExtractor fallback on any failure.
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMExtractor } from '../src/hierarchy/llm-extractor.js';
import type { LLMProvider } from '../src/hierarchy/llm-extractor.js';
import { makeEpisode, makeMessage } from './helpers.js';
import type { Episode } from '../src/schemas/episode.js';

const FALLBACK_TEXT = 'Alice Smith works at Acme Corp and does many things for the company.';

function episodeWith(content: string): Episode {
  return makeEpisode({ topic: 'test topic', messages: [makeMessage({ content })] });
}

function mockProvider(response: string): LLMProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function throwingProvider(error: Error): LLMProvider {
  return { complete: vi.fn().mockRejectedValue(error) };
}

function callCount(provider: LLMProvider): number {
  return (provider.complete as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe('LLMExtractor', () => {
  describe('parsing valid responses', () => {
    it('extracts facts, entities, and relationships from a valid JSON response', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Alice works at Acme',
          entities: [
            { name: 'Alice', type: 'person' },
            { name: 'Acme', type: 'organization' },
          ],
          relationships: [{ source: 'Alice', target: 'Acme', type: 'works_at' }],
        },
      ]));
      const extractor = new LLMExtractor({ provider });
      const ep = episodeWith('Alice works at Acme');

      const result = await extractor.extract(ep);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe('Alice works at Acme');
      expect(result.facts[0].entity_ids).toHaveLength(2);
      expect(result.facts[0].source_episode_ids).toEqual([ep.id]);
      expect(result.facts[0].provenance.source).toBe('derived');

      const alice = result.entities.find((e) => e.name === 'Alice');
      const acme = result.entities.find((e) => e.name === 'Acme');
      expect(alice?.entity_type).toBe('person');
      expect(acme?.entity_type).toBe('organization');

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].relation_type).toBe('works_at');
      expect(result.relationships[0].source_id).toBe(alice!.id);
      expect(result.relationships[0].target_id).toBe(acme!.id);
    });

    it('parses JSON inside a markdown code block', async () => {
      const json = JSON.stringify([{ content: 'Fact one', entities: [], relationships: [] }]);
      const provider = mockProvider('```json\n' + json + '\n```');
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('some text'));

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe('Fact one');
    });

    it('parses JSON with extra whitespace inside a code block', async () => {
      const provider = mockProvider('```\n  [{"content": "fact", "entities": []}]  \n```');
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts).toHaveLength(1);
    });

    it('returns empty results for an empty array response', async () => {
      const provider = mockProvider('[]');
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('some text'));

      expect(result.facts).toHaveLength(0);
      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('caps facts at maxFactsPerEpisode', async () => {
      const manyFacts = Array.from({ length: 30 }, (_, i) => ({
        content: `Fact number ${i}`,
        entities: [],
        relationships: [],
      }));
      const provider = mockProvider(JSON.stringify(manyFacts));
      const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });

      const result = await extractor.extract(episodeWith('lots of text'));

      expect(result.facts).toHaveLength(20);
    });

    it('sets valid_from to the episode started_at', async () => {
      const provider = mockProvider(JSON.stringify([{ content: 'A fact', entities: [] }]));
      const extractor = new LLMExtractor({ provider });
      const ep = episodeWith('text');

      const result = await extractor.extract(ep);

      expect(result.facts[0].valid_from).toEqual(ep.started_at);
    });

    it('sets the episode fact_ids back-link on a successful extraction', async () => {
      const provider = mockProvider(JSON.stringify([
        { content: 'Alice works at Acme', entities: [{ name: 'Alice', type: 'person' }] },
      ]));
      const extractor = new LLMExtractor({ provider });
      const ep = episodeWith('some text');

      const result = await extractor.extract(ep);

      expect(ep.fact_ids).toEqual(result.facts.map((f) => f.id));
    });

    it('sends the episode messages to the provider in a single prompt', async () => {
      const provider = mockProvider('[]');
      const extractor = new LLMExtractor({ provider });

      await extractor.extract(episodeWith('Test message content'));

      expect(callCount(provider)).toBe(1);
      const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).toContain('Test message content');
      expect(prompt).toContain('[user]');
    });
  });

  describe('entity and relationship mapping', () => {
    it('maps entity types from the LLM response with distinct ids', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Acme Corp is in New York',
          entities: [
            { name: 'Acme Corp', type: 'organization' },
            { name: 'New York', type: 'location' },
          ],
          relationships: [],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts[0].entity_ids).toHaveLength(2);
      expect(result.facts[0].entity_ids[0]).not.toBe(result.facts[0].entity_ids[1]);
      expect(result.entities.find((e) => e.name === 'Acme Corp')?.entity_type).toBe('organization');
      expect(result.entities.find((e) => e.name === 'New York')?.entity_type).toBe('location');
    });

    it('deduplicates entities by name, reusing one id', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Alice works with Alice',
          entities: [
            { name: 'Alice', type: 'person' },
            { name: 'Alice', type: 'person' },
          ],
          relationships: [],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts[0].entity_ids[0]).toBe(result.facts[0].entity_ids[1]);
      expect(result.entities).toHaveLength(1);
    });

    it('accepts a fact whose entities field is absent', async () => {
      const provider = mockProvider(JSON.stringify([{ content: 'A bare fact with no entity list' }]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].entity_ids).toHaveLength(0);
      expect(result.entities).toHaveLength(0);
    });

    it('defaults an entity type to concept when the LLM omits it', async () => {
      const provider = mockProvider(JSON.stringify([
        { content: 'Ann appears', entities: [{ name: 'Ann' }] },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.entities.find((e) => e.name === 'Ann')?.entity_type).toBe('concept');
    });

    it('drops a relationship missing its type', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Alice and Bob',
          entities: [{ name: 'Alice', type: 'person' }, { name: 'Bob', type: 'person' }],
          relationships: [{ source: 'Alice', target: 'Bob' }],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.relationships).toHaveLength(0);
    });

    it('skips entities that have no name', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Some fact',
          entities: [{ type: 'person' }, { name: 'Valid', type: 'person' }],
          relationships: [],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts[0].entity_ids).toHaveLength(1);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Valid');
    });

    it('skips facts with missing or empty content', async () => {
      const provider = mockProvider(JSON.stringify([
        { content: 'Valid fact', entities: [] },
        { entities: [{ name: 'X' }] },
        { content: '', entities: [] },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe('Valid fact');
    });

    it('drops relationships whose source or target entity is undeclared', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Alice works at Acme',
          entities: [{ name: 'Alice', type: 'person' }],
          relationships: [{ source: 'Alice', target: 'Acme', type: 'works_at' }],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.relationships).toHaveLength(0);
    });

    it('resolves a relationship referencing an entity declared on a later fact', async () => {
      const provider = mockProvider(JSON.stringify([
        {
          content: 'Alice works at Acme Corp',
          entities: [{ name: 'Alice', type: 'person' }],
          relationships: [{ source: 'Alice', target: 'Acme Corp', type: 'works_at' }],
        },
        {
          content: 'Acme Corp builds widgets',
          entities: [{ name: 'Acme Corp', type: 'organization' }],
        },
      ]));
      const extractor = new LLMExtractor({ provider });

      const result = await extractor.extract(episodeWith('text'));

      expect(result.relationships).toHaveLength(1);
      const alice = result.entities.find((e) => e.name === 'Alice');
      const acme = result.entities.find((e) => e.name === 'Acme Corp');
      expect(result.relationships[0].source_id).toBe(alice!.id);
      expect(result.relationships[0].target_id).toBe(acme!.id);
    });
  });

  describe('fallback to RuleBasedExtractor', () => {
    it('falls back on malformed JSON without triggering the outer catch', async () => {
      const provider = mockProvider('this is not json at all');
      const extractor = new LLMExtractor({ provider });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      const outerCatchLogged = warnSpy.mock.calls.some(
        (args) => String(args[0]).startsWith('LLMExtractor failed, falling back'),
      );
      expect(outerCatchLogged).toBe(false);
      warnSpy.mockRestore();
    });

    it('falls back when the response is a JSON object rather than an array', async () => {
      const provider = mockProvider(JSON.stringify({ content: 'not an array' }));
      const extractor = new LLMExtractor({ provider });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      warnSpy.mockRestore();
    });

    it('falls back when the provider throws', async () => {
      const provider = throwingProvider(new Error('API timeout'));
      const extractor = new LLMExtractor({ provider });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      warnSpy.mockRestore();
    });

    it('returns a well-formed ExtractionResult from the fallback', async () => {
      const provider = throwingProvider(new Error('fail'));
      const extractor = new LLMExtractor({ provider });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(Array.isArray(result.facts)).toBe(true);
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('timeout guard', () => {
    it('falls back when the provider exceeds the timeout', async () => {
      const slowProvider: LLMProvider = {
        complete: vi.fn().mockImplementation(() =>
          new Promise((resolve) => setTimeout(() => resolve('[]'), 5000)),
        ),
      };
      const extractor = new LLMExtractor({ provider: slowProvider, timeoutMs: 50 });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      const timedOut = warnSpy.mock.calls.some((args) => String(args[0]).includes('timed out'));
      expect(timedOut).toBe(true);
      warnSpy.mockRestore();
    });

    it('falls back when the provider throws synchronously before a timer is set', async () => {
      const provider: LLMProvider = {
        complete: vi.fn(() => { throw new Error('sync boom'); }),
      };
      const extractor = new LLMExtractor({ provider });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      warnSpy.mockRestore();
    });

    it('clears the race timer after a successful call', async () => {
      vi.useFakeTimers();
      try {
        const provider = mockProvider('[]');
        const extractor = new LLMExtractor({ provider, timeoutMs: 30_000 });

        await extractor.extract(episodeWith('text'));

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('circuit breaker', () => {
    it('skips the provider once consecutive failures reach the threshold', async () => {
      const failProvider = throwingProvider(new Error('API down'));
      const extractor = new LLMExtractor({
        provider: failProvider,
        maxConsecutiveFailures: 2,
        breakerCooldownMs: 60_000,
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await extractor.extract(episodeWith(FALLBACK_TEXT));
      await extractor.extract(episodeWith(FALLBACK_TEXT));
      const before = callCount(failProvider);
      const result = await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(callCount(failProvider)).toBe(before);
      expect(result.facts.length).toBeGreaterThanOrEqual(1);
      warnSpy.mockRestore();
    });

    it('retries the provider once the breaker cooldown elapses', async () => {
      const provider = throwingProvider(new Error('down'));
      const extractor = new LLMExtractor({
        provider,
        maxConsecutiveFailures: 2,
        breakerCooldownMs: 0,
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await extractor.extract(episodeWith(FALLBACK_TEXT));
      await extractor.extract(episodeWith(FALLBACK_TEXT));
      const before = callCount(provider);
      await extractor.extract(episodeWith(FALLBACK_TEXT));

      expect(callCount(provider)).toBe(before + 1);
      warnSpy.mockRestore();
    });

    it('never opens the breaker when maxConsecutiveFailures is zero', async () => {
      const provider = mockProvider('[]');
      const extractor = new LLMExtractor({ provider, maxConsecutiveFailures: 0 });

      await extractor.extract(episodeWith('some text'));
      await extractor.extract(episodeWith('some text'));

      expect(callCount(provider)).toBe(2);
    });

    it('resets the failure counter after a successful call', async () => {
      let calls = 0;
      const intermittentProvider: LLMProvider = {
        complete: vi.fn().mockImplementation(() => {
          calls++;
          if (calls <= 2) return Promise.reject(new Error('transient'));
          return Promise.resolve(JSON.stringify([{ content: 'LLM fact', entities: [] }]));
        }),
      };
      const extractor = new LLMExtractor({
        provider: intermittentProvider,
        maxConsecutiveFailures: 3,
        breakerCooldownMs: 0,
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await extractor.extract(episodeWith('Alice Smith works at Acme Corp.'));
      await extractor.extract(episodeWith('Alice Smith works at Acme Corp.'));
      const success = await extractor.extract(episodeWith('Alice Smith works at Acme Corp.'));
      const afterReset = await extractor.extract(episodeWith('Alice Smith works at Acme Corp.'));

      expect(success.facts).toHaveLength(1);
      expect(success.facts[0].content).toBe('LLM fact');
      expect(afterReset.facts).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });

  describe('injectable logger', () => {
    it('routes fallback warnings to the injected logger instead of console', async () => {
      const warn = vi.fn();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const extractor = new LLMExtractor({
        provider: mockProvider('this is not json'),
        logger: { warn },
      });

      await extractor.extract(episodeWith('some text'));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to parse JSON'));
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('warns exactly once when the circuit breaker trips', async () => {
      const warn = vi.fn();
      const extractor = new LLMExtractor({
        provider: throwingProvider(new Error('provider down')),
        maxConsecutiveFailures: 3,
        logger: { warn },
      });

      for (let i = 0; i < 5; i++) {
        await extractor.extract(episodeWith('some text'));
      }

      const tripWarnings = warn.mock.calls.filter(([msg]) =>
        (msg as string).includes('circuit breaker tripped'),
      );
      expect(tripWarnings).toHaveLength(1);
      expect(tripWarnings[0][0]).toContain('3 consecutive');
    });

    it('routes the cooldown-retry notice to the injected debug logger', async () => {
      const debug = vi.fn();
      const extractor = new LLMExtractor({
        provider: throwingProvider(new Error('down')),
        maxConsecutiveFailures: 2,
        breakerCooldownMs: 0,
        logger: { warn: vi.fn(), debug },
      });

      await extractor.extract(episodeWith('some text'));
      await extractor.extract(episodeWith('some text'));
      await extractor.extract(episodeWith('some text'));

      expect(debug).toHaveBeenCalledWith(expect.stringContaining('cooldown elapsed'));
    });

    it('defaults to console.warn when no logger is provided', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const extractor = new LLMExtractor({ provider: mockProvider('not json either') });

      await extractor.extract(episodeWith('some text'));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse JSON'));
      consoleSpy.mockRestore();
    });
  });
});
