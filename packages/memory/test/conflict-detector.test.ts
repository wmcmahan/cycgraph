import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/store/in-memory-store.js';
import { InMemoryMemoryIndex } from '../src/search/in-memory-index.js';
import { ConflictDetector } from '../src/consolidation/conflict-detector.js';
import type { SemanticFact } from '../src/schemas/semantic.js';
import type { Provenance } from '../src/schemas/provenance.js';

const prov: Provenance = { source: 'system', created_at: new Date() };

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();

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

describe('ConflictDetector', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  // 1. Negation: "Alice works at Acme" vs "Alice no longer works at Acme" → negation conflict
  it('detects negation between affirmative and negative facts', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'Alice no longer works at Acme',
      entity_ids: [ENTITY_A],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const negations = conflicts.filter((c) => c.type === 'negation');
    expect(negations).toHaveLength(1);
    expect(negations[0].confidence).toBe(0.8);
  });

  // 2. Negation: unrelated facts → no conflict
  it('does not detect negation between unrelated facts', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'The weather is sunny today',
      entity_ids: [ENTITY_A],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const negations = conflicts.filter((c) => c.type === 'negation');
    expect(negations).toHaveLength(0);
  });

  // 3. Negation requires shared entity_ids
  it('requires shared entity_ids for negation detection', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'Alice not works at Acme',
      entity_ids: [ENTITY_B],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    expect(conflicts).toHaveLength(0);
  });

  // 4. Supersession: same entity, newer valid_from, similar content → supersession
  it('detects temporal supersession for same-entity similar facts', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(30),
    });
    const f2 = makeFact({
      content: 'Alice works at Beta Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const supersessions = conflicts.filter((c) => c.type === 'supersession');
    expect(supersessions).toHaveLength(1);
    expect(supersessions[0].confidence).toBe(0.9);
  });

  // 5. Supersession: different entities → no conflict
  it('does not detect supersession between facts with different entities', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(30),
    });
    const f2 = makeFact({
      content: 'Bob works at Acme Corp',
      entity_ids: [ENTITY_B],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const supersessions = conflicts.filter((c) => c.type === 'supersession');
    expect(supersessions).toHaveLength(0);
  });

  // 5b. detectConflicts is side-effect-free by DEFAULT (no autoResolve opt-in).
  it('does not mutate the store during detection by default', async () => {
    const f1 = makeFact({ content: 'Alice works at Acme Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(30) });
    const f2 = makeFact({ content: 'Alice works at Beta Corp', entity_ids: [ENTITY_A], valid_from: daysAgo(1) });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    // No autoResolveSupersession set → defaults to false → detection is read-only.
    const detector = new ConflictDetector(store, index);
    const conflicts = await detector.detectConflicts();

    expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(1);
    // Neither fact was invalidated by the mere act of detecting.
    expect((await store.getFact(f1.id))?.invalidated_by).toBeUndefined();
    expect((await store.getFact(f2.id))?.invalidated_by).toBeUndefined();
  });

  // 6. Supersession auto-resolve: older fact gets invalidated
  it('auto-resolves supersession by invalidating the older fact', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(30),
    });
    const f2 = makeFact({
      content: 'Alice works at Beta Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: true });
    await detector.detectConflicts();

    const older = await store.getFact(f1.id);
    expect(older?.invalidated_by).toBe(f2.id);
  });

  // 7. Supersession auto-resolve disabled: conflict returned but not resolved
  it('returns supersession conflict without resolving when auto-resolve is disabled', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(30),
    });
    const f2 = makeFact({
      content: 'Alice works at Beta Corp',
      entity_ids: [ENTITY_A],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    expect(conflicts.filter((c) => c.type === 'supersession')).toHaveLength(1);
    const older = await store.getFact(f1.id);
    expect(older?.invalidated_by).toBeUndefined();
  });

  // 8. Semantic contradiction: high embedding sim + shared entities + low text overlap
  it('detects semantic contradiction with high embedding similarity but low text overlap', async () => {
    const f1 = makeFact({
      content: 'Alice is the CEO',
      entity_ids: [ENTITY_A],
      embedding: [1, 0, 0],
    });
    const f2 = makeFact({
      content: 'Junior intern position held',
      entity_ids: [ENTITY_A],
      embedding: [0.95, 0.3, 0],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, {
      embeddingThreshold: 0.8,
      autoResolveSupersession: false,
    });
    const conflicts = await detector.detectConflicts();

    const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
    expect(contradictions).toHaveLength(1);
    // Short facts (<=4 content words) get high confidence
    expect(contradictions[0].confidence).toBe(0.7);
  });

  // 9. Semantic contradiction: high embedding sim but different entities → no conflict
  it('does not flag semantic contradiction when entities differ', async () => {
    const f1 = makeFact({
      content: 'Alice is the CEO',
      entity_ids: [ENTITY_A],
      embedding: [1, 0, 0],
    });
    const f2 = makeFact({
      content: 'Junior intern position held',
      entity_ids: [ENTITY_B],
      embedding: [0.95, 0.3, 0],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, {
      embeddingThreshold: 0.8,
      autoResolveSupersession: false,
    });
    const conflicts = await detector.detectConflicts();

    const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
    expect(contradictions).toHaveLength(0);
  });

  // 10. No conflicts in clean store
  it('returns empty array for a clean store with no conflicts', async () => {
    const f1 = makeFact({
      content: 'Alice likes cats',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'Bob likes dogs',
      entity_ids: [ENTITY_B],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    expect(conflicts).toHaveLength(0);
  });

  // 11. Already-invalidated facts excluded
  it('excludes already-invalidated facts from conflict detection', async () => {
    const f1 = makeFact({
      content: 'Alice works at Acme',
      entity_ids: [ENTITY_A],
      invalidated_by: 'some-reason',
    });
    const f2 = makeFact({
      content: 'Alice not works at Acme',
      entity_ids: [ENTITY_A],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    expect(conflicts).toHaveLength(0);
  });

  // 12. resolveConflict keep_a: factB invalidated
  it('invalidates factB when resolving with keep_a', async () => {
    const f1 = makeFact({ content: 'A', entity_ids: [ENTITY_A] });
    const f2 = makeFact({ content: 'B', entity_ids: [ENTITY_A] });
    await store.putFact(f1);
    await store.putFact(f2);

    const detector = new ConflictDetector(store, index);
    await detector.resolveConflict(
      { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
      'keep_a',
    );

    const updated = await store.getFact(f2.id);
    expect(updated?.invalidated_by).toBe(f1.id);
    const kept = await store.getFact(f1.id);
    expect(kept?.invalidated_by).toBeUndefined();
  });

  // 13. resolveConflict keep_b: factA invalidated
  it('invalidates factA when resolving with keep_b', async () => {
    const f1 = makeFact({ content: 'A', entity_ids: [ENTITY_A] });
    const f2 = makeFact({ content: 'B', entity_ids: [ENTITY_A] });
    await store.putFact(f1);
    await store.putFact(f2);

    const detector = new ConflictDetector(store, index);
    await detector.resolveConflict(
      { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
      'keep_b',
    );

    const updated = await store.getFact(f1.id);
    expect(updated?.invalidated_by).toBe(f2.id);
    const kept = await store.getFact(f2.id);
    expect(kept?.invalidated_by).toBeUndefined();
  });

  // 14. resolveConflict keep_both: no changes
  it('makes no changes when resolving with keep_both', async () => {
    const f1 = makeFact({ content: 'A', entity_ids: [ENTITY_A] });
    const f2 = makeFact({ content: 'B', entity_ids: [ENTITY_A] });
    await store.putFact(f1);
    await store.putFact(f2);

    const detector = new ConflictDetector(store, index);
    await detector.resolveConflict(
      { factA: f1, factB: f2, type: 'negation', confidence: 0.8 },
      'keep_both',
    );

    const a = await store.getFact(f1.id);
    const b = await store.getFact(f2.id);
    expect(a?.invalidated_by).toBeUndefined();
    expect(b?.invalidated_by).toBeUndefined();
  });

  // 15. Multiple conflicts detected in batch
  it('detects multiple conflicts in a single pass', async () => {
    const entityC = crypto.randomUUID();
    const f1 = makeFact({
      content: 'Alice works at Acme',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'Alice not works at Acme',
      entity_ids: [ENTITY_A],
    });
    const f3 = makeFact({
      content: 'Bob lives in Paris city center',
      entity_ids: [entityC],
      valid_from: daysAgo(30),
    });
    const f4 = makeFact({
      content: 'Bob lives in London city center',
      entity_ids: [entityC],
      valid_from: daysAgo(1),
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await store.putFact(f3);
    await store.putFact(f4);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });

  // 16. Facts without embeddings: skip semantic check (no crash)
  it('handles facts without embeddings gracefully', async () => {
    const f1 = makeFact({
      content: 'Fact without embedding',
      entity_ids: [ENTITY_A],
    });
    const f2 = makeFact({
      content: 'Another fact without embedding',
      entity_ids: [ENTITY_A],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
    expect(contradictions).toHaveLength(0);
  });

  // 17. Supersession with facts <1 day apart: no conflict
  it('does not detect supersession for facts less than 1 day apart', async () => {
    const now = new Date();
    const f1 = makeFact({
      content: 'Alice works at Acme Corp',
      entity_ids: [ENTITY_A],
      valid_from: now,
    });
    const halfDayAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const f2 = makeFact({
      content: 'Alice works at Beta Corp',
      entity_ids: [ENTITY_A],
      valid_from: halfDayAgo,
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
    const conflicts = await detector.detectConflicts();

    const supersessions = conflicts.filter((c) => c.type === 'supersession');
    expect(supersessions).toHaveLength(0);
  });

  // 18. Negation patterns: "doesn't", "isn't", "cannot" all detected
  it('detects various negation patterns', async () => {
    const pairs: [string, string][] = [
      ['Alice likes cats', "Alice doesn't like cats"],
      ['The system is working', "The system isn't working"],
      ['Users can access data', 'Users cannot access data'],
    ];

    for (const [affirmative, negative] of pairs) {
      await store.clear();
      const f1 = makeFact({
        content: affirmative,
        entity_ids: [ENTITY_A],
      });
      const f2 = makeFact({
        content: negative,
        entity_ids: [ENTITY_A],
      });
      await store.putFact(f1);
      await store.putFact(f2);
      await index.rebuild(store);

      const detector = new ConflictDetector(store, index, { autoResolveSupersession: false });
      const conflicts = await detector.detectConflicts();

      const negations = conflicts.filter((c) => c.type === 'negation');
      expect(negations.length, `Expected negation for: "${affirmative}" vs "${negative}"`).toBeGreaterThanOrEqual(1);
    }
  });

  // 19. Semantic contradiction: long complementary facts get low confidence
  it('assigns low confidence to long complementary facts', async () => {
    const f1 = makeFact({
      content: 'Alice is the chief executive officer of Acme Corporation headquartered in New York City',
      entity_ids: [ENTITY_A],
      embedding: [1, 0, 0],
    });
    const f2 = makeFact({
      content: 'Alice earns a salary of one hundred thousand dollars per year at the corporation',
      entity_ids: [ENTITY_A],
      embedding: [0.95, 0.3, 0],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, {
      embeddingThreshold: 0.8,
      autoResolveSupersession: false,
    });
    const conflicts = await detector.detectConflicts();

    const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
    if (contradictions.length > 0) {
      // Long facts should get low confidence
      expect(contradictions[0].confidence).toBeLessThanOrEqual(0.3);
    }
  });

  // 20. semanticOverlapThreshold option is respected
  it('respects custom semanticOverlapThreshold', async () => {
    const f1 = makeFact({
      content: 'Alice is the CEO',
      entity_ids: [ENTITY_A],
      embedding: [1, 0, 0],
    });
    const f2 = makeFact({
      content: 'Junior intern position held',
      entity_ids: [ENTITY_A],
      embedding: [0.95, 0.3, 0],
    });
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    // With a very low threshold, facts with any overlap should not be flagged
    const detector = new ConflictDetector(store, index, {
      embeddingThreshold: 0.8,
      semanticOverlapThreshold: 0.01,
      autoResolveSupersession: false,
    });
    const conflicts = await detector.detectConflicts();

    // These facts have ~0 overlap, so they should still be flagged even at 0.01
    const contradictions = conflicts.filter((c) => c.type === 'semantic_contradiction');
    expect(contradictions).toHaveLength(1);

    // With a threshold of 0 (impossible to be below), nothing is flagged
    await store.clear();
    await store.putFact(f1);
    await store.putFact(f2);
    await index.rebuild(store);

    const detector2 = new ConflictDetector(store, index, {
      embeddingThreshold: 0.8,
      semanticOverlapThreshold: 0,
      autoResolveSupersession: false,
    });
    const conflicts2 = await detector2.detectConflicts();
    const contradictions2 = conflicts2.filter((c) => c.type === 'semantic_contradiction');
    expect(contradictions2).toHaveLength(0);
  });

  it('detects conflicts between facts on different pages of the batch load', async () => {
    const entityId = crypto.randomUUID();
    // Filler facts push the negation pair across a page boundary at batchSize 2.
    await store.putFact(makeFact({ content: 'Unrelated filler fact one' }));
    await store.putFact(makeFact({ content: 'Unrelated filler fact two' }));
    await store.putFact(makeFact({ content: 'Unrelated filler fact three' }));
    await store.putFact(makeFact({
      content: 'Alice is on the platform team',
      entity_ids: [entityId],
      valid_from: new Date('2024-01-01'),
    }));
    await store.putFact(makeFact({
      content: 'Alice is not on the platform team',
      entity_ids: [entityId],
      valid_from: new Date('2024-02-01'),
    }));

    const detector = new ConflictDetector(store, index, { batchSize: 2 });
    const conflicts = await detector.detectConflicts();
    const negations = conflicts.filter((c) => c.type === 'negation');
    expect(negations).toHaveLength(1);
  });
});
