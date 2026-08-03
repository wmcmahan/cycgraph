/**
 * Unit tests for the LLM-tier extraction-efficacy driver
 * (src/suites/memory/extraction-efficacy-llm.ts) with a stubbed fetch —
 * no Ollama server or Anthropic key required. The live-model runs stay in
 * extraction-llm.test.ts / extraction-llm-anthropic.test.ts (gated).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ollamaAvailable,
  relTypeMatches,
  hasNegationMarker,
  createAnthropicCompleteProvider,
  runLlmExtractionEfficacy,
  type UsageTally,
} from '../../src/suites/memory/extraction-efficacy-llm.js';

const EXTRACTION_RESPONSE = JSON.stringify([
  {
    content: 'Alice works at Acme',
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'Acme', type: 'organization' },
    ],
    relationships: [{ source: 'Alice', target: 'Acme', type: 'works_at' }],
  },
]);

function ollamaFetchStub(response: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ response }), { status: 200 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('hasNegationMarker', () => {
  it.each([
    ['never_worked_at', true],
    ['does_not_manage', true],
    ['no_longer_works_at', true],
    ['former_employee_of', true],
    ['stopped_working_at', true],
    ['works_at', false],
    ['manages', false],
    ['annotates', false],
  ])('classifies %s as %s', (type, expected) => {
    expect(hasNegationMarker(type)).toBe(expected);
  });
});

describe('relTypeMatches', () => {
  it('matches identical canonical types', () => {
    expect(relTypeMatches('work_at', 'work_at')).toBe(true);
  });

  it('matches a stem-sharing free-form type', () => {
    expect(relTypeMatches('work_at', 'works_at')).toBe(true);
  });

  it('rejects an unrelated type', () => {
    expect(relTypeMatches('work_at', 'manages')).toBe(false);
  });

  it('ignores short stop tokens when stemming', () => {
    expect(relTypeMatches('depend_on', 'depends_on')).toBe(true);
  });
});

describe('ollamaAvailable', () => {
  it('reports available when the server lists at least one model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 }),
    ));

    await expect(ollamaAvailable('http://stub:11434')).resolves.toBe(true);
  });

  it('reports unavailable for a bare server with no models pulled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ));

    await expect(ollamaAvailable('http://stub:11434')).resolves.toBe(false);
  });

  it('reports unavailable on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await expect(ollamaAvailable('http://stub:11434')).resolves.toBe(false);
  });

  it('reports unavailable when the probe throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    await expect(ollamaAvailable('http://stub:11434')).resolves.toBe(false);
  });
});

describe('createAnthropicCompleteProvider', () => {
  function anthropicResponse(overrides: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: EXTRACTION_RESPONSE }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 7 },
        ...overrides,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('returns joined text blocks and tallies usage', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => anthropicResponse()));
    const usage: UsageTally = { inputTokens: 0, outputTokens: 0 };
    const provider = createAnthropicCompleteProvider('claude-opus-4-8', 5_000, usage);

    const text = await provider.complete('extract');

    expect(text).toBe(EXTRACTION_RESPONSE);
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('throws when the response stops for any reason other than end_turn', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => anthropicResponse({ stop_reason: 'max_tokens' })));
    const usage: UsageTally = { inputTokens: 0, outputTokens: 0 };
    const provider = createAnthropicCompleteProvider('claude-opus-4-8', 5_000, usage);

    await expect(provider.complete('extract')).rejects.toThrow('stopped with max_tokens');
  });
});

describe('runLlmExtractionEfficacy (ollama backend, stubbed fetch)', () => {
  it('produces measured-only metrics with zero fallbacks on clean extractions', async () => {
    vi.stubGlobal('fetch', ollamaFetchStub(EXTRACTION_RESPONSE));

    const results = await runLlmExtractionEfficacy({
      backend: 'ollama',
      baseUrl: 'http://stub:11434',
      model: 'stub-model',
      timeoutMs: 5_000,
    });

    const byName = new Map(results.deterministicResults.map((r) => [r.metric, r]));
    expect(byName.get('extraction_llm_entity_recall')?.passed).toBe(true);
    expect(byName.get('extraction_llm_relationship_recall')?.passed).toBe(true);
    expect(byName.get('extraction_llm_negation_safety')?.passed).toBe(true);
    expect(byName.get('extraction_llm_embedded_stem_safety')?.passed).toBe(true);
    expect(byName.get('extraction_llm_fallback_rate')?.actual).toBe(0);
    expect(byName.get('extraction_llm_usage_input_tokens')).toBeUndefined();
    expect(
      results.deterministicResults.filter((r) => r.metric.startsWith('extraction_llm_vs_rule_')).length,
    ).toBeGreaterThan(0);
    expect(results.deterministicResults.every((r) => r.passed)).toBe(true);
  });

  it('averages metrics across multiple samples', async () => {
    const fetchStub = ollamaFetchStub(EXTRACTION_RESPONSE);
    vi.stubGlobal('fetch', fetchStub);

    const two = await runLlmExtractionEfficacy({
      backend: 'ollama',
      baseUrl: 'http://stub:11434',
      model: 'stub-model',
      samples: 2,
      timeoutMs: 5_000,
    });

    const single = await runLlmExtractionEfficacy({
      backend: 'ollama',
      baseUrl: 'http://stub:11434',
      model: 'stub-model',
      timeoutMs: 5_000,
    });

    const pick = (r: typeof two, name: string) =>
      r.deterministicResults.find((x) => x.metric === name)?.actual;
    expect(pick(two, 'extraction_llm_entity_recall')).toBe(pick(single, 'extraction_llm_entity_recall'));
  });

  it('counts silent fallbacks to the rule-based tier when the provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const results = await runLlmExtractionEfficacy({
      backend: 'ollama',
      baseUrl: 'http://stub:11434',
      model: 'stub-model',
      timeoutMs: 5_000,
    });

    const fallback = results.deterministicResults.find(
      (r) => r.metric === 'extraction_llm_fallback_rate',
    );
    expect(fallback?.actual).toBe(1);
    expect(fallback?.passed).toBe(true);
  });
});

describe('runLlmExtractionEfficacy (anthropic backend, stubbed fetch)', () => {
  it('applies ratchet floors and reports usage tokens', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: EXTRACTION_RESPONSE }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    const results = await runLlmExtractionEfficacy({
      backend: 'anthropic',
      model: 'claude-opus-4-8',
      timeoutMs: 5_000,
    });

    const byName = new Map(results.deterministicResults.map((r) => [r.metric, r]));
    expect(byName.get('extraction_llm_usage_input_tokens')?.actual).toBeGreaterThan(0);
    expect(byName.get('extraction_llm_usage_output_tokens')?.actual).toBeGreaterThan(0);
    expect(byName.get('extraction_llm_fallback_rate')?.actual).toBe(0);
  });
});
