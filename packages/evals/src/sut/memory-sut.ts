/**
 * Memory SUT
 *
 * Wraps `@cycgraph/memory` library APIs to capture deterministic outputs
 * for golden recording. No LLM required — memory operations are pure
 * library calls, so "recording" here just snapshots the library's
 * canonical behavior for a given input.
 *
 * Dispatch is tag-based: each trajectory's `tags` array selects which
 * library path to run. Categories without a handler are reported as
 * unsupported so the recording script can skip them with an explicit
 * reason instead of guessing.
 *
 * @module sut/memory-sut
 */

import { randomUUID } from 'node:crypto';
import {
  SimpleEpisodeSegmenter,
  RuleBasedExtractor,
  filterValid,
  extractSubgraph,
  MemoryConsolidator,
  ConflictDetector,
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
} from '@cycgraph/memory';
import type { Message, SemanticFact, Episode } from '@cycgraph/memory';
import type { GoldenTrajectory } from '../dataset/types.js';
import type { SutRunResult } from './types.js';
import { buildSeededMemoryGraph, FIXTURE_NOW, FIXTURE_PAST } from './fixtures/memory-graph.js';

/** Default "now" used by temporal handlers; matches the seed-golden fixture clock. */
const DEFAULT_NOW = new Date('2026-04-06T12:00:00Z');

/** Default gap threshold for episode segmentation (30 min). */
const DEFAULT_GAP_THRESHOLD_MS = 30 * 60 * 1000;

interface MemoryHandler {
  /** Handler identifier for diff reporting. */
  name: string;
  /** Whether this handler applies to the trajectory's tag set. */
  matches(tags: Set<string>): boolean;
  /** Run the library call against the trajectory's input and return raw output. */
  run(input: string): Promise<unknown>;
}

// ─── Handlers ──────────────────────────────────────────────────────

const segmentationHandler: MemoryHandler = {
  name: 'segmentation',
  matches: (tags) => tags.has('segmentation') || tags.has('episodes'),
  async run(input) {
    const messages = parseMessages(input);
    const segmenter = new SimpleEpisodeSegmenter({
      gapThresholdMs: DEFAULT_GAP_THRESHOLD_MS,
    });
    const episodes = await segmenter.segment(messages);
    return {
      episodes: episodes.length,
      topics: episodes.map(e => e.topic),
      message_counts: episodes.map(e => e.messages.length),
    };
  },
};

const temporalHandler: MemoryHandler = {
  name: 'temporal',
  matches: (tags) => tags.has('temporal') || tags.has('validity'),
  async run(input) {
    const facts = parseFacts(input);
    const filtered = filterValid(facts, {
      validAt: DEFAULT_NOW,
      includeInvalidated: false,
    });
    return {
      filtered_count: filtered.length,
      kept: filtered.map(f => f.content),
    };
  },
};

const extractionHandler: MemoryHandler = {
  name: 'extraction',
  matches: (tags) => tags.has('extraction') || tags.has('rule-based'),
  async run(input) {
    const episode = wrapAsEpisode(input);
    const extractor = new RuleBasedExtractor();
    const result = await extractor.extract(episode);
    return {
      fact_count: result.facts.length,
      facts: result.facts.map(f => f.content),
      entity_count: result.entities?.length ?? 0,
      entities: result.entities?.map(e => ({ name: e.name, type: e.entity_type })) ?? [],
    };
  },
};

const subgraphHandler: MemoryHandler = {
  name: 'subgraph',
  matches: (tags) => tags.has('subgraph') || tags.has('graph'),
  async run(input) {
    const { seed_entities, maxHops, validAt } = parseSubgraphInput(input);
    const { store } = await buildSeededMemoryGraph();
    const result = await extractSubgraph(store, seed_entities, {
      maxHops,
      validAt,
    });

    return {
      entities: result.entities.map(e => e.id),
      entity_names: result.entities.map(e => e.name),
      relationships: result.relationships.map(r => ({
        type: r.relation_type,
        source: r.source_id,
        target: r.target_id,
      })),
      relationship_count: result.relationships.length,
    };
  },
};

const consolidationHandler: MemoryHandler = {
  name: 'consolidation',
  matches: (tags) => tags.has('consolidation') || tags.has('cascade'),
  async run(input) {
    const seed = parseConsolidationInput(input);
    const { store, index } = await prepareConsolidationStore(seed);
    const consolidator = new MemoryConsolidator(store, index, {
      dedupThreshold: 0.9,
    });
    const report = await consolidator.consolidate();

    return {
      factsDeduped: report.factsDeduped,
      factsDecayed: report.factsDecayed,
      episodesPruned: report.episodesPruned,
      totalReclaimed:
        report.factsDeduped + report.factsDecayed + report.episodesPruned,
    };
  },
};

const conflictHandler: MemoryHandler = {
  name: 'conflict',
  matches: (tags) => tags.has('conflict') || tags.has('negation'),
  async run(input) {
    const facts = parseConflictInput(input);
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();
    for (const f of facts) await store.putFact(f);
    await index.rebuild(store);

    const detector = new ConflictDetector(store, index, {
      autoResolveSupersession: false,
    });
    const conflicts = await detector.detectConflicts();

    return {
      conflicts_detected: conflicts.length,
      conflict_types: conflicts.map(c => c.type),
      max_confidence: conflicts.length > 0
        ? Math.max(...conflicts.map(c => c.confidence))
        : 0,
    };
  },
};

const HANDLERS: MemoryHandler[] = [
  segmentationHandler,
  temporalHandler,
  extractionHandler,
  subgraphHandler,
  consolidationHandler,
  conflictHandler,
];

// ─── Input Parsing ─────────────────────────────────────────────────

/** UUID v4 used when synthetic IDs are needed (memory schemas require UUIDs). */
function uuid(): string {
  return randomUUID();
}

function parseMessages(input: string): Message[] {
  const raw = JSON.parse(input) as Array<Record<string, unknown>>;
  return raw.map((m) => ({
    id: isUuid(m.id) ? (m.id as string) : uuid(),
    role: (m.role as Message['role']) ?? 'user',
    content: typeof m.content === 'string' ? m.content : '',
    timestamp: new Date(m.timestamp as string),
    metadata: (m.metadata as Record<string, unknown>) ?? {},
  }));
}

function parseFacts(input: string): SemanticFact[] {
  const raw = JSON.parse(input) as Array<Record<string, unknown>>;
  return raw.map((f) => ({
    id: isUuid(f.id) ? (f.id as string) : uuid(),
    content: typeof f.content === 'string' ? f.content : '',
    source_episode_ids: [],
    entity_ids: [],
    provenance: { source: 'system', created_at: DEFAULT_NOW },
    valid_from: f.valid_from ? new Date(f.valid_from as string) : new Date(0),
    valid_until: f.valid_until ? new Date(f.valid_until as string) : undefined,
    invalidated_by:
      typeof f.invalidated_by === 'string' ? f.invalidated_by : undefined,
    tags: [],
  }));
}

/** Wrap a free-text input as a single-message episode for extraction. */
function wrapAsEpisode(text: string): Episode {
  return {
    id: uuid(),
    topic: 'extraction',
    messages: [
      {
        id: uuid(),
        role: 'user',
        content: text,
        timestamp: DEFAULT_NOW,
        metadata: {},
      },
    ],
    started_at: DEFAULT_NOW,
    ended_at: DEFAULT_NOW,
    fact_ids: [],
    provenance: { source: 'system', created_at: DEFAULT_NOW },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

interface SubgraphInput {
  seed_entities: string[];
  maxHops: number;
  validAt?: Date;
}

function parseSubgraphInput(input: string): SubgraphInput {
  const raw = JSON.parse(input) as Record<string, unknown>;
  const seedEntities = Array.isArray(raw.seed_entities)
    ? raw.seed_entities.filter((x): x is string => typeof x === 'string')
    : [];
  const maxHops = typeof raw.maxHops === 'number' ? raw.maxHops : 1;
  const validAt = raw.validAt ? new Date(raw.validAt as string) : undefined;
  return { seed_entities: seedEntities, maxHops: maxHops, validAt: validAt };
}

interface ConsolidationSeed {
  /** Inline facts with optional embeddings (near-duplicate scenarios). */
  facts?: Array<{ content: string; embedding?: number[] }>;
  /** Inline themes with fact_ids (theme-cascade scenarios). */
  themes?: Array<{ id: string; fact_ids: string[] }>;
  /** Pair of duplicate fact IDs the test wants merged. */
  duplicate_pair?: string[];
  /** Force seeded fixture even if no facts/themes are supplied. */
  use_seeded_graph?: boolean;
}

/**
 * Trajectory consolidation inputs come in two shapes:
 *   - a plain English description (e.g., "Run consolidation on empty memory store")
 *   - a JSON blob with `facts` / `themes` / `duplicate_pair`
 *
 * Empty / non-JSON inputs produce an empty seed → empty store consolidation.
 */
function parseConsolidationInput(input: string): ConsolidationSeed {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as ConsolidationSeed;
    }
  } catch {
    // fall through — non-JSON input means "empty store"
  }
  return {};
}

async function prepareConsolidationStore(
  seed: ConsolidationSeed,
): Promise<{ store: InMemoryMemoryStore; index: InMemoryMemoryIndex }> {
  const store = new InMemoryMemoryStore();
  const index = new InMemoryMemoryIndex();

  // Inline facts get UUIDs synthesized to keep schemas happy when used elsewhere
  if (seed.facts && seed.facts.length > 0) {
    let counter = 0;
    for (const f of seed.facts) {
      const fact: SemanticFact = {
        id: `f-dup-${counter++}`,
        content: f.content,
        source_episode_ids: [],
        entity_ids: [],
        provenance: { source: 'system', created_at: FIXTURE_NOW },
        valid_from: FIXTURE_PAST,
        embedding: f.embedding,
        tags: [],
      };
      await store.putFact(fact);
    }
  }

  if (seed.themes && seed.themes.length > 0) {
    for (const t of seed.themes) {
      await store.putTheme({
        id: t.id,
        label: 'Test theme',
        description: 'consolidation cascade test theme',
        fact_ids: t.fact_ids,
        provenance: { source: 'system', created_at: FIXTURE_NOW },
      });
    }
  }

  await index.rebuild(store);
  return { store, index };
}

function parseConflictInput(input: string): SemanticFact[] {
  const raw = JSON.parse(input) as Record<string, unknown>;
  const facts: SemanticFact[] = [];

  // Two recognized shapes:
  //   { factA: 'content', factB: 'content' }
  //   { factA: { content, valid_from }, factB: { content, valid_from } }
  for (const key of ['factA', 'factB']) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      facts.push({
        id: `f-${key}-${randomUUID()}`,
        content: value,
        source_episode_ids: [],
        entity_ids: [],
        provenance: { source: 'system', created_at: FIXTURE_NOW },
        valid_from: FIXTURE_PAST,
        tags: [],
      });
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      facts.push({
        id: `f-${key}-${randomUUID()}`,
        content: typeof obj.content === 'string' ? obj.content : '',
        source_episode_ids: [],
        entity_ids: [],
        provenance: { source: 'system', created_at: FIXTURE_NOW },
        valid_from: obj.valid_from
          ? new Date(obj.valid_from as string)
          : FIXTURE_PAST,
        valid_until: obj.valid_until
          ? new Date(obj.valid_until as string)
          : undefined,
        tags: [],
      });
    }
  }

  return facts;
}

// ─── Public API ────────────────────────────────────────────────────

export interface RunMemorySutOptions {
  trajectory: GoldenTrajectory;
}

/**
 * Run the memory library against a trajectory's input and capture the
 * observed output. Returns `status: 'failed'` with a descriptive error
 * when no handler matches the trajectory's tags.
 */
export async function runMemorySut(
  opts: RunMemorySutOptions,
): Promise<SutRunResult> {
  const tags = new Set(opts.trajectory.tags ?? []);
  const handler = HANDLERS.find(h => h.matches(tags));

  if (!handler) {
    return {
      output: '',
      toolCalls: [],
      durationMs: 0,
      finalMemory: {},
      status: 'failed',
      error: `No memory handler for tags [${[...tags].join(', ')}]`,
    };
  }

  const start = Date.now();
  try {
    const result = await handler.run(opts.trajectory.input);
    return {
      output: JSON.stringify(result),
      toolCalls: [],
      durationMs: Date.now() - start,
      finalMemory: { handler: handler.name },
      status: 'completed',
    };
  } catch (err) {
    return {
      output: '',
      toolCalls: [],
      durationMs: Date.now() - start,
      finalMemory: { handler: handler.name },
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Exported for the recording script to introspect coverage. */
export function getSupportedMemoryHandlers(): string[] {
  return HANDLERS.map(h => h.name);
}

/** Whether a trajectory has at least one handler in the current build. */
export function isMemoryTrajectorySupported(trajectory: GoldenTrajectory): boolean {
  const tags = new Set(trajectory.tags ?? []);
  return HANDLERS.some(h => h.matches(tags));
}
