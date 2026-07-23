/**
 * Extraction Efficacy Track
 *
 * Measures @cycgraph/memory extraction quality against the labeled corpus
 * in extraction-corpus.ts — the adversarial harness the extraction tier
 * never had (every fabricated-data bug in the 2026-07 audit lived there).
 *
 * Gated metrics (ratchet thresholds — raise as quality improves, never
 * lower to pass):
 * - entity_recall / entity_type_accuracy — detection completeness
 * - relationship_recall — expected triples extracted
 * - relationship_precision — fabrication guard: every emitted edge across
 *   gated cases must be an expected one (forbid-case edges are all wrong)
 * - negation_safety / embedded_stem_safety — the audit's regression
 *   classes, gated at 1.0
 *
 * Measured-only metrics (threshold 0 — reported, never failed): the known
 * design ceilings (list constructions, passive voice, all-caps orgs,
 * sentence-start entities). When an extractor improvement lands, these
 * numbers move and say so.
 *
 * A second case runs the composed cross-episode pipeline — extraction →
 * EntityResolver → ConflictDetector — proving contradictions invisible
 * before resolution (disjoint per-episode entity IDs) are found after it.
 *
 * @module suites/memory/extraction-efficacy
 */

import {
  RuleBasedExtractor,
  EntityResolver,
  ConflictDetector,
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
} from '@cycgraph/memory';
import type { Episode, ExtractionResult } from '@cycgraph/memory';
import { assertEqual, assertGreaterThanOrEqual } from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import { EXTRACTION_CORPUS, type ExtractionCase } from './extraction-corpus.js';

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

/** Emitted relationship triples by entity NAME (resolved via result.entities). */
function emittedTriples(result: ExtractionResult): Array<{ source: string; type: string; target: string }> {
  const nameById = new Map(result.entities.map((e) => [e.id, e.name]));
  return result.relationships.map((r) => ({
    source: nameById.get(r.source_id) ?? '?',
    type: r.relation_type,
    target: nameById.get(r.target_id) ?? '?',
  }));
}

function tripleKey(t: { source: string; type: string; target: string }): string {
  return `${t.source} →${t.type}→ ${t.target}`;
}

interface Tally {
  hit: number;
  total: number;
}

const ratio = (t: Tally): number => (t.total === 0 ? 1 : t.hit / t.total);

export async function runExtractionEfficacy(): Promise<TestCaseResults[]> {
  return [await runCorpusMetrics(), await runCrossEpisodePipeline()];
}

async function runCorpusMetrics(): Promise<TestCaseResults> {
  const extractor = new RuleBasedExtractor();
  const startedAt = new Date('2026-01-01T10:00:00Z');

  // Gated tallies
  const entityRecall: Tally = { hit: 0, total: 0 };
  const entityType: Tally = { hit: 0, total: 0 };
  const relRecall: Tally = { hit: 0, total: 0 };
  const relPrecision: Tally = { hit: 0, total: 0 }; // hit = correct emitted, total = all emitted
  const negationSafety: Tally = { hit: 0, total: 0 };
  const stemSafety: Tally = { hit: 0, total: 0 };

  // Measured-only tallies, keyed per ceiling metric
  const ceilings = new Map<string, Tally>();

  for (const c of EXTRACTION_CORPUS) {
    const result = await extractor.extract(makeEpisode(c.text, startedAt));
    const emitted = emittedTriples(result);
    const emittedKeys = new Set(emitted.map(tripleKey));
    const entityNames = new Set(result.entities.map((e) => e.name));
    const typeByName = new Map(result.entities.map((e) => [e.name, e.entity_type]));

    if (!c.gated) {
      // Ceiling case: measure expected-item recall only.
      const tally = ceilings.get(c.id) ?? { hit: 0, total: 0 };
      for (const exp of c.expectEntities ?? []) {
        tally.total++;
        if (entityNames.has(exp.name) && (exp.type === undefined || typeByName.get(exp.name) === exp.type)) {
          tally.hit++;
        }
      }
      for (const exp of c.expectRelationships ?? []) {
        tally.total++;
        if (emittedKeys.has(tripleKey(exp))) tally.hit++;
      }
      ceilings.set(c.id, tally);
      continue;
    }

    // Gated: entities
    for (const exp of c.expectEntities ?? []) {
      entityRecall.total++;
      if (entityNames.has(exp.name)) entityRecall.hit++;
      if (exp.type !== undefined) {
        entityType.total++;
        if (typeByName.get(exp.name) === exp.type) entityType.hit++;
      }
    }

    // Gated: relationships
    if (c.forbidRelationships) {
      const safety = c.category === 'negation' ? negationSafety : stemSafety;
      safety.total++;
      if (emitted.length === 0) safety.hit++;
      // Every emitted edge on a forbid case is a fabrication.
      relPrecision.total += emitted.length;
    } else {
      const expectedKeys = new Set((c.expectRelationships ?? []).map(tripleKey));
      for (const exp of c.expectRelationships ?? []) {
        relRecall.total++;
        if (emittedKeys.has(tripleKey(exp))) relRecall.hit++;
      }
      for (const t of emitted) {
        relPrecision.total++;
        if (expectedKeys.has(tripleKey(t))) relPrecision.hit++;
      }
    }
  }

  const deterministicResults = [
    // Ratchet floors — raise as extraction improves; never lower to pass.
    assertGreaterThanOrEqual('extraction_entity_recall', ratio(entityRecall), 0.9,
      `Expected entities detected (${entityRecall.hit}/${entityRecall.total})`),
    assertGreaterThanOrEqual('extraction_entity_type_accuracy', ratio(entityType), 0.9,
      `Detected entities carry the expected type (${entityType.hit}/${entityType.total})`),
    assertGreaterThanOrEqual('extraction_relationship_recall', ratio(relRecall), 0.9,
      `Expected relationship triples extracted (${relRecall.hit}/${relRecall.total})`),
    assertGreaterThanOrEqual('extraction_relationship_precision', ratio(relPrecision), 0.9,
      `Emitted edges that were expected — fabrication guard (${relPrecision.hit}/${relPrecision.total})`),
    assertEqual('extraction_negation_safety', ratio(negationSafety), 1,
      `Negated sentences producing zero edges (${negationSafety.hit}/${negationSafety.total})`),
    assertEqual('extraction_embedded_stem_safety', ratio(stemSafety), 1,
      `Embedded-verb-stem sentences producing zero edges (${stemSafety.hit}/${stemSafety.total})`),
    // Measured-only ceilings: threshold 0 so they always pass; the value is
    // the point — it documents the design limit as a number.
    ...[...ceilings.entries()].map(([id, tally]) =>
      assertGreaterThanOrEqual(`extraction_${id.replace(/-/g, '_')}`, ratio(tally), 0,
        `MEASURED (not gated): known ceiling — ${tally.hit}/${tally.total} expected items`),
    ),
  ];

  return { suite: 'memory', zodResults: [], semanticResults: [], deterministicResults };
}

/**
 * The composed pipeline: two contradicting episodes months apart. Extraction
 * mints disjoint entity IDs per episode, so conflict detection sees nothing —
 * until EntityResolver merges the duplicates.
 */
async function runCrossEpisodePipeline(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  const extractor = new RuleBasedExtractor();

  const episodes = [
    makeEpisode('Alice Smith works at Acme Corp on the platform team.', new Date('2026-01-15T10:00:00Z')),
    makeEpisode('Alice Smith does not work at Acme Corp anymore these days.', new Date('2026-03-15T10:00:00Z')),
  ];
  for (const ep of episodes) {
    const result = await extractor.extract(ep);
    for (const entity of result.entities) await store.putEntity(entity);
    for (const fact of result.facts) await store.putFact(fact);
    for (const rel of result.relationships) await store.putRelationship(rel);
  }

  const before = await new ConflictDetector(store, index).detectConflicts();
  const report = await new EntityResolver(store).resolve();
  const after = await new ConflictDetector(store, index).detectConflicts();
  const negations = after.filter((c) => c.type === 'negation');

  return {
    suite: 'memory',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('cross_episode_conflicts_before_resolution', before.length, 0,
        'Without entity resolution, cross-episode conflicts are invisible (disjoint entity IDs)'),
      assertEqual('cross_episode_resolver_groups', report.groupsMerged, 2,
        'Resolver merges the duplicated Alice Smith and Acme Corp entities'),
      assertEqual('cross_episode_conflict_recall', negations.length, 1,
        'After resolution, the planted cross-episode negation conflict is found'),
    ],
  };
}
