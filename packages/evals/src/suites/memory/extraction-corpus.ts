/**
 * Extraction Efficacy Corpus
 *
 * Labeled ground truth for measuring @cycgraph/memory's RuleBasedExtractor.
 * Each case is a sentence with expected entities/relationships — or an
 * explicit expectation of NO relationships (negations, embedded verb stems).
 *
 * Two tiers:
 * - `gated: true` — metrics over these cases enforce ratchet thresholds
 *   (raise as quality improves; never lower to make a red build pass).
 *   Includes the adversarial regression classes from the 2026-07 audit:
 *   embedded verb stems ("use" in "because"), negated sentences, and
 *   substring entity suppression.
 * - `gated: false` — known design ceilings (adjacent-pair-only scanning,
 *   passive voice, all-caps org fragmentation, sentence-start suppression).
 *   Measured and reported, never failed: the day an extractor improvement
 *   lands, these numbers move and say so.
 *
 * Growing this corpus is data-only — no harness changes needed.
 *
 * @module suites/memory/extraction-corpus
 */

export interface ExtractionCase {
  id: string;
  text: string;
  /** Gated cases enforce thresholds; measured cases only report. */
  gated: boolean;
  category: 'standard' | 'embedded-stem' | 'negation' | 'entity-edge' | 'ceiling';
  /** Entities that must be detected (type asserted only when given). */
  expectEntities?: Array<{ name: string; type?: string }>;
  /** Relationship triples (by entity name) that should be extracted. */
  expectRelationships?: Array<{ source: string; type: string; target: string }>;
  /** The sentence must produce ZERO relationships (rule-based-tier spec). */
  forbidRelationships?: boolean;
  /**
   * For forbid cases: the canonical verb a fabricated AFFIRMATIVE edge would
   * carry. The LLM tier legitimately emits negation-preserving edges
   * (`never_worked_at`) on these sentences — its violation spec is "an edge
   * stem-matching this verb WITHOUT a negation marker", not "zero edges".
   */
  dangerVerb?: string;
}

export const EXTRACTION_CORPUS: ExtractionCase[] = [
  // ── Standard extraction (gated) ────────────────────────────────
  {
    id: 'std-work-at',
    text: 'Alice Smith works at Acme Corp.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: 'Alice Smith', type: 'person' },
      { name: 'Acme Corp', type: 'organization' },
    ],
    expectRelationships: [{ source: 'Alice Smith', type: 'work_at', target: 'Acme Corp' }],
  },
  {
    id: 'std-manage',
    text: 'Bob Jones manages the Widget Project at Initech Inc.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: 'Bob Jones', type: 'person' },
      { name: 'Widget Project' },
      { name: 'Initech Inc', type: 'organization' },
    ],
    expectRelationships: [{ source: 'Bob Jones', type: 'manage', target: 'Widget Project' }],
  },
  {
    id: 'std-depend-acronym',
    text: 'The API depends on Redis for caching user sessions.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: 'API', type: 'concept' },
      { name: 'Redis', type: 'concept' },
    ],
    expectRelationships: [{ source: 'API', type: 'depend_on', target: 'Redis' }],
  },
  {
    id: 'std-handle-camel',
    text: '@carol deployed the searchIndex service to the production cluster.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: '@carol', type: 'person' },
      { name: 'searchIndex', type: 'concept' },
    ],
    expectRelationships: [{ source: '@carol', type: 'deploy', target: 'searchIndex' }],
  },
  {
    id: 'std-quoted-author',
    text: 'Dana Lee authored the "rollout plan" for the platform migration.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: 'Dana Lee', type: 'person' },
      { name: 'rollout plan', type: 'concept' },
    ],
    expectRelationships: [{ source: 'Dana Lee', type: 'author', target: 'rollout plan' }],
  },
  {
    id: 'std-support',
    text: 'Carol Davis supports the Billing Team during the quarterly audit.',
    gated: true,
    category: 'standard',
    expectEntities: [
      { name: 'Carol Davis', type: 'person' },
      { name: 'Billing Team' },
    ],
    expectRelationships: [{ source: 'Carol Davis', type: 'support', target: 'Billing Team' }],
  },

  // ── Embedded verb stems (gated — 2026-07 regression class) ─────
  // A verb stem appearing only inside an unrelated word must not fabricate
  // an edge: pre-fix, every one of these produced a relationship.
  {
    id: 'stem-because',
    text: 'Alice Smith stayed home because Acme Corp closed early.', // "use" in "because"
    gated: true,
    category: 'embedded-stem',
    forbidRelationships: true,
    dangerVerb: 'use',
  },
  {
    id: 'stem-misleading',
    text: 'Alice Smith was misleading everyone at Acme Corp about payments.', // "lead" in "misleading"
    gated: true,
    category: 'embedded-stem',
    forbidRelationships: true,
    dangerVerb: 'lead',
  },
  {
    id: 'stem-causes',
    text: 'Alice Smith causes friction whenever Acme Corp changes policy.', // "use" in "causes"
    gated: true,
    category: 'embedded-stem',
    forbidRelationships: true,
    dangerVerb: 'use',
  },
  {
    id: 'stem-down',
    text: 'Alice Smith wrote it down before Acme Corp even noticed.', // "own" in "down"
    gated: true,
    category: 'embedded-stem',
    forbidRelationships: true,
    dangerVerb: 'own',
  },

  // ── Negations (gated — 2026-07 regression class) ───────────────
  // An explicitly negated verb must not produce an affirmative edge.
  {
    id: 'neg-never',
    text: 'Alice Smith never worked at Acme Corp.',
    gated: true,
    category: 'negation',
    forbidRelationships: true,
    dangerVerb: 'work_at',
  },
  {
    id: 'neg-does-not',
    text: 'Alice Smith does not manage the Acme Corp platform team.',
    gated: true,
    category: 'negation',
    forbidRelationships: true,
    dangerVerb: 'manage',
  },
  {
    id: 'neg-contraction',
    text: "Alice Smith doesn't use the Acme Corp deployment system.",
    gated: true,
    category: 'negation',
    forbidRelationships: true,
    dangerVerb: 'use',
  },
  {
    id: 'neg-no-longer',
    text: 'Alice Smith no longer works at Acme Corp.',
    gated: true,
    category: 'negation',
    forbidRelationships: true,
    dangerVerb: 'work_at',
  },

  // ── Entity edge cases (gated) ──────────────────────────────────
  {
    id: 'edge-substring-suppression',
    // Pre-fix, substring coverage suppressed "Ann" because "Annual" contains it.
    text: 'The Annual Report praised Ann for outstanding work this quarter.',
    gated: true,
    category: 'entity-edge',
    expectEntities: [
      { name: 'Ann' },
      { name: 'The Annual Report' }, // leading-article absorption is current behavior
    ],
  },

  // ── Known ceilings (measured, NOT gated) ───────────────────────
  {
    id: 'ceil-list-construction',
    // Adjacent-pair-only scanning: only the entity nearest the verb gets the edge.
    text: 'Alice Smith, Bob Jones, and Carol Davis work at Acme Corp.',
    gated: false,
    category: 'ceiling',
    expectRelationships: [
      { source: 'Alice Smith', type: 'work_at', target: 'Acme Corp' },
      { source: 'Bob Jones', type: 'work_at', target: 'Acme Corp' },
      { source: 'Carol Davis', type: 'work_at', target: 'Acme Corp' },
    ],
  },
  {
    id: 'ceil-passive-voice',
    // Passive voice inverts direction; the correct directed edge is missed.
    text: 'The rollout was approved by Dana Lee after the security review.',
    gated: false,
    category: 'ceiling',
    expectRelationships: [{ source: 'Dana Lee', type: 'approve', target: 'The rollout' }],
  },
  {
    id: 'ceil-allcaps-org',
    // Multi-word pattern requires a capitalized-lowercase first token, so
    // all-caps orgs fragment into acronym + suffix concepts.
    text: 'IBM Corp announced record earnings for the third quarter.',
    gated: false,
    category: 'ceiling',
    expectEntities: [{ name: 'IBM Corp', type: 'organization' }],
  },
  {
    id: 'ceil-sentence-start',
    // Single capitalized words at sentence start are deliberately skipped
    // (ordinary sentence-initial words) — named entities there are missed.
    text: 'Alice reviewed the budget for the platform team yesterday.',
    gated: false,
    category: 'ceiling',
    expectEntities: [{ name: 'Alice', type: 'concept' }],
  },
];
