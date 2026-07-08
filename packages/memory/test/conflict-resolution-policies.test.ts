import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { ConflictDetector } from '../src/consolidation/conflict-detector.js';
import type { Conflict } from '../src/consolidation/conflict-detector.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Provenance } from '../src/schemas/provenance.js';

const prov: Provenance = { source: 'system', created_at: new Date() };

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

const ENTITY_A = crypto.randomUUID();

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Test fact',
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: new Date(),
    ...overrides,
  };
}

describe('Conflict Resolution Policies', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  // 1. supersede-on-newer with negation conflict: older fact invalidated
  it('supersede-on-newer invalidates older fact in negation conflict', async () => {
    const older = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const newer = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'negation', confidence: 0.8 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'supersede-on-newer');

    expect(report.resolved).toBe(1);
    const olderFact = await store.getFact(older.id);
    expect(olderFact?.invalidated_by).toBe(newer.id);
  });

  // 2. supersede-on-newer with supersession conflict: older fact invalidated
  it('supersede-on-newer invalidates older fact in supersession conflict', async () => {
    const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(30) });
    const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'supersession', confidence: 0.9 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'supersede-on-newer');

    expect(report.resolved).toBe(1);
    const olderFact = await store.getFact(older.id);
    expect(olderFact?.invalidated_by).toBe(newer.id);
  });

  // 3. supersede-on-newer with semantic_contradiction: older fact invalidated
  it('supersede-on-newer invalidates older fact in semantic contradiction', async () => {
    const older = makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A], valid_from: daysAgo(20) });
    const newer = makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'semantic_contradiction', confidence: 0.6 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'supersede-on-newer');

    expect(report.resolved).toBe(1);
    const olderFact = await store.getFact(older.id);
    expect(olderFact?.invalidated_by).toBe(newer.id);
  });

  // 4. negation-invalidates-positive: positive fact (without negation) invalidated, negation fact kept
  it('negation-invalidates-positive keeps negation fact and invalidates positive', async () => {
    const positive = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const negative = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(positive);
    await store.putFact(negative);

    const conflict: Conflict = { factA: positive, factB: negative, type: 'negation', confidence: 0.8 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'negation-invalidates-positive');

    expect(report.resolved).toBe(1);
    const positiveFact = await store.getFact(positive.id);
    expect(positiveFact?.invalidated_by).toBe(negative.id);
    const negativeFact = await store.getFact(negative.id);
    expect(negativeFact?.invalidated_by).toBeUndefined();
  });

  // 4b. A NEWER positive correction survives a STALE negation (poisoning guard):
  // "X is not safe" (old) must not invalidate a later "X is safe" (new).
  it('negation-invalidates-positive: newer positive correction beats a stale negation', async () => {
    const staleNegation = makeFact({ content: 'Endpoint is not safe to call', entity_ids: [ENTITY_A], valid_from: daysAgo(30) });
    const newerPositive = makeFact({ content: 'Endpoint is safe to call', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(staleNegation);
    await store.putFact(newerPositive);

    const conflict: Conflict = { factA: staleNegation, factB: newerPositive, type: 'negation', confidence: 0.8 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'negation-invalidates-positive');

    expect(report.resolved).toBe(1);
    // The newer positive correction survives; the stale negation is invalidated.
    expect((await store.getFact(newerPositive.id))?.invalidated_by).toBeUndefined();
    expect((await store.getFact(staleNegation.id))?.invalidated_by).toBe(newerPositive.id);
  });

  // 5. negation-invalidates-positive with supersession: uses temporal order (newer kept)
  it('negation-invalidates-positive uses temporal order for supersession', async () => {
    const older = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(30) });
    const newer = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'supersession', confidence: 0.9 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'negation-invalidates-positive');

    expect(report.resolved).toBe(1);
    const olderFact = await store.getFact(older.id);
    expect(olderFact?.invalidated_by).toBe(newer.id);
  });

  // 6. negation-invalidates-positive with semantic_contradiction: skipped
  it('negation-invalidates-positive skips semantic contradictions', async () => {
    const f1 = makeFact({ content: 'Alice is the CEO', entity_ids: [ENTITY_A] });
    const f2 = makeFact({ content: 'Junior intern position held', entity_ids: [ENTITY_A] });
    await store.putFact(f1);
    await store.putFact(f2);

    const conflict: Conflict = { factA: f1, factB: f2, type: 'semantic_contradiction', confidence: 0.6 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'negation-invalidates-positive');

    expect(report.skipped).toBe(1);
    expect(report.resolved).toBe(0);
    expect(report.details[0].action).toBe('requires manual review');
  });

  // 7. manual-review: all conflicts skipped
  it('manual-review skips all conflicts', async () => {
    const f1 = makeFact({ content: 'Alice works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const f2 = makeFact({ content: 'Alice no longer works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(f1);
    await store.putFact(f2);

    const conflicts: Conflict[] = [
      { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
      { factA: f1, factB: f2, type: 'supersession', confidence: 0.9 },
    ];
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll(conflicts, 'manual-review');

    expect(report.skipped).toBe(2);
    expect(report.resolved).toBe(0);
  });

  // 8. Resolution report has correct resolved/skipped counts
  it('reports correct resolved and skipped counts for mixed conflicts', async () => {
    const f1 = makeFact({ content: 'A works here', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const f2 = makeFact({ content: 'A no longer works here', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    const f3 = makeFact({ content: 'A is CEO', entity_ids: [ENTITY_A] });
    const f4 = makeFact({ content: 'Junior intern', entity_ids: [ENTITY_A] });
    await store.putFact(f1);
    await store.putFact(f2);
    await store.putFact(f3);
    await store.putFact(f4);

    const conflicts: Conflict[] = [
      { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
      { factA: f3, factB: f4, type: 'semantic_contradiction', confidence: 0.6 },
    ];
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll(conflicts, 'negation-invalidates-positive');

    expect(report.resolved).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.details).toHaveLength(2);
  });

  // 9. Empty conflict list -> report with 0/0
  it('returns zero counts for empty conflict list', async () => {
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([], 'supersede-on-newer');

    expect(report.resolved).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.details).toHaveLength(0);
  });

  // 10. Same valid_from: tiebreak by ID (lexicographic smaller kept)
  it('tiebreaks by lexicographic ID when valid_from is the same', async () => {
    const timestamp = new Date();
    const f1 = makeFact({ content: 'Fact one', entity_ids: [ENTITY_A], valid_from: timestamp });
    const f2 = makeFact({ content: 'Fact two', entity_ids: [ENTITY_A], valid_from: timestamp });
    await store.putFact(f1);
    await store.putFact(f2);

    const conflict: Conflict = { factA: f1, factB: f2, type: 'supersession', confidence: 0.9 };
    const detector = new ConflictDetector(store, index);
    const report = await detector.autoResolveAll([conflict], 'supersede-on-newer');

    expect(report.resolved).toBe(1);

    // The lexicographically smaller ID should be kept
    const smallerId = f1.id < f2.id ? f1.id : f2.id;
    const largerId = f1.id < f2.id ? f2.id : f1.id;

    const kept = await store.getFact(smallerId);
    expect(kept?.invalidated_by).toBeUndefined();
    const invalidated = await store.getFact(largerId);
    expect(invalidated?.invalidated_by).toBe(smallerId);
  });

  // 11. Policy from options used when not passed to autoResolveAll
  it('uses policy from constructor options when not passed to autoResolveAll', async () => {
    const older = makeFact({ content: 'A works at Acme', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const newer = makeFact({ content: 'A works at Beta', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'supersession', confidence: 0.9 };
    const detector = new ConflictDetector(store, index, { policy: 'supersede-on-newer' });
    const report = await detector.autoResolveAll([conflict]);

    expect(report.resolved).toBe(1);
    const olderFact = await store.getFact(older.id);
    expect(olderFact?.invalidated_by).toBe(newer.id);
  });

  // 12. Details array has correct action descriptions
  it('includes correct action descriptions in details', async () => {
    const older = makeFact({ content: 'A works here', entity_ids: [ENTITY_A], valid_from: daysAgo(10) });
    const newer = makeFact({ content: 'A no longer works here', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(older);
    await store.putFact(newer);

    const conflict: Conflict = { factA: older, factB: newer, type: 'negation', confidence: 0.8 };
    const detector = new ConflictDetector(store, index);

    // Test supersede-on-newer action description
    const report1 = await detector.autoResolveAll([conflict], 'supersede-on-newer');
    expect(report1.details[0].action).toContain('newer fact kept');

    // Reset the fact state
    await store.putFact(older); // restore

    // Test manual-review action description
    const report2 = await detector.autoResolveAll([conflict], 'manual-review');
    expect(report2.details[0].action).toContain('manual review');

    // Restore and test negation-invalidates-positive action. The negation here
    // ("no longer works") is the NEWER fact, so it wins on recency — the action
    // now reports the actual reason (recency), not a blanket "negation kept".
    await store.putFact(older); // restore
    const report3 = await detector.autoResolveAll([conflict], 'negation-invalidates-positive');
    expect(report3.details[0].action).toContain('newer fact kept');
    // And the positive (older) fact is the one invalidated.
    const invalidated = await store.getFact(older.id);
    expect(invalidated?.invalidated_by).toBe(newer.id);
  });
});
