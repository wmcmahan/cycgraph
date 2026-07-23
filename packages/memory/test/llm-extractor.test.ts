import { describe, it, expect, vi } from 'vitest';
import { LLMExtractor } from '../src/hierarchy/llm-extractor.js';
import type { LLMProvider } from '../src/hierarchy/llm-extractor.js';
import type { Episode } from '../src/schemas/episode.js';

function makeEpisode(content: string): Episode {
  const now = new Date('2024-01-01T10:00:00Z');
  return {
    id: crypto.randomUUID(),
    topic: 'test topic',
    messages: [{
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: now,
      metadata: {},
    }],
    started_at: now,
    ended_at: now,
    fact_ids: [],
    provenance: { source: 'system', created_at: now },
  };
}

function mockProvider(response: string): LLMProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function throwingProvider(error: Error): LLMProvider {
  return { complete: vi.fn().mockRejectedValue(error) };
}

describe('LLMExtractor', () => {
  it('extracts facts, entities, and relationships from valid JSON response', async () => {
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
    const ep = makeEpisode('Alice works at Acme');
    const result = await extractor.extract(ep);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('Alice works at Acme');
    expect(result.facts[0].entity_ids).toHaveLength(2);
    expect(result.facts[0].source_episode_ids).toEqual([ep.id]);
    expect(result.facts[0].provenance.source).toBe('derived');

    // Entities
    expect(result.entities).toHaveLength(2);
    const alice = result.entities.find((e) => e.name === 'Alice');
    const acme = result.entities.find((e) => e.name === 'Acme');
    expect(alice?.entity_type).toBe('person');
    expect(acme?.entity_type).toBe('organization');

    // Relationships
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].relation_type).toBe('works_at');
    expect(result.relationships[0].source_id).toBe(alice!.id);
    expect(result.relationships[0].target_id).toBe(acme!.id);
  });

  it('parses JSON inside markdown code blocks', async () => {
    const json = JSON.stringify([{ content: 'Fact one', entities: [], relationships: [] }]);
    const provider = mockProvider('```json\n' + json + '\n```');
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('some text'));

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('Fact one');
  });

  it('falls back to RuleBasedExtractor on malformed JSON', async () => {
    const provider = mockProvider('this is not json at all');
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');
    const result = await extractor.extract(ep);

    // Should still get facts from the rule-based fallback
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to RuleBasedExtractor when provider throws', async () => {
    const provider = throwingProvider(new Error('API timeout'));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');
    const result = await extractor.extract(ep);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty facts for empty array response', async () => {
    const provider = mockProvider('[]');
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('some text'));

    expect(result.facts).toHaveLength(0);
    expect(result.entities).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });

  it('respects maxFactsPerEpisode', async () => {
    const manyFacts = Array.from({ length: 30 }, (_, i) => ({
      content: `Fact number ${i}`,
      entities: [],
      relationships: [],
    }));
    const provider = mockProvider(JSON.stringify(manyFacts));
    const extractor = new LLMExtractor({ provider, maxFactsPerEpisode: 20 });
    const result = await extractor.extract(makeEpisode('lots of text'));

    expect(result.facts).toHaveLength(20);
  });

  it('handles object response (not array) by falling back', async () => {
    const provider = mockProvider(JSON.stringify({ content: 'not an array' }));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does important work at the company.');
    const result = await extractor.extract(ep);

    // Falls back to rule-based
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
  });

  it('maps entity types correctly from LLM response', async () => {
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
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].entity_ids).toHaveLength(2);
    expect(result.facts[0].entity_ids[0]).not.toBe(result.facts[0].entity_ids[1]);

    // Entity types are correctly mapped
    const acme = result.entities.find((e) => e.name === 'Acme Corp');
    const ny = result.entities.find((e) => e.name === 'New York');
    expect(acme?.entity_type).toBe('organization');
    expect(ny?.entity_type).toBe('location');
  });

  it('skips facts with missing content field', async () => {
    const provider = mockProvider(JSON.stringify([
      { content: 'Valid fact', entities: [] },
      { entities: [{ name: 'X' }] }, // no content
      { content: '', entities: [] }, // empty content
    ]));
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('Valid fact');
  });

  it('handles entities without name gracefully', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Some fact',
        entities: [{ type: 'person' }, { name: 'Valid', type: 'person' }],
        relationships: [],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.facts).toHaveLength(1);
    // Only the valid entity should have an ID
    expect(result.facts[0].entity_ids).toHaveLength(1);
    // Only valid entity should be in entities array
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Valid');
  });

  it('deduplicates entity IDs by name', async () => {
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
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.facts).toHaveLength(1);
    // Same entity name should reuse the same ID
    expect(result.facts[0].entity_ids[0]).toBe(result.facts[0].entity_ids[1]);
    // Only one entity in the entities array
    expect(result.entities).toHaveLength(1);
  });

  it('sends prompt to provider with episode messages', async () => {
    const provider = mockProvider('[]');
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Test message content');
    await extractor.extract(ep);

    expect(provider.complete).toHaveBeenCalledTimes(1);
    const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Test message content');
    expect(prompt).toContain('[user]');
  });

  it('parses JSON with extra whitespace in code block', async () => {
    const provider = mockProvider('```\n  [{"content": "fact", "entities": []}]  \n```');
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('text'));
    expect(result.facts).toHaveLength(1);
  });

  it('sets valid_from to episode started_at', async () => {
    const provider = mockProvider(JSON.stringify([{ content: 'A fact', entities: [] }]));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('text');
    const result = await extractor.extract(ep);
    expect(result.facts[0].valid_from).toEqual(ep.started_at);
  });

  it('falls back without throwing parse-failed error on malformed JSON', async () => {
    const provider = mockProvider('not valid json');
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await extractor.extract(ep);

    // Should get rule-based fallback results without a 'parse-failed' error
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    // The outer catch in extract() should NOT be triggered (no Error logged)
    const outerCatchCalled = warnSpy.mock.calls.some(
      (args) => args[0] === 'LLMExtractor failed, falling back to RuleBasedExtractor:',
    );
    expect(outerCatchCalled).toBe(false);
    warnSpy.mockRestore();
  });

  it('times out when provider is too slow', async () => {
    const slowProvider: LLMProvider = {
      complete: vi.fn().mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve('[]'), 5000)),
      ),
    };
    const extractor = new LLMExtractor({ provider: slowProvider, timeoutMs: 50 });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await extractor.extract(ep);

    // Should fall back to rule-based due to timeout
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    const timedOut = warnSpy.mock.calls.some(
      (args) => String(args[0]).includes('timed out'),
    );
    expect(timedOut).toBe(true);
    warnSpy.mockRestore();
  });

  it('circuit breaker skips LLM after consecutive failures', async () => {
    const failProvider = throwingProvider(new Error('API down'));
    const extractor = new LLMExtractor({
      provider: failProvider,
      maxConsecutiveFailures: 2,
      breakerCooldownMs: 60_000,
    });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Fail twice to trip the breaker
    await extractor.extract(ep);
    await extractor.extract(ep);

    // Third call — breaker is open, provider should NOT be called
    const callCountBefore = (failProvider.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await extractor.extract(ep);
    const callCountAfter = (failProvider.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callCountAfter).toBe(callCountBefore); // provider not called
    expect(result.facts.length).toBeGreaterThanOrEqual(1); // still returns fallback results

    warnSpy.mockRestore();
  });

  it('circuit breaker resets after a successful call', async () => {
    let callCount = 0;
    const intermittentProvider: LLMProvider = {
      complete: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return Promise.reject(new Error('transient'));
        return Promise.resolve(JSON.stringify([{ content: 'LLM fact', entities: [] }]));
      }),
    };
    const extractor = new LLMExtractor({
      provider: intermittentProvider,
      maxConsecutiveFailures: 3,
      breakerCooldownMs: 0, // instant cooldown for test
    });
    const ep = makeEpisode('Alice Smith works at Acme Corp.');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Two failures — not yet tripped (threshold is 3)
    await extractor.extract(ep);
    await extractor.extract(ep);

    // Third call succeeds — should reset the counter
    const result = await extractor.extract(ep);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('LLM fact');

    // Fourth call — provider is called (breaker was reset)
    const result2 = await extractor.extract(ep);
    expect(result2.facts).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('drops relationships with unknown source/target names', async () => {
    const provider = mockProvider(JSON.stringify([
      {
        content: 'Alice works at Acme',
        entities: [{ name: 'Alice', type: 'person' }],
        // "Acme" is not in entities, so this relationship should be dropped
        relationships: [{ source: 'Alice', target: 'Acme', type: 'works_at' }],
      },
    ]));
    const extractor = new LLMExtractor({ provider });
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.relationships).toHaveLength(0);
  });

  it('fallback returns ExtractionResult shape', async () => {
    const provider = throwingProvider(new Error('fail'));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('Alice Smith works at Acme Corp and does many things for the company.');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await extractor.extract(ep);

    expect(result).toHaveProperty('facts');
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('relationships');
    expect(Array.isArray(result.facts)).toBe(true);
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.relationships)).toBe(true);

    warnSpy.mockRestore();
  });

  it('resolves relationships referencing entities declared on a later fact', async () => {
    // Fact 1 declares the relationship; the 'Acme Corp' entity is only
    // declared on fact 2. Single-pass parsing dropped this edge.
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
    const result = await extractor.extract(makeEpisode('text'));

    expect(result.relationships).toHaveLength(1);
    const alice = result.entities.find((e) => e.name === 'Alice');
    const acme = result.entities.find((e) => e.name === 'Acme Corp');
    expect(result.relationships[0].source_id).toBe(alice!.id);
    expect(result.relationships[0].target_id).toBe(acme!.id);
  });

  it('clears the timeout timer after a successful call', async () => {
    vi.useFakeTimers();
    try {
      const provider = mockProvider('[]');
      const extractor = new LLMExtractor({ provider, timeoutMs: 30_000 });
      await extractor.extract(makeEpisode('text'));
      // A leaked race timer would still be pending here.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets the episode fact_ids back-link on successful extraction', async () => {
    const provider = mockProvider(JSON.stringify([
      { content: 'Alice works at Acme', entities: [{ name: 'Alice', type: 'person' }] },
    ]));
    const extractor = new LLMExtractor({ provider });
    const ep = makeEpisode('some text');

    const result = await extractor.extract(ep);
    expect(ep.fact_ids).toEqual(result.facts.map((f) => f.id));
  });

  describe('injectable logger', () => {
    it('routes fallback warnings to the injected logger instead of console', async () => {
      const warn = vi.fn();
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const extractor = new LLMExtractor({
        provider: mockProvider('this is not json'),
        logger: { warn },
      });

      await extractor.extract(makeEpisode('some text'));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to parse JSON'));
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('warns once when the circuit breaker trips', async () => {
      const warn = vi.fn();
      const extractor = new LLMExtractor({
        provider: throwingProvider(new Error('provider down')),
        maxConsecutiveFailures: 3,
        logger: { warn },
      });

      for (let i = 0; i < 5; i++) {
        await extractor.extract(makeEpisode('some text'));
      }

      const tripWarnings = warn.mock.calls.filter(([msg]) =>
        (msg as string).includes('circuit breaker tripped'),
      );
      expect(tripWarnings).toHaveLength(1);
      expect(tripWarnings[0][0]).toContain('3 consecutive');
    });

    it('defaults to console.warn when no logger is provided (back-compat)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const extractor = new LLMExtractor({ provider: mockProvider('not json either') });

      await extractor.extract(makeEpisode('some text'));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed to parse JSON'));
      consoleSpy.mockRestore();
    });
  });
});
