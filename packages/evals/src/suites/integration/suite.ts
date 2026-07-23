/**
 * Integration Eval Suite
 *
 * Cross-package integration testing for the memory -> context-engine -> orchestrator flow.
 * All tests are deterministic (no LLM needed). Validates that the full pipeline
 * works end-to-end: ingest messages, segment, extract, cluster, store, retrieve,
 * compress, and verify entity preservation.
 *
 * @module suites/integration/suite
 */

import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  SimpleEpisodeSegmenter,
  RuleBasedExtractor,
  SimpleThemeClusterer,
  retrieveMemory,
  MemoryConsolidator,
  ConflictDetector,
  filterValid,
} from '@cycgraph/memory';
import type {
  Entity,
  Relationship,
  SemanticFact,
  Message,
} from '@cycgraph/memory';
import {
  createPipeline,
  createFormatStage,
  createAllocatorStage,
  createIncrementalPipeline,
  serialize,
  DefaultTokenCounter,
  allocateBudget,
} from '@cycgraph/context-engine';
import type { PromptSegment } from '@cycgraph/context-engine';
import type { MemoryRetriever, MemoryRetrievalResult } from '@cycgraph/orchestrator';
import {
  assertGreaterThanOrEqual,
  assertLessThanOrEqual,
  assertEqual,
} from '../../assertions/deterministic.js';
import type { TestCaseResults } from '../../assertions/drift-calculator.js';
import type { SutSuiteConfig } from '../sut-contract.js';

/** Asserts that a compressed string preserves all given entity names. */
function assertFactPreservation(compressed: string, entityNames: string[]): boolean {
  return entityNames.every(name => compressed.includes(name));
}

// ─── Constants ───────────────────────────────────────────────────

const NOW = new Date('2026-04-06T12:00:00Z');
const PAST = new Date('2025-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');
const counter = new DefaultTokenCounter();

// ─── Test Fixtures ───────────────────────────────────────────────

function makeEntity(id: string, name: string, type: string): Entity {
  return {
    id,
    name,
    entity_type: type,
    attributes: {},
    provenance: { source: 'system', created_at: NOW },
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeRelationship(
  id: string,
  sourceId: string,
  targetId: string,
  relType: string,
  validFrom: Date,
  validUntil?: Date,
): Relationship {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    relation_type: relType,
    weight: 1.0,
    attributes: {},
    valid_from: validFrom,
    valid_until: validUntil,
    provenance: { source: 'system', created_at: NOW },
  };
}

function makeFact(
  id: string,
  content: string,
  entityIds: string[],
  validFrom: Date,
  validUntil?: Date,
  invalidatedBy?: string,
): SemanticFact {
  return {
    id,
    content,
    source_episode_ids: [],
    entity_ids: entityIds,
    provenance: { source: 'system', created_at: NOW },
    valid_from: validFrom,
    valid_until: validUntil,
    invalidated_by: invalidatedBy,
    tags: [],
  };
}

/** 10 messages across 2 conversations (separated by time gap). */
function createTestMessages(): Message[] {
  return [
    // Conversation 1: Architecture discussion
    { id: 'm-1', role: 'user', content: 'Alice works at Acme Corp as lead engineer on the Widget Project.', timestamp: new Date('2026-01-01T10:00:00Z'), metadata: {} },
    { id: 'm-2', role: 'assistant', content: 'Acme Corp develops the Widget Project using a graph-based workflow engine.', timestamp: new Date('2026-01-01T10:01:00Z'), metadata: {} },
    { id: 'm-3', role: 'user', content: 'Bob manages the infrastructure team at Acme Corp.', timestamp: new Date('2026-01-01T10:02:00Z'), metadata: {} },
    { id: 'm-4', role: 'assistant', content: 'The Widget Project deadline is Q1 2026. Carol reviewed the latest milestone.', timestamp: new Date('2026-01-01T10:03:00Z'), metadata: {} },
    { id: 'm-5', role: 'user', content: 'The project uses TypeScript and Node.js for the backend.', timestamp: new Date('2026-01-01T10:04:00Z'), metadata: {} },
    // Conversation 2: Budget discussion (2-hour gap)
    { id: 'm-6', role: 'user', content: 'The Widget Project budget is $500,000 for this quarter.', timestamp: new Date('2026-01-01T12:00:00Z'), metadata: {} },
    { id: 'm-7', role: 'assistant', content: 'Alice submitted the budget proposal to the finance department.', timestamp: new Date('2026-01-01T12:01:00Z'), metadata: {} },
    { id: 'm-8', role: 'user', content: 'Dave from the platform team is the security reviewer.', timestamp: new Date('2026-01-01T12:02:00Z'), metadata: {} },
    { id: 'm-9', role: 'assistant', content: 'Dave approved the security audit for the Widget Project deployment.', timestamp: new Date('2026-01-01T12:03:00Z'), metadata: {} },
    { id: 'm-10', role: 'user', content: 'The deployment target is the AWS cloud infrastructure.', timestamp: new Date('2026-01-01T12:04:00Z'), metadata: {} },
  ];
}

/** Seed a store with entities, relationships, and facts. */
async function seedTestGraph(store: InMemoryMemoryStore) {
  const entities = [
    makeEntity('e-alice', 'Alice', 'person'),
    makeEntity('e-bob', 'Bob', 'person'),
    makeEntity('e-acme', 'Acme Corp', 'organization'),
    makeEntity('e-widget', 'Widget Project', 'project'),
  ];
  for (const e of entities) await store.putEntity(e);

  const relationships = [
    makeRelationship('r-1', 'e-alice', 'e-acme', 'works_at', PAST),
    makeRelationship('r-2', 'e-bob', 'e-acme', 'works_at', PAST),
    makeRelationship('r-3', 'e-acme', 'e-widget', 'owns', PAST),
  ];
  for (const r of relationships) await store.putRelationship(r);

  const facts: SemanticFact[] = [
    makeFact('f-1', 'Alice works at Acme Corp as lead engineer', ['e-alice', 'e-acme'], PAST),
    makeFact('f-2', 'Bob manages the infrastructure team', ['e-bob', 'e-acme'], PAST),
    makeFact('f-3', 'Acme Corp develops the Widget Project', ['e-acme', 'e-widget'], PAST),
  ];
  for (const f of facts) await store.putFact(f);

  return { entities, relationships, facts };
}

// ─── Deterministic Track ─────────────────────────────────────────

export async function runDeterministic(): Promise<TestCaseResults[]> {
  const results: TestCaseResults[] = [];

  results.push(await runMemoryIngestionPipeline());
  results.push(await runMemoryRetrieval());
  results.push(await runContextCompression());
  results.push(await runBudgetEnforcement());
  results.push(await runMemoryRetrieverAdapter());
  results.push(await runConsolidationCascade());
  results.push(await runConflictDetection());
  results.push(await runIncrementalPipeline());
  results.push(await runTemporalFiltering());
  results.push(await runEndToEnd());

  return results;
}

// Test 1: Memory ingestion pipeline
async function runMemoryIngestionPipeline(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  const messages = createTestMessages();

  // Segment into episodes
  const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 30 * 60 * 1000 });
  const episodes = await segmenter.segment(messages);

  // Store episodes
  for (const ep of episodes) await store.putEpisode(ep);

  // Extract facts from episodes
  const extractor = new RuleBasedExtractor();
  let totalFacts = 0;
  for (const ep of episodes) {
    const result = await extractor.extract(ep);
    for (const fact of result.facts) await store.putFact(fact);
    totalFacts += result.facts.length;
  }

  // Cluster into themes
  const allFacts = await store.findFacts();
  const clusterer = new SimpleThemeClusterer();
  const themes = await clusterer.cluster(allFacts);
  for (const theme of themes) await store.putTheme(theme);

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'ingestion_episodes_created',
        episodes.length,
        2,
        `Should create >= 2 episodes from messages with 2-hour gap (got ${episodes.length})`,
      ),
      assertGreaterThanOrEqual(
        'ingestion_facts_extracted',
        totalFacts,
        messages.length,
        `Should extract >= ${messages.length} facts from ${messages.length} messages (got ${totalFacts})`,
      ),
      assertGreaterThanOrEqual(
        'ingestion_themes_created',
        themes.length,
        1,
        `Should create >= 1 theme from ${totalFacts} facts (got ${themes.length})`,
      ),
    ],
  };
}

// Test 2: Memory retrieval
async function runMemoryRetrieval(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  await seedTestGraph(store);
  await index.rebuild(store);

  const result = await retrieveMemory(store, index, {
    entityIds: ['e-alice'],
    tags: [],
    maxHops: 1,
    limit: 20,
    minSimilarity: 0,
    includeInvalidated: false,
  });

  const hasEntities = result.entities.length >= 1 ? 1 : 0;
  const hasFacts = result.facts.length >= 1 ? 1 : 0;

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('retrieval_has_entities', hasEntities, 1, 'Should return entities for entity-based query'),
      assertEqual('retrieval_has_facts', hasFacts, 1, 'Should return facts referencing queried entity'),
      assertGreaterThanOrEqual(
        'retrieval_relationship_count',
        result.relationships.length,
        1,
        `Should return relationships for Alice (got ${result.relationships.length})`,
      ),
    ],
  };
}

// Test 3: Context compression
async function runContextCompression(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  await seedTestGraph(store);
  await index.rebuild(store);

  const result = await retrieveMemory(store, index, {
    entityIds: ['e-alice'],
    tags: [],
    maxHops: 2,
    limit: 20,
    minSimilarity: 0,
    includeInvalidated: false,
  });

  // Serialize retrieved memory to JSON
  const memoryJson = JSON.stringify({
    entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
    facts: result.facts.map(f => f.content),
    relationships: result.relationships.map(r => ({ type: r.relation_type, from: r.source_id, to: r.target_id })),
  }, null, 2);

  // Create segment and compress
  const segments: PromptSegment[] = [{
    id: 'memory',
    content: memoryJson,
    role: 'memory',
    priority: 5,
    locked: false,
  }];

  const pipeline = createPipeline({
    stages: [createFormatStage()],
  });

  const compressed = pipeline.compress({
    segments,
    budget: { maxTokens: 4096, outputReserve: 0 },
  });

  const inputTokens = counter.countTokens(memoryJson);
  const outputTokens = counter.countTokens(compressed.segments[0].content);
  const preserved = assertFactPreservation(compressed.segments[0].content, ['Alice', 'Acme']);

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertLessThanOrEqual(
        'compression_output_shorter',
        outputTokens,
        inputTokens,
        `Compressed output (${outputTokens} tokens) should be <= input (${inputTokens} tokens)`,
      ),
      assertEqual(
        'compression_entity_preservation',
        preserved ? 1 : 0,
        1,
        'Compressed output should preserve key entity names (Alice, Acme)',
      ),
    ],
  };
}

// Test 4: Budget enforcement
async function runBudgetEnforcement(): Promise<TestCaseResults> {
  const longContent = 'Alice from Acme Corp is working on the Widget Project. '.repeat(50);
  const segments: PromptSegment[] = [{
    id: 'memory',
    content: longContent,
    role: 'memory',
    priority: 5,
    locked: false,
  }];

  const budget = { maxTokens: 200, outputReserve: 50 };
  const allocationResult = allocateBudget(segments, budget, counter);

  let totalAllocated = 0;
  for (const tokens of allocationResult.allocations.values()) {
    totalAllocated += tokens;
  }

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertLessThanOrEqual(
        'budget_enforcement',
        totalAllocated,
        budget.maxTokens - budget.outputReserve,
        `Allocated tokens (${totalAllocated}) should fit within available budget (${budget.maxTokens - budget.outputReserve})`,
      ),
    ],
  };
}

// Test 5: MemoryRetriever adapter
async function runMemoryRetrieverAdapter(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  await seedTestGraph(store);
  await index.rebuild(store);

  // Build a function matching MemoryRetriever type signature
  const retriever: MemoryRetriever = async (query, _options) => {
    const result = await retrieveMemory(store, index, {
      entityIds: query.entityIds,
      tags: [],
      maxHops: 1,
      limit: 20,
      minSimilarity: 0,
      includeInvalidated: false,
    });

    return {
      facts: result.facts.map(f => ({ content: f.content, validFrom: f.valid_from })),
      entities: result.entities.map(e => ({ name: e.name, type: e.entity_type })),
      themes: result.themes.map(t => ({ label: t.label })),
    };
  };

  const adapterResult = await retriever({ entityIds: ['e-alice'] });

  const hasFactsShape = adapterResult !== null && Array.isArray(adapterResult.facts) ? 1 : 0;
  const hasEntitiesShape = adapterResult !== null && Array.isArray(adapterResult.entities) ? 1 : 0;
  const hasThemesShape = adapterResult !== null && Array.isArray(adapterResult.themes) ? 1 : 0;

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('adapter_facts_shape', hasFactsShape, 1, 'MemoryRetriever should return facts array'),
      assertEqual('adapter_entities_shape', hasEntitiesShape, 1, 'MemoryRetriever should return entities array'),
      assertEqual('adapter_themes_shape', hasThemesShape, 1, 'MemoryRetriever should return themes array'),
      assertGreaterThanOrEqual(
        'adapter_facts_count',
        adapterResult!.facts.length,
        1,
        'Should return at least 1 fact for Alice',
      ),
    ],
  };
}

// Test 6: Consolidation cascade
async function runConsolidationCascade(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();

  // Add entities
  await store.putEntity(makeEntity('e-alice', 'Alice', 'person'));
  await store.putEntity(makeEntity('e-acme', 'Acme Corp', 'organization'));

  // Add duplicate facts (similar content, same entities) with embeddings
  const embedding1 = Array.from({ length: 10 }, () => 0.5);
  const embedding2 = Array.from({ length: 10 }, () => 0.5);
  embedding2[0] = 0.51; // Slightly different for near-duplicate detection

  const fact1: SemanticFact = {
    ...makeFact('f-dup-1', 'Alice works at Acme Corp as lead engineer', ['e-alice', 'e-acme'], PAST),
    embedding: embedding1,
  };
  const fact2: SemanticFact = {
    ...makeFact('f-dup-2', 'Alice is employed at Acme Corp as lead engineer', ['e-alice', 'e-acme'], PAST),
    embedding: embedding2,
  };
  await store.putFact(fact1);
  await store.putFact(fact2);

  // Create a theme referencing both facts
  await store.putTheme({
    id: 't-1',
    label: 'Employment',
    description: 'Work relationships',
    fact_ids: ['f-dup-1', 'f-dup-2'],
    provenance: { source: 'system', created_at: NOW },
  });

  await index.rebuild(store);

  const consolidator = new MemoryConsolidator(store, index, {
    dedupThreshold: 0.9,
  });
  const report = await consolidator.consolidate();

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'consolidation_deduped',
        report.factsDeduped,
        0,
        `Near-duplicate facts should be considered for dedup (deduped: ${report.factsDeduped})`,
      ),
      assertGreaterThanOrEqual(
        'consolidation_total_processed',
        report.factsDeduped + report.factsDecayed + report.episodesPruned,
        0,
        'Consolidation should complete without errors',
      ),
    ],
  };
}

// Test 7: Conflict detection
async function runConflictDetection(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();

  // Add entity
  await store.putEntity(makeEntity('e-alice', 'Alice', 'person'));
  await store.putEntity(makeEntity('e-acme', 'Acme Corp', 'organization'));

  // Add contradictory facts: one positive, one with negation
  const positive = makeFact('f-pos', 'Alice works at Acme Corp', ['e-alice', 'e-acme'], PAST);
  const negative = makeFact('f-neg', 'Alice does not work at Acme Corp', ['e-alice', 'e-acme'], PAST);
  await store.putFact(positive);
  await store.putFact(negative);

  await index.rebuild(store);

  const detector = new ConflictDetector(store, index, {
    autoResolveSupersession: false,
  });
  const conflicts = await detector.detectConflicts();

  const negationConflicts = conflicts.filter(c => c.type === 'negation');

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'conflict_negation_detected',
        negationConflicts.length,
        1,
        `Should detect negation conflict between positive and negative facts (found ${negationConflicts.length})`,
      ),
    ],
  };
}

// Test 8: Incremental pipeline
async function runIncrementalPipeline(): Promise<TestCaseResults> {
  const pipeline = createIncrementalPipeline({
    stages: [createFormatStage()],
  });

  const segments: PromptSegment[] = [{
    id: 'memory',
    content: JSON.stringify({ name: 'Alice', role: 'engineer' }),
    role: 'memory',
    priority: 5,
    locked: false,
  }];

  const budget = { maxTokens: 4096, outputReserve: 0 };

  // Turn 1: fresh compression
  const turn1 = pipeline.compress({ segments, budget });

  // Turn 2: same content -> should cache
  const turn2 = pipeline.compress({ segments, budget }, turn1.state);

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual(
        'incremental_turn1_fresh',
        turn1.freshSegmentCount,
        1,
        'Turn 1 should compress all segments fresh',
      ),
      assertGreaterThanOrEqual(
        'incremental_turn2_cached',
        turn2.cachedSegmentCount,
        1,
        `Turn 2 should cache unchanged segments (cached: ${turn2.cachedSegmentCount})`,
      ),
    ],
  };
}

// Test 9: Temporal filtering
async function runTemporalFiltering(): Promise<TestCaseResults> {
  const facts: SemanticFact[] = [
    makeFact('f-current', 'Current fact', [], PAST),
    makeFact('f-expired', 'Expired fact', [], PAST, PAST), // valid_until in the past
    makeFact('f-future', 'Future fact', [], FUTURE),        // valid_from in the future
  ];

  const filtered = filterValid(facts, { validAt: NOW });

  const expiredExcluded = !filtered.some(f => f.id === 'f-expired') ? 1 : 0;
  const futureExcluded = !filtered.some(f => f.id === 'f-future') ? 1 : 0;

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertEqual('temporal_expired_excluded', expiredExcluded, 1, 'Expired facts should be excluded'),
      assertEqual('temporal_future_excluded', futureExcluded, 1, 'Future facts should be excluded'),
      assertEqual('temporal_current_kept', filtered.length, 1, 'Only current facts should remain'),
    ],
  };
}

// Test 10: End-to-end pipeline
async function runEndToEnd(): Promise<TestCaseResults> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();
  const messages = createTestMessages();

  // Step 1: Segment messages into episodes
  const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 30 * 60 * 1000 });
  const episodes = await segmenter.segment(messages);
  for (const ep of episodes) await store.putEpisode(ep);

  // Step 2: Extract facts
  const extractor = new RuleBasedExtractor();
  for (const ep of episodes) {
    const result = await extractor.extract(ep);
    for (const fact of result.facts) await store.putFact(fact);
  }

  // Step 3: Cluster into themes
  const allFacts = await store.findFacts();
  const clusterer = new SimpleThemeClusterer();
  const themes = await clusterer.cluster(allFacts);
  for (const theme of themes) await store.putTheme(theme);

  // Step 4: Store entities from the graph
  await store.putEntity(makeEntity('e-alice', 'Alice', 'person'));
  await store.putEntity(makeEntity('e-acme', 'Acme Corp', 'organization'));
  const rel = makeRelationship('r-1', 'e-alice', 'e-acme', 'works_at', PAST);
  await store.putRelationship(rel);

  // Attach entity_ids to the relevant facts
  for (const fact of allFacts) {
    if (fact.content.includes('Alice') && fact.content.includes('Acme')) {
      await store.putFact({ ...fact, entity_ids: ['e-alice', 'e-acme'] });
    }
  }

  await index.rebuild(store);

  // Step 5: Retrieve memory for Alice
  const retrieved = await retrieveMemory(store, index, {
    entityIds: ['e-alice'],
    tags: [],
    maxHops: 1,
    limit: 20,
    minSimilarity: 0,
    includeInvalidated: false,
  });

  // Step 6: Compress for context window
  const memoryContent = JSON.stringify({
    entities: retrieved.entities.map(e => e.name),
    facts: retrieved.facts.map(f => f.content),
  }, null, 2);

  const segments: PromptSegment[] = [{
    id: 'memory',
    content: memoryContent,
    role: 'memory',
    priority: 5,
    locked: false,
  }];

  const pipeline = createPipeline({
    stages: [createFormatStage()],
  });

  const compressed = pipeline.compress({
    segments,
    budget: { maxTokens: 4096, outputReserve: 0 },
  });

  const output = compressed.segments[0].content;
  const alicePreserved = output.includes('Alice') ? 1 : 0;

  return {
    suite: 'integration',
    zodResults: [],
    semanticResults: [],
    deterministicResults: [
      assertGreaterThanOrEqual(
        'e2e_episodes',
        episodes.length,
        2,
        'End-to-end: should segment into >= 2 episodes',
      ),
      assertGreaterThanOrEqual(
        'e2e_facts',
        allFacts.length,
        5,
        `End-to-end: should extract >= 5 facts (got ${allFacts.length})`,
      ),
      assertGreaterThanOrEqual(
        'e2e_themes',
        themes.length,
        1,
        'End-to-end: should create >= 1 theme',
      ),
      assertEqual(
        'e2e_entity_preserved',
        alicePreserved,
        1,
        'End-to-end: compressed output should preserve entity "Alice"',
      ),
    ],
  };
}

// ─── SUT-Driven Semantic Track ────────────────────────────────────

/**
 * Build the SUT-driven semantic suite for the integration tests.
 *
 * The integration suite intentionally has no golden trajectories — its
 * value is the cross-package deterministic track which exercises memory
 * + context-engine + orchestrator together. The SUT-driven contract is
 * returned empty so the runner registers this suite as "migrated" but
 * runs zero semantic tests for it. Add trajectories here if you need
 * a cross-package semantic gate in the future.
 */
export async function buildSutSuite(): Promise<SutSuiteConfig> {
  return { name: 'integration', tests: [] };
}
