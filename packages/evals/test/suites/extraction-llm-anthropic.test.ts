/**
 * LLM Extraction Efficacy — Anthropic Backend (Gated)
 *
 * Runs the extraction corpus through LLMExtractor backed by the Claude API.
 * DOUBLE-GATED: requires both ANTHROPIC_API_KEY and RUN_ANTHROPIC_EVALS=1 —
 * the explicit opt-in exists so a key present in the shell environment can
 * never make a routine `npm test` spend API credits silently. A run is
 * 3 samples × 19 calls (~9.6K input + ~11.7K output tokens ≈ $0.34 on
 * claude-opus-4-8) and ENFORCES the ratchet floors, not just shape.
 *
 * To run:
 *   set -a; source ../../.env; set +a
 *   RUN_ANTHROPIC_EVALS=1 npx vitest run test/suites/extraction-llm-anthropic.test.ts
 *
 * Model via ANTHROPIC_MODEL (default claude-opus-4-8).
 */

import { describe, it, expect } from 'vitest';
import { LLMExtractor } from '@cycgraph/memory';
import {
  runLlmExtractionEfficacy,
  createAnthropicCompleteProvider,
  DEFAULT_ANTHROPIC_MODEL,
  type UsageTally,
} from '../../src/suites/memory/extraction-efficacy-llm.js';
import { runBlindEfficacy } from '../../src/suites/memory/extraction-efficacy-blind.js';

const optedIn = Boolean(process.env['ANTHROPIC_API_KEY']) && process.env['RUN_ANTHROPIC_EVALS'] === '1';

describe.skipIf(!optedIn)('extraction efficacy — LLM tier (Anthropic)', () => {
  it('measures the corpus through LLMExtractor on Claude and holds the ratchet floors', async () => {
    const result = await runLlmExtractionEfficacy({ backend: 'anthropic', samples: 3 });

    expect(result.suite).toBe('memory');
    const metrics = new Map(result.deterministicResults.map((d) => [d.metric, d]));

    // Print BEFORE asserting so a floor failure still documents the run.
    // eslint-disable-next-line no-console
    console.log('\nAnthropic extraction efficacy run:');
    for (const d of result.deterministicResults) {
      // eslint-disable-next-line no-console
      console.log(`  ${d.passed ? 'PASS' : 'FAIL'} ${d.metric} = ${d.actual.toFixed(3)} (gate ${d.expected})  ${d.description}`);
    }

    for (const name of [
      'extraction_llm_entity_recall',
      'extraction_llm_relationship_recall',
      'extraction_llm_negation_safety',
      'extraction_llm_embedded_stem_safety',
      'extraction_llm_fallback_rate',
    ]) {
      const m = metrics.get(name);
      expect(m, name).toBeDefined();
      // Ratchet enforcement: floors are set below the 2026-07-23 baseline;
      // raise them as quality improves, never lower to make this pass.
      expect(m!.passed, `${name} — ${m!.description} (actual ${m!.actual}, expected ${m!.expected})`).toBe(true);
    }

    const deltas = result.deterministicResults.filter((d) => d.metric.includes('_vs_rule_'));
    expect(deltas.length).toBe(4);
  }, 600_000);

  it('holds the blind-corpus ratchet floors on Claude', async () => {
    const usage: UsageTally = { inputTokens: 0, outputTokens: 0 };
    const extractor = new LLMExtractor({
      provider: createAnthropicCompleteProvider(DEFAULT_ANTHROPIC_MODEL, 60_000, usage),
    });

    const result = await runBlindEfficacy(extractor, 'llm', { gate: true });

    // Gated: floors sit under the 2026-07-23 baseline minimum.
    // eslint-disable-next-line no-console
    console.log(`\nBlind corpus (Claude ${DEFAULT_ANTHROPIC_MODEL}) — ${usage.inputTokens} in / ${usage.outputTokens} out tokens:`);
    for (const d of result.deterministicResults) {
      // eslint-disable-next-line no-console
      console.log(`  ${d.passed ? 'PASS' : 'FAIL'} ${d.metric} = ${d.actual.toFixed(3)} (gate ${d.expected})  ${d.description}`);
    }
    for (const d of result.deterministicResults) {
      expect(d.passed, `${d.metric} (actual ${d.actual}, expected ${d.expected})`).toBe(true);
    }
    expect(result.deterministicResults.length).toBe(4);
  }, 600_000);
});

describe.skipIf(optedIn)('extraction efficacy — LLM tier (Anthropic, skipped)', () => {
  it('skips without ANTHROPIC_API_KEY + RUN_ANTHROPIC_EVALS=1 (explicit spend opt-in)', () => {
    expect(optedIn).toBe(false);
  });
});
