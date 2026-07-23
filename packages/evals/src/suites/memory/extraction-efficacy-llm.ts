/**
 * Extraction Efficacy — LLM Tier
 *
 * Runs the SAME labeled corpus (extraction-corpus.ts) through
 * @cycgraph/memory's LLMExtractor to measure the rule-based vs LLM quality
 * delta on identical ground truth.
 *
 * Interpretation guide (the two tiers mean different things):
 * - The gated corpus is the rule-based tier's home turf — it was authored
 *   around that implementation's envelope, so rule-based scoring 1.0 there
 *   is a regression fence, not a capability claim. The LLM will NOT
 *   reliably hit 1.0 on it (sampling variance, JSON discipline).
 * - The CEILING cases are the discriminator: constructions the rule-based
 *   tier structurally cannot handle (lists, passive voice, all-caps orgs,
 *   sentence-start names). The `extraction_llm_vs_rule_*_delta` metrics
 *   are the numbers that justify — or refute — the docs' "LLM-backed
 *   extraction for maximum quality" claim.
 *
 * Gating follows measure-first-then-gate: the ANTHROPIC backend carries
 * ratchet floors set below its measured baseline (claude-opus-4-8,
 * 2026-07-23, n=3, zero cross-sample variance); the OLLAMA backend stays
 * measured-only (threshold 0) until a local baseline exists. The
 * `fallback_rate` metric tracks how often LLMExtractor silently degraded
 * to its rule-based fallback (parse failure / timeout): a high rate means
 * the other metrics are measuring the fallback, not the model.
 *
 * Requires a local Ollama server with at least one model pulled
 * (`ollama serve` + `ollama pull <model>`); the vitest wrapper skips
 * cleanly when unavailable, mirroring the DATABASE_URL-gated pg suite.
 * Configure via OLLAMA_BASE_URL / OLLAMA_MODEL.
 *
 * @module suites/memory/extraction-efficacy-llm
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMExtractor, RuleBasedExtractor } from '@cycgraph/memory';
import type { Episode, ExtractionResult, LLMProvider, SemanticExtractor } from '@cycgraph/memory';
import { assertEqual, assertGreaterThanOrEqual, assertLessThanOrEqual } from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import { EXTRACTION_CORPUS, type ExtractionCase } from './extraction-corpus.js';

const DEFAULT_BASE_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const DEFAULT_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3:8b-instruct-q4_K_M';
export const DEFAULT_ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-8';

export interface LlmEfficacyOptions {
  /** Which LLM serves the extractor (default 'ollama'). */
  backend?: 'ollama' | 'anthropic';
  baseUrl?: string;
  model?: string;
  /** Samples per corpus case; metrics are averaged across samples (default 1). */
  samples?: number;
  /** Per-call timeout in milliseconds (default 60 000). */
  timeoutMs?: number;
}

/**
 * Probe Ollama availability: server reachable AND at least one model
 * pulled (a bare server 404s on generate). Used by the gated test wrapper.
 */
export async function ollamaAvailable(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = await res.json() as { models?: unknown[] };
      return Array.isArray(body.models) && body.models.length > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Token usage accumulated across a run (Anthropic backend only). */
export interface UsageTally {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Anthropic-backed extraction provider via the official SDK. No sampling
 * params (removed on Opus 4.7+; would 400) and no `thinking` field —
 * one-sentence fact extraction is transcription, not reasoning, and omitting
 * it keeps output tokens (and cost) minimal on the Opus family. Non-`end_turn`
 * stop reasons (refusal, max_tokens) throw so LLMExtractor's fallback path —
 * and the fallback_rate metric — see them instead of silently scoring a
 * truncated response.
 */
export function createAnthropicCompleteProvider(
  model: string,
  timeoutMs: number,
  usage: UsageTally,
): LLMProvider {
  const client = new Anthropic({ timeout: timeoutMs });
  return {
    async complete(prompt: string): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      if (response.stop_reason !== 'end_turn') {
        throw new Error(`Anthropic extraction stopped with ${response.stop_reason}`);
      }
      return response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
    },
  };
}

/**
 * Extraction-oriented Ollama provider: temperature 0 for maximum
 * reproducibility (extraction is a transcription task, not a creative one).
 * Deliberately separate from the judge EvalProvider — different purpose,
 * different knobs.
 */
function createOllamaCompleteProvider(baseUrl: string, model: string, timeoutMs: number): LLMProvider {
  return {
    async complete(prompt: string): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: 0 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Ollama generate failed: HTTP ${res.status} ${res.statusText}`);
        }
        const body = await res.json() as { response?: unknown };
        if (typeof body.response !== 'string') {
          throw new Error('Ollama generate: unexpected response shape');
        }
        return body.response;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function makeEpisode(text: string, startedAt: Date): Episode {
  return {
    id: crypto.randomUUID(),
    topic: text.slice(0, 50),
    messages: [{
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: startedAt,
      metadata: {},
    }],
    started_at: startedAt,
    ended_at: startedAt,
    fact_ids: [],
    provenance: { source: 'human', created_at: startedAt },
  };
}

function emittedTriples(result: ExtractionResult): Array<{ source: string; type: string; target: string }> {
  const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
  return result.relationships.map((r) => ({
    source: nameById.get(r.source_id) ?? '?',
    type: r.relation_type,
    target: nameById.get(r.target_id) ?? '?',
  }));
}

/**
 * LLM relation types are free-form ("works_at", "employed_by"); demanding
 * the rule-based canonical vocabulary would punish the LLM for using
 * richer language. A triple matches when source and target names match
 * and the relation type shares a token stem with the expected type.
 */
export function relTypeMatches(expected: string, actual: string): boolean {
  const norm = (s: string): string[] => s.toLowerCase().split(/[_\s-]+/).filter((w) => w.length > 2);
  const expectedWords = norm(expected);
  const actualWords = new Set(norm(actual));
  return expectedWords.some((w) => [...actualWords].some((a) => a.startsWith(w) || w.startsWith(a)));
}

interface Tally { hit: number; total: number }
const ratio = (t: Tally): number => (t.total === 0 ? 1 : t.hit / t.total);

interface CaseScore {
  entity: Tally;
  relRecall: Tally;
  forbidClean: Tally;
}

function scoreCase(c: ExtractionCase, result: ExtractionResult): CaseScore {
  const score: CaseScore = {
    entity: { hit: 0, total: 0 },
    relRecall: { hit: 0, total: 0 },
    forbidClean: { hit: 0, total: 0 },
  };
  const entityNames = new Set(result.entities.map((e) => e.name));
  const emitted = emittedTriples(result);

  for (const exp of c.expectEntities ?? []) {
    score.entity.total++;
    // Name containment either way: "Acme" vs "Acme Corp" counts — LLMs
    // legitimately vary surface form; identity is what's being measured.
    if ([...entityNames].some((n) => n.includes(exp.name) || exp.name.includes(n))) {
      score.entity.hit++;
    }
  }
  for (const exp of c.expectRelationships ?? []) {
    score.relRecall.total++;
    const matched = emitted.some((t) =>
      (t.source.includes(exp.source) || exp.source.includes(t.source)) &&
      (t.target.includes(exp.target) || exp.target.includes(t.target)) &&
      relTypeMatches(exp.type, t.type),
    );
    if (matched) score.relRecall.hit++;
  }
  if (c.forbidRelationships) {
    score.forbidClean.total++;
    // LLM-tier violation spec: an edge stem-matching the danger verb WITHOUT
    // a negation marker in its type. Negation-preserving edges
    // (`never_worked_at`, `does_not_manage`) are faithful extraction, not
    // fabrication — only an affirmative `work_at` on "never worked at" fails.
    // Falls back to the strict zero-edge spec when no dangerVerb is labeled.
    const violation = c.dangerVerb !== undefined
      ? emitted.some((t) => relTypeMatches(c.dangerVerb!, t.type) && !hasNegationMarker(t.type))
      : emitted.length > 0;
    if (!violation) score.forbidClean.hit++;
  }
  return score;
}

/**
 * Heuristic detection of negation OR cessation in a relation type. A
 * violating edge asserts the affirmative PRESENT relation despite the
 * sentence negating it — `work_at` on "never worked at" fails, while both
 * negation-preserving (`never_worked_at`, `does_not_manage`) and
 * cessation-preserving (`stopped_working_at`, `former_employee_of`,
 * `no_longer_works_at`) phrasings are faithful extraction. Word-boundary-ish
 * on underscore/space/hyphen separators; rare false-positives ("not" inside
 * an unrelated stem) are acceptable for an eval heuristic.
 */
export function hasNegationMarker(relationType: string): boolean {
  const type = relationType.toLowerCase();
  return (
    /(?:^|[_\s-])(?:never|not?|no_longer|stopped?|former(?:ly)?|ceased?|quit|resigned|left|ended?|used_to)(?:[_\s-]|$)/.test(type) ||
    /n[o']?t(?=[_\s-])|doesnt|didnt|isnt|wasnt/.test(type)
  );
}

async function runCorpusThrough(
  extractor: SemanticExtractor,
  cases: ExtractionCase[],
): Promise<Map<string, CaseScore>> {
  const startedAt = new Date('2026-01-01T10:00:00Z');
  const scores = new Map<string, CaseScore>();
  for (const c of cases) {
    const result = await extractor.extract(makeEpisode(c.text, startedAt));
    scores.set(c.id, scoreCase(c, result));
  }
  return scores;
}

function sumTallies(scores: Map<string, CaseScore>, ids: Set<string>, pick: (s: CaseScore) => Tally): Tally {
  const out: Tally = { hit: 0, total: 0 };
  for (const [id, s] of scores) {
    if (!ids.has(id)) continue;
    const t = pick(s);
    out.hit += t.hit;
    out.total += t.total;
  }
  return out;
}

/**
 * Run the corpus through LLMExtractor (and RuleBasedExtractor for the
 * ceiling deltas). All metrics measured-only until baselines exist.
 */
export async function runLlmExtractionEfficacy(options: LlmEfficacyOptions = {}): Promise<TestCaseResults> {
  const backend = options.backend ?? 'ollama';
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? (backend === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL);
  const samples = options.samples ?? 1;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const usage: UsageTally = { inputTokens: 0, outputTokens: 0 };

  // Fallback observability: a warn mentioning "falling back" means this
  // case's result came from the rule-based tier, not the model.
  let fallbacks = 0;
  const provider = backend === 'anthropic'
    ? createAnthropicCompleteProvider(model, timeoutMs, usage)
    : createOllamaCompleteProvider(baseUrl, model, timeoutMs);
  const llm = new LLMExtractor({
    provider,
    timeoutMs,
    // The breaker would silently convert the rest of the corpus to
    // rule-based after 3 provider failures — for measurement, fail loud.
    maxConsecutiveFailures: EXTRACTION_CORPUS.length + 1,
    logger: { warn: (m) => { if (m.includes('falling back')) fallbacks++; } },
  });
  const ruleBased = new RuleBasedExtractor();

  const gatedIds = new Set(EXTRACTION_CORPUS.filter((c) => c.gated).map((c) => c.id));
  const ceilingCases = EXTRACTION_CORPUS.filter((c) => !c.gated);
  const negationIds = new Set(EXTRACTION_CORPUS.filter((c) => c.category === 'negation').map((c) => c.id));
  const stemIds = new Set(EXTRACTION_CORPUS.filter((c) => c.category === 'embedded-stem').map((c) => c.id));

  // Averaged across samples (LLM output is nondeterministic even at temp 0
  // across server versions/hardware).
  const sampleMetrics: Array<Record<string, number>> = [];
  let totalCalls = 0;

  for (let s = 0; s < samples; s++) {
    const llmScores = await runCorpusThrough(llm, EXTRACTION_CORPUS);
    totalCalls += EXTRACTION_CORPUS.length;

    const metrics: Record<string, number> = {
      entity_recall: ratio(sumTallies(llmScores, gatedIds, (x) => x.entity)),
      relationship_recall: ratio(sumTallies(llmScores, gatedIds, (x) => x.relRecall)),
      negation_safety: ratio(sumTallies(llmScores, negationIds, (x) => x.forbidClean)),
      embedded_stem_safety: ratio(sumTallies(llmScores, stemIds, (x) => x.forbidClean)),
    };
    for (const c of ceilingCases) {
      const score = llmScores.get(c.id)!;
      metrics[`ceiling_${c.id}`] = ratio({
        hit: score.entity.hit + score.relRecall.hit,
        total: score.entity.total + score.relRecall.total,
      });
    }
    sampleMetrics.push(metrics);
  }

  const avg = (key: string): number =>
    sampleMetrics.reduce((sum, m) => sum + (m[key] ?? 0), 0) / sampleMetrics.length;

  // Rule-based ceiling scores, computed once (deterministic) for the deltas.
  const ruleScores = await runCorpusThrough(ruleBased, ceilingCases);

  // Ratchet floors — Anthropic backend only, set BELOW the measured baseline
  // (claude-opus-4-8, 2026-07-23, n=3, zero cross-sample variance: entity
  // 0.933, relationship 0.833, safety 1.0/1.0, fallback 0). Raise as quality
  // improves; never lower to make a red run pass. The Ollama backend stays
  // measured-only (threshold 0) until a local baseline exists.
  const gated = backend === 'anthropic';
  const floors = gated
    ? { entity: 0.85, relationship: 0.75, safety: 1, maxFallback: 0.1 }
    : { entity: 0, relationship: 0, safety: 0, maxFallback: 1 };
  const provenanceNote = gated
    ? 'RATCHET (baseline 2026-07-23)'
    : 'MEASURED — set ratchet after first baseline run';

  const deterministicResults = [
    assertGreaterThanOrEqual('extraction_llm_entity_recall', avg('entity_recall'), floors.entity,
      `${provenanceNote} (${model}, n=${samples}): gated-corpus entity recall`),
    assertGreaterThanOrEqual('extraction_llm_relationship_recall', avg('relationship_recall'), floors.relationship,
      `${provenanceNote} (${model}, n=${samples}): gated-corpus relationship recall`),
    (gated ? assertEqual : assertGreaterThanOrEqual)('extraction_llm_negation_safety', avg('negation_safety'), floors.safety,
      `${provenanceNote} (${model}, n=${samples}): negated sentences producing no negation-violating affirmative edge (negation-preserving edges like never_worked_at are OK)`),
    (gated ? assertEqual : assertGreaterThanOrEqual)('extraction_llm_embedded_stem_safety', avg('embedded_stem_safety'), floors.safety,
      `${provenanceNote} (${model}, n=${samples}): embedded-stem sentences producing no fabricated affirmative edge for the embedded verb`),
    assertLessThanOrEqual('extraction_llm_fallback_rate', fallbacks / totalCalls, floors.maxFallback,
      `${gated ? 'RATCHET' : 'MEASURED'}: fraction of calls that silently fell back to RuleBasedExtractor — high values mean the other metrics measured the fallback, not the model`),
    // Cost observability (Anthropic backend only — Ollama is free/local).
    ...(backend === 'anthropic' ? [
      assertGreaterThanOrEqual('extraction_llm_usage_input_tokens', usage.inputTokens, 0,
        `MEASURED: total input tokens across ${totalCalls} calls`),
      assertGreaterThanOrEqual('extraction_llm_usage_output_tokens', usage.outputTokens, 0,
        `MEASURED: total output tokens across ${totalCalls} calls`),
    ] : []),
    // The discriminator: LLM minus rule-based on the constructions the
    // rule-based tier structurally cannot handle. Positive delta = the
    // "LLM-backed extraction for maximum quality" claim, quantified.
    ...ceilingCases.map((c) => {
      const rb = ruleScores.get(c.id)!;
      const rbScore = ratio({
        hit: rb.entity.hit + rb.relRecall.hit,
        total: rb.entity.total + rb.relRecall.total,
      });
      const delta = avg(`ceiling_${c.id}`) - rbScore;
      return assertGreaterThanOrEqual(
        `extraction_llm_vs_rule_${c.id.replace(/-/g, '_')}_delta`,
        delta,
        -1,
        `MEASURED: LLM(${avg(`ceiling_${c.id}`).toFixed(2)}) − rule-based(${rbScore.toFixed(2)}) on this ceiling`,
      );
    }),
  ];

  return { suite: 'memory', zodResults: [], semanticResults: [], deterministicResults };
}
