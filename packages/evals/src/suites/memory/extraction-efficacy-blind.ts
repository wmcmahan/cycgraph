/**
 * Extraction Efficacy — Implementation-Blind Track
 *
 * Scores an extractor against the frozen natural-text corpus in
 * extraction-corpus-blind.ts. Unlike the authored corpus (a regression
 * fence fitted to the rule-based envelope), these numbers are honest
 * capability measurements: neither tier's implementation informed case
 * selection, and labels are meaning-space acceptance sets rather than any
 * tier's canonical vocabulary.
 *
 * All metrics are MEASURED-ONLY (threshold 0) for both tiers until
 * baselines exist — per measure-first-then-gate, floors get set below
 * observed values, never guessed. Expected shape of the results:
 * rule-based scores well below 1.0 here (that is the honest documentation
 * of the free tier's limits, not a regression), and the rule-vs-LLM gap on
 * THIS corpus is the real tier-gap number.
 *
 * Matching is direction-agnostic and lenient (containment on entity forms,
 * stem overlap on verbs — see extraction-corpus-blind.ts protocol notes).
 * Only labeled assertions are scored; open precision is deliberately not
 * measured (natural text carries defensible edges the labels don't
 * enumerate). Fabrication is covered by the `forbidAffirmative` labels:
 * an affirmative edge the text explicitly negates.
 *
 * @module suites/memory/extraction-efficacy-blind
 */

import type { Episode, ExtractionResult, SemanticExtractor } from '@cycgraph/memory';
import { assertEqual, assertGreaterThanOrEqual } from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import { BLIND_CORPUS, type BlindPassage } from './extraction-corpus-blind.js';
import { relTypeMatches, hasNegationMarker } from './extraction-efficacy-llm.js';

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

/** Lenient surface-form match: containment either way, case-insensitive. */
function formMatches(name: string, forms: string[]): boolean {
  const n = name.toLowerCase();
  return forms.some((f) => {
    const form = f.toLowerCase();
    return n.includes(form) || form.includes(n);
  });
}

/** Any accepted verb stem matches the relation type. */
function verbMatches(verbs: string[], relationType: string): boolean {
  return verbs.some((v) => relTypeMatches(v, relationType));
}

interface Tally { hit: number; total: number }
const ratio = (t: Tally): number => (t.total === 0 ? 1 : t.hit / t.total);

interface BlindScore {
  entityRecall: Tally;
  entityType: Tally;
  relationshipRecall: Tally;
  forbidClean: Tally;
}

/**
 * Relationship entries reference endpoints by one or two of an entity's
 * forms; the entity entries carry the FULL frozen form-set. Resolve each
 * endpoint through the passage's entity entries so an edge naming
 * "Halcyon FC" matches a relationship labeled with the short form
 * "Halcyon". (Scoring semantics only — the labels themselves are frozen.)
 */
function expandForms(forms: string[], passage: BlindPassage): string[] {
  const lower = new Set(forms.map((f) => f.toLowerCase()));
  const expanded = [...forms];
  for (const entity of passage.entities) {
    if (entity.forms.some((f) => lower.has(f.toLowerCase()))) {
      expanded.push(...entity.forms);
    }
  }
  return expanded;
}

function scorePassage(passage: BlindPassage, result: ExtractionResult): BlindScore {
  const score: BlindScore = {
    entityRecall: { hit: 0, total: 0 },
    entityType: { hit: 0, total: 0 },
    relationshipRecall: { hit: 0, total: 0 },
    forbidClean: { hit: 0, total: 0 },
  };

  const names = result.entities.map((e) => e.name);
  const typeByName = new Map(result.entities.map((e) => [e.name, e.entity_type]));
  const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
  const triples = result.relationships.map((r) => ({
    source: nameById.get(r.source_id) ?? '?',
    type: r.relation_type,
    target: nameById.get(r.target_id) ?? '?',
  }));

  for (const expected of passage.entities) {
    score.entityRecall.total++;
    const matched = names.find((n) => formMatches(n, expected.forms));
    if (matched !== undefined) {
      score.entityRecall.hit++;
      if (expected.type !== undefined) {
        score.entityType.total++;
        if (typeByName.get(matched) === expected.type) score.entityType.hit++;
      }
    }
  }

  for (const expected of passage.relationships ?? []) {
    score.relationshipRecall.total++;
    // Direction-agnostic: the assertion is captured if any edge connects the
    // two endpoints with an accepted verb stem, either way around. A FACT
    // whose content pairs the endpoints is not counted — this measures graph
    // edges specifically.
    const aForms = expandForms(expected.a, passage);
    const bForms = expandForms(expected.b, passage);
    const matched = triples.some((t) =>
      verbMatches(expected.verbs, t.type) &&
      ((formMatches(t.source, aForms) && formMatches(t.target, bForms)) ||
       (formMatches(t.source, bForms) && formMatches(t.target, aForms))),
    );
    if (matched) score.relationshipRecall.hit++;
  }

  for (const forbid of passage.forbidAffirmative ?? []) {
    score.forbidClean.total++;
    const aForms = expandForms(forbid.a, passage);
    const bForms = expandForms(forbid.b, passage);
    const violation = triples.some((t) =>
      verbMatches(forbid.verbs, t.type) &&
      !hasNegationMarker(t.type) &&
      ((formMatches(t.source, aForms) && formMatches(t.target, bForms)) ||
       (formMatches(t.source, bForms) && formMatches(t.target, aForms))),
    );
    if (!violation) score.forbidClean.hit++;
  }

  return score;
}

/**
 * Run the blind corpus through any extractor and report measured-only
 * metrics prefixed `extraction_blind_{label}_`.
 */
export interface BlindEfficacyOptions {
  /**
   * Enforce the Anthropic-tier ratchet floors, set below the measured
   * baseline (claude-opus-4-8, 2026-07-23, two runs: entity 1.0/1.0, type
   * 1.0/1.0, relationship 0.80/0.95, safety 1.0/1.0). Floors sit under the
   * observed MINIMUM to absorb sampling variance: entity ≥ 0.9, type ≥ 0.9,
   * relationship ≥ 0.7, safety = 1.0. Raise as quality improves; never
   * lower to pass. Rule-based stays measured-only — its blind numbers are
   * documentation of the free tier's limits, not a regression surface.
   */
  gate?: boolean;
}

export async function runBlindEfficacy(
  extractor: SemanticExtractor,
  label: string,
  options: BlindEfficacyOptions = {},
): Promise<TestCaseResults> {
  const startedAt = new Date('2026-01-01T10:00:00Z');
  const totals: BlindScore = {
    entityRecall: { hit: 0, total: 0 },
    entityType: { hit: 0, total: 0 },
    relationshipRecall: { hit: 0, total: 0 },
    forbidClean: { hit: 0, total: 0 },
  };

  for (const passage of BLIND_CORPUS) {
    const result = await extractor.extract(makeEpisode(passage.text, startedAt));
    const score = scorePassage(passage, result);
    for (const key of ['entityRecall', 'entityType', 'relationshipRecall', 'forbidClean'] as const) {
      totals[key].hit += score[key].hit;
      totals[key].total += score[key].total;
    }
  }

  const gate = options.gate ?? false;
  const floors = gate
    ? { entity: 0.9, type: 0.9, relationship: 0.7 }
    : { entity: 0, type: 0, relationship: 0 };
  const note = gate
    ? 'RATCHET (implementation-blind corpus; floors under the 2026-07-23 baseline minimum)'
    : 'MEASURED (implementation-blind corpus — capability, not regression; gate only after a baseline)';
  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(`extraction_blind_${label}_entity_recall`, ratio(totals.entityRecall), floors.entity,
        `${note}: labeled entities detected (${totals.entityRecall.hit}/${totals.entityRecall.total})`),
      assertGreaterThanOrEqual(`extraction_blind_${label}_entity_type_accuracy`, ratio(totals.entityType), floors.type,
        `${note}: detected entities carrying the labeled type (${totals.entityType.hit}/${totals.entityType.total})`),
      assertGreaterThanOrEqual(`extraction_blind_${label}_relationship_recall`, ratio(totals.relationshipRecall), floors.relationship,
        `${note}: labeled assertions captured as edges, direction-agnostic (${totals.relationshipRecall.hit}/${totals.relationshipRecall.total})`),
      (gate ? assertEqual : assertGreaterThanOrEqual)(`extraction_blind_${label}_negation_safety`, ratio(totals.forbidClean), gate ? 1 : 0,
        `${note}: explicitly-negated assertions with no affirmative edge (${totals.forbidClean.hit}/${totals.forbidClean.total})`),
    ],
  };
}
