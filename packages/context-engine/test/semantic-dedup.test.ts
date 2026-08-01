/**
 * Tests for embedding-based semantic deduplication —
 * `src/memory/dedup/semantic.ts`. Covers the precompute helper, the pipeline
 * stage (small pairwise path and the SimHash LSH path for over 200 items),
 * and the exported `simHashBuckets` pre-filter.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSemanticDedupStage, precomputeEmbeddings, simHashBuckets } from '../src/memory/dedup/semantic.js';
import { fnv1a } from '../src/memory/dedup/exact.js';
import { seg, makeContext, wordTokenCounter } from './helpers.js';
import type { EmbeddingProvider } from '../src/providers/types.js';

const hashProvider: EmbeddingProvider = {
  dimensions: 8,
  embed: async (texts) =>
    texts.map((t) => Array.from({ length: 8 }, (_, i) => (fnv1a(`${t}:${i}`) / 0xffffffff) * 2 - 1)),
};

const stubProvider: EmbeddingProvider = {
  dimensions: 4,
  embed: async (texts) => texts.map(() => [0, 0, 0, 0]),
};

function similarProvider(groups: string[][]): EmbeddingProvider {
  return {
    dimensions: 4,
    embed: async (texts) =>
      texts.map((text) => {
        for (let gi = 0; gi < groups.length; gi++) {
          if (groups[gi].some((s) => text.includes(s))) {
            const base = [gi + 1, gi + 2, gi + 3, gi + 4];
            const perturbation = text.length * 0.001;
            return base.map((v) => v + perturbation);
          }
        }
        const h = fnv1a(text);
        return [Math.sin(h), Math.cos(h), Math.sin(h * 2), Math.cos(h * 2)];
      }),
  };
}

describe('precomputeEmbeddings', () => {
  it('embeds every unique paragraph across segments', async () => {
    const segments = [
      seg('a', 'First paragraph of sufficient length.\n\nSecond paragraph of sufficient length.'),
      seg('b', 'Third paragraph of sufficient length.'),
    ];

    const map = await precomputeEmbeddings(segments, hashProvider);

    expect(map.size).toBe(3);
    expect(map.get('First paragraph of sufficient length.')).toHaveLength(8);
  });

  it('embeds an identical paragraph only once', async () => {
    const segments = [
      seg('a', 'Same paragraph repeated here across segments.'),
      seg('b', 'Same paragraph repeated here across segments.'),
    ];

    const map = await precomputeEmbeddings(segments, hashProvider);

    expect(map.size).toBe(1);
  });

  it('skips paragraphs shorter than minLength', async () => {
    const segments = [seg('a', 'short\n\nThis is a longer paragraph that meets the minimum length.')];

    const map = await precomputeEmbeddings(segments, hashProvider);

    expect(map.has('short')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('skips structured content entirely', async () => {
    const json = JSON.stringify([{ fact: 'one sufficiently long fact here' }, { fact: 'another sufficiently long fact' }]);

    const map = await precomputeEmbeddings([seg('a', json)], hashProvider);

    expect(map.size).toBe(0);
  });

  it('returns an empty map for no segments', async () => {
    const map = await precomputeEmbeddings([], hashProvider);

    expect(map.size).toBe(0);
  });
});

describe('createSemanticDedupStage', () => {
  it('has name semantic-dedup', () => {
    expect(createSemanticDedupStage({ provider: hashProvider }).name).toBe('semantic-dedup');
  });

  it('is declared cross-segment', () => {
    expect(createSemanticDedupStage({ provider: hashProvider }).scope).toBe('cross-segment');
  });

  it('passes segments through unchanged when no precomputed embeddings are supplied', () => {
    const stage = createSemanticDedupStage({ provider: hashProvider });

    const result = stage.execute([seg('a', 'content here')], makeContext());

    expect(result.segments[0].content).toBe('content here');
  });

  it('passes segments through unchanged when the precomputed map is empty', () => {
    const stage = createSemanticDedupStage({ provider: hashProvider, precomputed: new Map() });

    const result = stage.execute([seg('a', 'content here')], makeContext());

    expect(result.segments[0].content).toBe('content here');
  });

  it('removes a semantically similar paragraph and keeps the unique one', async () => {
    const similarA = 'Multi-agent systems are significantly more expensive than single-agent setups in production';
    const similarB = 'Multi-agent systems are significantly more costly than single-agent setups in production';
    const unique = 'Local deployment improves data sovereignty and reduces latency for enterprises.';
    const provider = similarProvider([['Multi-agent systems are significantly more']]);
    const segments = [seg('a', `${similarA}\n\n${unique}\n\n${similarB}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({ provider, precomputed, threshold: 0.99 });
    const result = stage.execute(segments, makeContext());
    const output = result.segments[0].content;

    expect(output).toContain('sovereignty');
    expect(wordTokenCounter.countTokens(output)).toBeLessThan(wordTokenCounter.countTokens(segments[0].content));
  });

  it('keeps the longer paragraph of a similar pair', async () => {
    const shorter = 'Agents are expensive to run in production environments.';
    const longer = 'Agents are expensive to run in production environments and require careful optimization strategies.';
    const provider = similarProvider([['Agents are expensive']]);
    const segments = [seg('a', `${shorter}\n\n${longer}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({ provider, precomputed, threshold: 0.99 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(longer);
  });

  it('clusters three paragraphs transitively and keeps only the longest', () => {
    const paraA = 'The research team discovered important findings about climate change impacts on agriculture.';
    const paraB = 'The research team found significant results about climate change effects on farming systems.';
    const paraC = 'Scientists found significant results about environmental effects on modern farming systems here.';
    const precomputed = new Map<string, number[]>([
      [paraA, [1.0, 0.0, 0.0, 0.0]],
      [paraB, [0.8, 0.6, 0.0, 0.0]],
      [paraC, [0.2, 0.98, 0.0, 0.0]],
    ]);
    const segments = [seg('s1', `${paraA}\n\n${paraB}\n\n${paraC}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.7 });
    const result = stage.execute(segments, makeContext());
    const paras = result.segments[0].content.split('\n\n').filter((p) => p.trim().length > 0);

    const longest = [paraA, paraB, paraC].sort((a, b) => b.length - a.length)[0];
    expect(paras).toEqual([longest]);
  });

  it('clusters an outer dissimilar pair through a shared similar hub', () => {
    const alpha = 'Alpha summary of coastal erosion measurements gathered during this monitoring season.';
    const beta = 'Beta review of atmospheric pressure readings collected recently from offshore buoys.';
    const gamma = 'Gamma combined synthesis of coastal and atmospheric observations into a single extended report.';
    const precomputed = new Map<string, number[]>([
      [alpha, [1, 0, 0, 0]],
      [beta, [0, 1, 0, 0]],
      [gamma, [0.7071, 0.7071, 0, 0]],
    ]);
    const segments = [seg('s1', `${alpha}\n\n${beta}\n\n${gamma}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.7 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(gamma);
  });

  it('leaves structured JSON intact even when a similar-record embedding is present', async () => {
    const json = JSON.stringify(
      [
        { fact: 'Multi-agent systems are significantly more expensive to run', score: 0.9 },
        { fact: 'Multi-agent systems are significantly more costly to run', score: 0.8 },
      ],
      null,
      2,
    );
    const segments = [seg('a', json)];

    const stage = createSemanticDedupStage({
      provider: stubProvider,
      precomputed: new Map([['placeholder text of sufficient length here', [1, 2, 3, 4]]]),
      threshold: 0.9,
    });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(json);
    expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
  });

  it('reassembles single-newline content with newline separators', () => {
    const lineOne = 'First line of memory content long enough to embed here.';
    const lineTwo = 'Second line of memory content also long enough to embed.';
    const precomputed = new Map<string, number[]>([
      [lineOne, [1, 0, 0, 0]],
      [lineTwo, [0, 1, 0, 0]],
    ]);
    const segments = [seg('a', `${lineOne}\n${lineTwo}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.9 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(`${lineOne}\n${lineTwo}`);
  });

  it('treats paragraphs with mismatched embedding dimensions as dissimilar', () => {
    const first = 'First paragraph long enough to be eligible for semantic comparison.';
    const second = 'Second paragraph long enough to be eligible for semantic comparison.';
    const precomputed = new Map<string, number[]>([
      [first, [1, 0, 0, 0]],
      [second, [1, 0, 0]],
    ]);
    const segments = [seg('a', `${first}\n\n${second}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.5 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(`${first}\n\n${second}`);
  });

  it('treats paragraphs with empty embeddings as dissimilar', () => {
    const first = 'First paragraph long enough to be eligible for semantic comparison.';
    const second = 'Second paragraph long enough to be eligible for semantic comparison.';
    const precomputed = new Map<string, number[]>([
      [first, []],
      [second, []],
    ]);
    const segments = [seg('a', `${first}\n\n${second}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.5 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(`${first}\n\n${second}`);
  });

  it('treats zero-magnitude embeddings as dissimilar', () => {
    const first = 'First paragraph long enough to be eligible for semantic comparison.';
    const second = 'Second paragraph long enough to be eligible for semantic comparison.';
    const precomputed = new Map<string, number[]>([
      [first, [0, 0, 0, 0]],
      [second, [0, 0, 0, 0]],
    ]);
    const segments = [seg('a', `${first}\n\n${second}`)];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.5 });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe(`${first}\n\n${second}`);
  });

  it('ignores paragraphs that are too short or missing from the precomputed map', () => {
    const inMap = 'This paragraph is present in the precomputed embedding map right here.';
    const notInMap = 'This paragraph is absent from the precomputed embedding map entirely today.';
    const precomputed = new Map<string, number[]>([[inMap, [1, 0, 0, 0]]]);
    const content = `tiny\n\n${inMap}\n\n${notInMap}`;

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.5 });
    const result = stage.execute([seg('a', content)], makeContext());

    expect(result.segments[0].content).toBe(content);
  });

  it('leaves a segment of only short paragraphs unchanged', async () => {
    const segments = [seg('a', 'short\ntext\nhere')];
    const precomputed = await precomputeEmbeddings(segments, hashProvider);

    const stage = createSemanticDedupStage({ provider: hashProvider, precomputed });
    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe('short\ntext\nhere');
  });

  it('caps pairwise comparison at maxItems and passes the remainder through', async () => {
    const similar1 = 'Multi-agent systems are significantly more expensive than single-agent setups in production';
    const similar2 = 'Multi-agent systems are significantly more costly than single-agent setups in production';
    const similar3 = 'Multi-agent systems are significantly more pricey than single-agent setups in production';
    const unique1 = 'Local deployment improves data sovereignty and reduces latency for enterprises.';
    const unique2 = 'Cloud infrastructure requires careful capacity planning and cost optimization strategies.';
    const provider = similarProvider([['Multi-agent systems are significantly more']]);
    const segments = [seg('a', [similar1, similar2, similar3, unique1, unique2].join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, provider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stage = createSemanticDedupStage({ provider, precomputed, threshold: 0.99, maxItems: 3 });
    const output = stage.execute(segments, makeContext()).segments[0].content;

    expect(output).toContain('sovereignty');
    expect(output).toContain('capacity planning');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('semantic dedup capped at 3 items'));
    warnSpy.mockRestore();
  });

  it('warns exactly once with the item counts when paragraphs exceed maxItems', async () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph number ${i} with enough length for comparison purposes here.`);
    const segments = [seg('a', paragraphs.join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, hashProvider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    createSemanticDedupStage({ provider: hashProvider, precomputed, maxItems: 3 }).execute(segments, makeContext());

    expect(warnSpy).toHaveBeenCalledWith('context-engine: semantic dedup capped at 3 items (5 provided)');
    warnSpy.mockRestore();
  });

  it('routes to a supplied logger instead of console when paragraphs exceed maxItems', async () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph number ${i} with enough length for comparison purposes here.`);
    const segments = [seg('a', paragraphs.join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, hashProvider);
    const warn = vi.fn();
    const context = makeContext({ logger: { warn } });

    createSemanticDedupStage({ provider: hashProvider, precomputed, maxItems: 3 }).execute(segments, context);

    expect(warn).toHaveBeenCalledWith('context-engine: semantic dedup capped at 3 items (5 provided)');
  });

  it('does not warn when paragraphs stay within maxItems', async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Unique paragraph number ${i} with enough content for testing purposes.`);
    const segments = [seg('a', paragraphs.join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, hashProvider);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    createSemanticDedupStage({ provider: hashProvider, precomputed }).execute(segments, makeContext());

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('uses the SimHash LSH path for over 200 paragraphs, collapsing an exact duplicate', () => {
    const unique = Array.from({ length: 200 }, (_, i) => `Paragraph number ${i} carries enough distinct words for semantic comparison here.`);
    const duplicated = unique[0];
    const precomputed = new Map<string, number[]>();
    unique.forEach((text, i) => {
      const oneHot = new Array<number>(unique.length).fill(0);
      oneHot[i] = 1;
      precomputed.set(text, oneHot);
    });
    const segments = [seg('a', [...unique, duplicated].join('\n\n'))];

    const stage = createSemanticDedupStage({ provider: stubProvider, precomputed, threshold: 0.999 });
    const output = stage.execute(segments, makeContext()).segments[0].content;
    const paras = output.split('\n\n').filter((p) => p.trim().length > 0);

    expect(paras).toHaveLength(200);
    expect(paras.filter((p) => p === duplicated)).toHaveLength(1);
  });
});

describe('simHashBuckets', () => {
  const vecA = [0.1, 0.9, -0.4, 0.7, 0.2, -0.6, 0.5, -0.3];
  const vecB = [-0.8, 0.2, 0.6, -0.1, -0.5, 0.4, -0.7, 0.9];

  it('returns an empty set when every vector is null', () => {
    expect(simHashBuckets([null, null], 2).size).toBe(0);
  });

  it('returns an empty set when the limit is zero', () => {
    expect(simHashBuckets([vecA, vecB], 0).size).toBe(0);
  });

  it('pairs two identical vectors as candidates', () => {
    const candidates = simHashBuckets([vecA, vecA], 2);

    expect(candidates.has('0:1')).toBe(true);
  });

  it('skips null vectors while still pairing identical non-null vectors', () => {
    const candidates = simHashBuckets([vecA, null, vecA], 3);

    expect(candidates.has('0:2')).toBe(true);
  });

  it('emits candidate keys with the lower index first', () => {
    const candidates = simHashBuckets([vecA, vecA, vecA], 3);

    for (const key of candidates) {
      const [lo, hi] = key.split(':').map(Number);
      expect(lo).toBeLessThan(hi);
    }
  });
});
