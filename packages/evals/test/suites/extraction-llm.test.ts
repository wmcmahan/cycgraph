/**
 * LLM Extraction Efficacy — Gated Test Wrapper
 *
 * Skips cleanly when no Ollama server (with at least one pulled model) is
 * reachable — same pattern as the DATABASE_URL-gated orchestrator-postgres
 * suite. To run: `ollama serve`, `ollama pull <model>`, then
 * `npx vitest run test/suites/extraction-llm.test.ts` (optionally with
 * OLLAMA_BASE_URL / OLLAMA_MODEL).
 *
 * Assertions here check the track RUNS and reports — quality thresholds
 * are deliberately not enforced until baselines are measured (all metrics
 * are threshold-0 "measured" results; see extraction-efficacy-llm.ts).
 */

import { describe, it, expect } from 'vitest';
import { ollamaAvailable, runLlmExtractionEfficacy } from '../../src/suites/memory/extraction-efficacy-llm.js';

const available = await ollamaAvailable();

describe.skipIf(!available)('extraction efficacy — LLM tier (Ollama)', () => {
  it('measures the corpus through LLMExtractor and reports all metrics', async () => {
    const result = await runLlmExtractionEfficacy({ samples: 1 });

    expect(result.suite).toBe('memory');
    const metrics = new Map(result.deterministicResults.map((d) => [d.metric, d]));

    // Core measured metrics present, in [0, 1].
    for (const name of [
      'extraction_llm_entity_recall',
      'extraction_llm_relationship_recall',
      'extraction_llm_negation_safety',
      'extraction_llm_embedded_stem_safety',
      'extraction_llm_fallback_rate',
    ]) {
      const m = metrics.get(name);
      expect(m, name).toBeDefined();
      expect(m!.actual).toBeGreaterThanOrEqual(0);
      expect(m!.actual).toBeLessThanOrEqual(1);
    }

    // One delta metric per ceiling case, bounded in [-1, 1].
    const deltas = result.deterministicResults.filter((d) => d.metric.includes('_vs_rule_'));
    expect(deltas.length).toBe(4);
    for (const d of deltas) {
      expect(d.actual).toBeGreaterThanOrEqual(-1);
      expect(d.actual).toBeLessThanOrEqual(1);
    }

    // Print the measured baseline so a first real run documents itself.
    // eslint-disable-next-line no-console
    console.log('\nLLM extraction efficacy baseline:');
    for (const d of result.deterministicResults) {
      // eslint-disable-next-line no-console
      console.log(`  ${d.metric} = ${d.actual.toFixed(3)}  ${d.description}`);
    }
  }, 600_000);
});

describe.skipIf(available)('extraction efficacy — LLM tier (skipped)', () => {
  it('skips when no Ollama server with a pulled model is reachable', () => {
    expect(available).toBe(false);
  });
});
