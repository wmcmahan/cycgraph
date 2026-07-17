import { describe, it, expect, vi } from 'vitest';
import { createSemanticDedupStage, precomputeEmbeddings } from '../src/memory/dedup/semantic.js';
import type { EmbeddingProvider } from '../src/providers/types.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { fnv1a } from '../src/memory/dedup/exact.js';

const counter = new DefaultTokenCounter();

// Mock embedding provider: deterministic pseudo-embeddings from content hash
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const hash = fnv1a(t);
      return Array.from({ length: 8 }, (_, i) => Math.sin(hash * (i + 1)));
    });
  }
}

// Provider that returns identical vectors for similar-meaning texts
class SimilarityMockProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  private similarGroups: string[][];

  constructor(similarGroups: string[][]) {
    this.similarGroups = similarGroups;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => {
      // Find which group this text belongs to
      for (let gi = 0; gi < this.similarGroups.length; gi++) {
        if (this.similarGroups[gi].some(s => text.includes(s))) {
          // Same group → similar vector (small perturbation)
          const base = [gi + 1, gi + 2, gi + 3, gi + 4];
          const perturbation = text.length * 0.001;
          return base.map(v => v + perturbation);
        }
      }
      // No group → random-ish vector
      const hash = fnv1a(text);
      return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2), Math.cos(hash * 2)];
    });
  }
}

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

describe('precomputeEmbeddings', () => {
  it('embeds all unique paragraphs from segments', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [
      makeSegment('a', 'First paragraph of sufficient length.\n\nSecond paragraph of sufficient length.'),
      makeSegment('b', 'Third paragraph of sufficient length.'),
    ];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.size).toBe(3);
    expect(map.get('First paragraph of sufficient length.')).toBeDefined();
    expect(map.get('First paragraph of sufficient length.')!.length).toBe(8);
  });

  it('deduplicates identical paragraphs before embedding', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [
      makeSegment('a', 'Same paragraph repeated here.'),
      makeSegment('b', 'Same paragraph repeated here.'),
    ];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.size).toBe(1); // Only embedded once
  });

  it('skips short paragraphs', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [makeSegment('a', 'short\n\nThis is a longer paragraph that meets the minimum length.')];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.has('short')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('returns empty map for empty segments', async () => {
    const provider = new MockEmbeddingProvider();
    const map = await precomputeEmbeddings([], provider);
    expect(map.size).toBe(0);
  });
});

describe('createSemanticDedupStage', () => {
  it('removes semantically similar paragraphs', async () => {
    // Two paragraphs that mean the same thing
    const similar1 = 'Multi-agent systems are significantly more expensive than single-agent setups in production';
    const similar2 = 'Multi-agent systems are significantly more costly than single-agent setups in production';
    const unique = 'Local deployment improves data sovereignty and reduces latency for enterprises.';

    const provider = new SimilarityMockProvider([
      ['Multi-agent systems are significantly more'], // group 0: similar meaning
    ]);

    const segments = [makeSegment('a', `${similar1}\n\n${unique}\n\n${similar2}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      threshold: 0.99, // High threshold — our mock makes very similar vectors for the group
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const output = result.segments[0].content;

    // Should keep the unique paragraph
    expect(output).toContain('sovereignty');
    // Should have removed one of the similar paragraphs
    const inputTokens = counter.countTokens(segments[0].content);
    const outputTokens = counter.countTokens(output);
    expect(outputTokens).toBeLessThan(inputTokens);
  });

  it('leaves structured (JSON) segments intact even with similar record lines', async () => {
    // Two JSON records similar enough to cluster semantically — deduping
    // either line corrupts the array.
    const json = JSON.stringify(
      [
        { fact: 'Multi-agent systems are significantly more expensive to run', score: 0.9 },
        { fact: 'Multi-agent systems are significantly more costly to run', score: 0.8 },
      ],
      null,
      2,
    );

    const provider = new SimilarityMockProvider([
      ['Multi-agent systems are significantly more'],
    ]);

    const segments = [makeSegment('a', json)];
    const precomputed = await precomputeEmbeddings(segments, provider);
    // Structured content is skipped at precompute time too — nothing embedded
    expect(precomputed.size).toBe(0);

    const stage = createSemanticDedupStage({
      provider,
      // Simulate embeddings that DID exist (e.g. precomputed before this fix,
      // or shared with prose segments) — the stage must still not touch JSON.
      precomputed: new Map([['placeholder text of sufficient length here', [1, 2, 3, 4]]]),
      threshold: 0.9,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe(json);
    expect(() => JSON.parse(result.segments[0].content)).not.toThrow();
  });

  it('passes through when no pre-computed embeddings', () => {
    const provider = new MockEmbeddingProvider();
    const stage = createSemanticDedupStage({ provider });

    const segments = [makeSegment('a', 'content here')];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('content here');
  });

  it('keeps longer paragraph of a duplicate pair', async () => {
    const shorter = 'Agents are expensive to run in production environments.';
    const longer = 'Agents are expensive to run in production environments and require careful optimization strategies.';

    const provider = new SimilarityMockProvider([['Agents are expensive']]);
    const segments = [makeSegment('a', `${shorter}\n\n${longer}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      threshold: 0.99,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('optimization strategies');
  });

  it('handles transitive similarity (A~B, B~C, A!~C) via union-find', async () => {
    // A is similar to B, B is similar to C, but A is NOT similar to C.
    // Union-find should cluster all three and keep only the longest.
    const paraA = 'The research team discovered important findings about climate change impacts on agriculture.';
    const paraB = 'The research team found significant results about climate change effects on farming systems.';
    const paraC = 'Scientists found significant results about environmental effects on modern farming systems.';

    // Custom provider: A~B (high sim), B~C (high sim), A~C (low sim)
    const embeddingMap = new Map<string, number[]>();
    embeddingMap.set(paraA, [1.0, 0.0, 0.0, 0.0]);
    embeddingMap.set(paraB, [0.8, 0.6, 0.0, 0.0]); // cos(A,B) = 0.8, cos(B,C) ≈ 0.8
    embeddingMap.set(paraC, [0.2, 0.98, 0.0, 0.0]); // cos(A,C) ≈ 0.2

    const provider = new MockEmbeddingProvider();
    const segments = [makeSegment('s1', `${paraA}\n\n${paraB}\n\n${paraC}`)];

    const stage = createSemanticDedupStage({
      provider,
      precomputed: embeddingMap,
      threshold: 0.7,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const output = result.segments[0].content;
    const paras = output.split('\n\n').filter(p => p.trim().length > 0);

    // All three should cluster together; only one (longest) survives
    expect(paras).toHaveLength(1);
    // The longest paragraph should be kept
    const longest = [paraA, paraB, paraC].sort((a, b) => b.length - a.length)[0];
    expect(paras[0]).toBe(longest);
  });

  it('has name semantic-dedup', () => {
    const provider = new MockEmbeddingProvider();
    expect(createSemanticDedupStage({ provider }).name).toBe('semantic-dedup');
  });

  it('handles segments with all short paragraphs', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [makeSegment('a', 'short\ntext\nhere')];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({ provider, precomputed });
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('short\ntext\nhere');
  });

  it('caps pairwise comparison at maxItems and passes remaining items through', async () => {
    // 5 paragraphs where first 3 are similar; cap at 3 means items 4-5 pass through undeduped
    const similar1 = 'Multi-agent systems are significantly more expensive than single-agent setups in production';
    const similar2 = 'Multi-agent systems are significantly more costly than single-agent setups in production';
    const similar3 = 'Multi-agent systems are significantly more pricey than single-agent setups in production';
    const unique1 = 'Local deployment improves data sovereignty and reduces latency for enterprises.';
    const unique2 = 'Cloud infrastructure requires careful capacity planning and cost optimization strategies.';

    const provider = new SimilarityMockProvider([
      ['Multi-agent systems are significantly more'],
    ]);

    const segments = [makeSegment('a', [similar1, similar2, similar3, unique1, unique2].join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      threshold: 0.99,
      maxItems: 3,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = stage.execute(segments, context);
    const output = result.segments[0].content;

    // Items beyond the cap should pass through
    expect(output).toContain('sovereignty');
    expect(output).toContain('capacity planning');
    // Warning should have been logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('semantic dedup capped at 3 items'));
    warnSpy.mockRestore();
  });

  it('logs a warning when paragraphs exceed maxItems', async () => {
    const provider = new MockEmbeddingProvider();
    const paragraphs = Array.from({ length: 5 }, (_, i) =>
      `Paragraph number ${i} with enough length for comparison purposes here.`
    );
    const segments = [makeSegment('a', paragraphs.join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      maxItems: 3,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stage.execute(segments, context);
    expect(warnSpy).toHaveBeenCalledWith('context-engine: semantic dedup capped at 3 items (5 provided)');
    warnSpy.mockRestore();
  });

  it('does not warn when paragraphs are within default maxItems of 500', async () => {
    const provider = new MockEmbeddingProvider();
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Unique paragraph number ${i} with enough content for testing purposes.`
    );
    const segments = [makeSegment('a', paragraphs.join('\n\n'))];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({ provider, precomputed });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stage.execute(segments, context);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
