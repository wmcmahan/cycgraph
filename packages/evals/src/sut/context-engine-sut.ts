/**
 * Context Engine SUT
 *
 * Wraps `@cycgraph/context-engine` library APIs to capture deterministic
 * outputs for golden recording. No LLM required — every supported
 * operation is a pure library call, so "recording" snapshots the
 * library's canonical behavior for a given input.
 *
 * @module sut/context-engine-sut
 */

import {
  serialize,
  dedup,
  fuzzyDedup,
  allocateBudget,
  createIncrementalPipeline,
  createFormatStage,
  createExactDedupStage,
  createAllocatorStage,
  createAdaptiveMemoryStage,
  createOptimizedPipeline,
  DefaultTokenCounter,
} from '@cycgraph/context-engine';
import type {
  PromptSegment,
  BudgetConfig,
  MemoryPayload,
} from '@cycgraph/context-engine';
import type { GoldenTrajectory } from '../dataset/types.js';
import type { SutRunResult } from './types.js';

const counter = new DefaultTokenCounter();

interface ContextEngineHandler {
  name: string;
  matches(tags: Set<string>): boolean;
  run(input: string): Promise<unknown>;
}

// ─── Handlers ──────────────────────────────────────────────────────

const formatHandler: ContextEngineHandler = {
  name: 'format',
  matches: (tags) => tags.has('format') || tags.has('json'),
  async run(input) {
    const data = JSON.parse(input);
    const compressed = serialize(data);
    return {
      compressed,
      input_tokens: counter.countTokens(input),
      output_tokens: counter.countTokens(compressed),
    };
  },
};

const exactDedupHandler: ContextEngineHandler = {
  name: 'exact-dedup',
  matches: (tags) => tags.has('dedup') && tags.has('exact') && !tags.has('fuzzy'),
  async run(input) {
    const items = input.split('\n').filter(Boolean);
    const result = dedup(items);
    return {
      unique: result.unique,
      removed: result.removed,
      kept_count: result.unique.length,
    };
  },
};

const fuzzyDedupHandler: ContextEngineHandler = {
  name: 'fuzzy-dedup',
  matches: (tags) => tags.has('dedup') && tags.has('fuzzy'),
  async run(input) {
    const items = input.split('\n').filter(Boolean);
    const result = fuzzyDedup(items, { threshold: 0.8 });
    return {
      unique: result.unique,
      removed: result.removed,
      kept_count: result.unique.length,
    };
  },
};

const budgetHandler: ContextEngineHandler = {
  name: 'budget',
  matches: (tags) => tags.has('priority') || tags.has('budget'),
  async run(input) {
    const segments = parseSegmentsFromBudgetInput(input);
    const budget: BudgetConfig = { maxTokens: 200, outputReserve: 50 };
    const result = allocateBudget(segments, budget, counter);

    const allocations: Record<string, number> = {};
    let total = 0;
    for (const [id, tokens] of result.allocations.entries()) {
      allocations[id] = tokens;
      total += tokens;
    }

    return {
      allocations,
      total_allocated: total,
      max_available: budget.maxTokens - (budget.outputReserve ?? 0),
      overflow_count: result.overflow.length,
    };
  },
};

const incrementalCacheHandler: ContextEngineHandler = {
  name: 'incremental-cache',
  matches: (tags) => tags.has('incremental') || tags.has('cache'),
  async run(input) {
    const { turn1, turn2 } = parseTurnPair(input);
    const pipeline = createIncrementalPipeline({
      stages: [createFormatStage()],
    });
    const budget: BudgetConfig = { maxTokens: 4096, outputReserve: 0 };

    const t1 = pipeline.compress({
      segments: makeMemorySegments(turn1),
      budget,
    });
    const t2 = pipeline.compress(
      { segments: makeMemorySegments(turn2), budget },
      t1.state,
    );

    return {
      turn1: {
        fresh: t1.freshSegmentCount,
        cached: t1.cachedSegmentCount,
      },
      turn2: {
        fresh: t2.freshSegmentCount,
        cached: t2.cachedSegmentCount,
      },
    };
  },
};

const adaptiveMemoryHandler: ContextEngineHandler = {
  name: 'adaptive-memory',
  matches: (tags) => tags.has('adaptive') || (tags.has('memory') && !tags.has('budget')),
  async run(input) {
    const payload = parseMemoryPayload(input);
    const stage = createAdaptiveMemoryStage();

    // The adaptive stage parses the segment content as a MemoryPayload, so we
    // pass the payload via the segment body rather than via constructor opts.
    const segments: PromptSegment[] = [{
      id: 'memory',
      content: JSON.stringify(payload),
      role: 'memory',
      priority: 5,
      locked: false,
    }];
    const result = stage.execute(segments, {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 },
    });

    const output = result.segments[0]?.content ?? '';
    return {
      output_chars: output.length,
      output_tokens: counter.countTokens(output),
      contains_themes: (payload.themes?.length ?? 0) > 0,
      contains_facts: (payload.facts?.length ?? 0) > 0,
    };
  },
};

const pipelineHandler: ContextEngineHandler = {
  name: 'pipeline',
  matches: (tags) => tags.has('pipeline') || tags.has('multi-stage'),
  async run(input) {
    const pipeline = createOptimizedPipeline({
      preset: 'balanced',
    });
    const { stageNames } = pipeline;

    const segments: PromptSegment[] = [{
      id: 'memory',
      content: input,
      role: 'memory',
      priority: 5,
      locked: false,
    }];

    const result = pipeline.compress({
      segments,
      budget: { maxTokens: 4096, outputReserve: 0 },
    });

    const outputContent = result.segments[0]?.content ?? '';
    return {
      stages: stageNames,
      stage_count: stageNames.length,
      input_tokens: result.metrics.totalTokensIn,
      output_tokens: result.metrics.totalTokensOut,
      reduction_percent: result.metrics.totalTokensIn > 0
        ? Math.round(
            ((result.metrics.totalTokensIn - result.metrics.totalTokensOut) /
              result.metrics.totalTokensIn) * 1000,
          ) / 10
        : 0,
      preserved_first_chars: outputContent.slice(0, 80),
    };
  },
};

const HANDLERS: ContextEngineHandler[] = [
  formatHandler,
  // Order matters: fuzzy match before exact so the fuzzy-tagged trajectories
  // route to the right handler.
  fuzzyDedupHandler,
  exactDedupHandler,
  budgetHandler,
  incrementalCacheHandler,
  adaptiveMemoryHandler,
  pipelineHandler,
];

// ─── Input Parsing ─────────────────────────────────────────────────

interface TurnPair {
  turn1: string;
  turn2: string;
}

/**
 * Incremental-cache trajectory inputs are JSON objects with `turn1` /
 * `turn2` string values. Falls back to splitting the input on `\n\n` if
 * a JSON object isn't provided.
 */
function parseTurnPair(input: string): TurnPair {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      return {
        turn1: typeof obj.turn1 === 'string' ? obj.turn1 : '',
        turn2: typeof obj.turn2 === 'string' ? obj.turn2 : '',
      };
    }
  } catch {
    // fall through
  }
  const parts = input.split('\n\n');
  return { turn1: parts[0] ?? '', turn2: parts[1] ?? parts[0] ?? '' };
}

function makeMemorySegments(content: string): PromptSegment[] {
  return [{
    id: 'mem',
    content,
    role: 'memory',
    priority: 5,
    locked: false,
  }];
}

/**
 * Adaptive-memory trajectory inputs are JSON `MemoryPayload` objects with
 * `themes` / `facts` / `episodes` arrays. Empty/missing arrays default to
 * an empty payload.
 */
function parseMemoryPayload(input: string): MemoryPayload {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      return {
        themes: Array.isArray(obj.themes) ? (obj.themes as MemoryPayload['themes']) : [],
        facts: Array.isArray(obj.facts) ? coerceFactsForPayload(obj.facts) : [],
        episodes: Array.isArray(obj.episodes)
          ? (obj.episodes as MemoryPayload['episodes'])
          : [],
      };
    }
  } catch {
    // fall through
  }
  return { themes: [], facts: [], episodes: [] };
}

/**
 * Trajectory facts arrive with `valid_from` as ISO strings; the
 * MemoryPayload `facts` field expects Date objects. Coerce here to keep
 * the rest of the pipeline well-typed.
 */
function coerceFactsForPayload(raw: unknown[]): MemoryPayload['facts'] {
  return raw.map((entry) => {
    const f = entry as Record<string, unknown>;
    return {
      id: typeof f.id === 'string' ? f.id : '',
      content: typeof f.content === 'string' ? f.content : '',
      source_episode_ids: Array.isArray(f.source_episode_ids)
        ? (f.source_episode_ids as string[])
        : [],
      entity_ids: Array.isArray(f.entity_ids) ? (f.entity_ids as string[]) : [],
      theme_id: typeof f.theme_id === 'string' ? f.theme_id : undefined,
      valid_from: f.valid_from
        ? new Date(f.valid_from as string)
        : new Date(0),
      valid_until: f.valid_until ? new Date(f.valid_until as string) : undefined,
    };
  }) as MemoryPayload['facts'];
}

/**
 * Budget trajectory inputs are JSON objects whose keys become segment IDs.
 * Each value becomes the segment content. Segments roled `system` or
 * `tools` are marked locked; everything else is mutable memory.
 */
function parseSegmentsFromBudgetInput(input: string): PromptSegment[] {
  const obj = JSON.parse(input) as Record<string, unknown>;
  const segments: PromptSegment[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    const role: PromptSegment['role'] =
      key === 'system' ? 'system' : key === 'tools' ? 'tools' : 'memory';
    segments.push({
      id: key,
      content,
      role,
      priority: role === 'system' ? 10 : role === 'tools' ? 8 : 5,
      locked: role === 'system' || role === 'tools' || key === 'locked',
    });
  }

  return segments;
}

// ─── Public API ────────────────────────────────────────────────────

export interface RunContextEngineSutOptions {
  trajectory: GoldenTrajectory;
}

/**
 * Run the context-engine library against a trajectory's input and capture
 * the observed output. Returns `status: 'failed'` with a descriptive error
 * when no handler matches the trajectory's tags.
 */
export async function runContextEngineSut(
  opts: RunContextEngineSutOptions,
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
      error: `No context-engine handler for tags [${[...tags].join(', ')}]`,
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
export function getSupportedContextEngineHandlers(): string[] {
  return HANDLERS.map(h => h.name);
}

/** Whether a trajectory has at least one handler in the current build. */
export function isContextEngineTrajectorySupported(
  trajectory: GoldenTrajectory,
): boolean {
  const tags = new Set(trajectory.tags ?? []);
  return HANDLERS.some(h => h.matches(tags));
}
