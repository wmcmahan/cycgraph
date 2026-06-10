/**
 * Reflection Executor
 *
 * Compound-systems primitive that closes the learning loop: after
 * productive work in a graph, this node distills the run's output into
 * atomic facts and persists them via the injected `MemoryWriter`. Future
 * runs retrieve those facts (filtered by tags) through `memoryRetriever`,
 * so agents compound knowledge across runs.
 *
 * Two extractor variants:
 *
 *   - `rule_based` — deterministic sentence-level extraction. Splits the
 *     concatenated source memory values into sentences, filters by
 *     `min_sentence_length`, dedupes (normalised), and emits one fact per
 *     unique sentence. No LLM call — free and predictable. Intentionally
 *     simpler than `@cycgraph/memory`'s `RuleBasedExtractor` because the
 *     orchestrator does not depend on the memory package; richer
 *     extraction belongs in the `llm` variant or a user-supplied
 *     `MemoryWriter` that post-processes.
 *   - `llm`        — uses the {@link extractFactsExecutor} primitive to
 *     ask an LLM to distill lessons from the source memory values. The
 *     LLM returns up to `max_facts` atomic sentences; the executor
 *     persists them with `provenance.source === 'agent'`.
 *
 * Outcomes are written as a {@link ReflectionResult} envelope to
 * `result_key` (default `{node.id}_reflection`).
 *
 * @module runner/node-executors/reflection
 */

import { v4 as uuidv4 } from 'uuid';

import type { GraphNode, ReflectionConfig } from '../../types/graph.js';
import type { Action, StateView } from '../../types/state.js';
import type { MemoryWriter, MemoryWriterFact } from '../../agent/memory-writer.js';
import { createLogger } from '../../utils/logger.js';
import { sanitizeString } from '../../agent/agent-executor/sanitizers.js';
import { NodeConfigError } from '../errors.js';
import type { NodeExecutorContext } from './context.js';

const logger = createLogger('runner.node.reflection');

/**
 * Execute a reflection node.
 *
 * @param node - Reflection node with `reflection_config`.
 * @param stateView - Filtered state view (must include every `source_keys` entry in `read_keys`).
 * @param attempt - Retry attempt number.
 * @param ctx - Executor context — must carry `memoryWriter` injected via GraphRunnerOptions.
 * @returns `update_memory` action carrying the {@link ReflectionResult}.
 * @throws {NodeConfigError} If `reflection_config` is missing.
 * @throws {MemoryWriterMissingError} If no `memoryWriter` was injected on the runner.
 */
export async function executeReflectionNode(
  node: GraphNode,
  stateView: StateView,
  attempt: number,
  ctx: NodeExecutorContext,
): Promise<Action> {
  const config = node.reflection_config;
  if (!config) {
    throw new NodeConfigError(node.id, 'reflection', 'reflection_config');
  }

  if (!ctx.memoryWriter) {
    throw new MemoryWriterMissingError(node.id);
  }

  logger.info('reflection_executing', {
    node_id: node.id,
    variant: config.extractor.type,
    source_keys: config.source_keys,
  });

  let factIds: string[] = [];
  let tokensUsed = 0;
  switch (config.extractor.type) {
    case 'rule_based': {
      factIds = await extractRuleBased(node, config, stateView, ctx.memoryWriter, ctx);
      break;
    }
    case 'llm': {
      const outcome = await extractViaLLM(node, config, stateView, ctx.memoryWriter, ctx);
      factIds = outcome.factIds;
      tokensUsed = outcome.tokensUsed;
      break;
    }
  }

  logger.info('reflection_complete', {
    node_id: node.id,
    variant: config.extractor.type,
    facts_written: factIds.length,
    tokens_used: tokensUsed,
  });

  return buildReflectionAction(node, config, factIds, attempt, ctx, tokensUsed);
}

// ─── rule_based extractor ───────────────────────────────────────────

/**
 * Deterministic sentence-level extraction. Concatenates the configured
 * source memory values into one corpus, splits into sentences, applies
 * the min-length filter, dedupes, and emits one fact per unique sentence.
 *
 * No LLM call. No entity-pattern detection — that lives in the `llm`
 * extractor or in user-supplied `MemoryWriter` implementations that can
 * post-process. Entity *references* (from `entity_keys`) are still
 * attached to each fact so the knowledge graph stays connected.
 */
async function extractRuleBased(
  node: GraphNode,
  config: ReflectionConfig,
  stateView: StateView,
  writer: MemoryWriter,
  ctx: NodeExecutorContext,
): Promise<string[]> {
  if (config.extractor.type !== 'rule_based') {
    // Narrowing — should never happen given the call site, but keeps TS happy.
    throw new Error(`extractRuleBased called with wrong extractor type: ${config.extractor.type}`);
  }
  const minLength = config.extractor.min_sentence_length;

  const corpus = concatSourceValues(config.source_keys, stateView.memory);
  const sentences = splitSentences(corpus)
    .map((s) => s.trim())
    .filter((s) => s.length >= minLength);

  const unique = dedupeNormalised(sentences);

  if (unique.length === 0) {
    logger.info('reflection_no_facts_extracted', {
      node_id: node.id,
      source_keys: config.source_keys,
      corpus_length: corpus.length,
    });
    return [];
  }

  const entities = collectEntityRefs(config.entity_keys, stateView.memory);
  const provenance = {
    workflow_id: stateView.workflow_id,
    run_id: stateView.run_id,
    graph_id: ctx.graph.id,
    node_id: node.id,
    source: 'derived' as const,
  };

  const facts: MemoryWriterFact[] = unique.map((content) => ({
    content: sanitizeFactContent(content),
    tags: config.tags,
    entities,
    provenance,
  }));

  const sanitized = await applySanitizer(facts, node.id, ctx);
  if (sanitized.length === 0) return [];

  const result = await writer(sanitized, {
    idempotency_key: writeIdempotencyKey(node, stateView, ctx),
  });
  return result.fact_ids;
}

// ─── llm extractor ──────────────────────────────────────────────────

interface LLMExtractionOutcome {
  factIds: string[];
  tokensUsed: number;
}

/**
 * LLM-driven extraction. Calls {@link extractFactsExecutor} with the
 * configured agent_id and instruction, then converts the returned
 * sentences into `MemoryWriterFact[]` with `provenance.source === 'agent'`
 * and persists them.
 */
async function extractViaLLM(
  node: GraphNode,
  config: ReflectionConfig,
  stateView: StateView,
  writer: MemoryWriter,
  ctx: NodeExecutorContext,
): Promise<LLMExtractionOutcome> {
  if (config.extractor.type !== 'llm') {
    throw new Error(`extractViaLLM called with wrong extractor type: ${config.extractor.type}`);
  }
  const { agent_id, instruction, max_facts } = config.extractor;

  const corpus = concatSourceValues(config.source_keys, stateView.memory);
  if (corpus.trim().length === 0) {
    logger.info('reflection_no_source', {
      node_id: node.id,
      source_keys: config.source_keys,
    });
    return { factIds: [], tokensUsed: 0 };
  }

  const extraction = await ctx.deps.extractFactsExecutor(
    agent_id,
    corpus,
    max_facts,
    instruction,
  );

  if (extraction.facts.length === 0) {
    return { factIds: [], tokensUsed: extraction.tokens_used };
  }

  const entities = collectEntityRefs(config.entity_keys, stateView.memory);
  const provenance = {
    workflow_id: stateView.workflow_id,
    run_id: stateView.run_id,
    graph_id: ctx.graph.id,
    node_id: node.id,
    source: 'agent' as const,
  };

  const facts: MemoryWriterFact[] = extraction.facts.map((content) => ({
    content: sanitizeFactContent(content),
    tags: config.tags,
    entities,
    provenance,
  }));

  const sanitized = await applySanitizer(facts, node.id, ctx);
  if (sanitized.length === 0) {
    return { factIds: [], tokensUsed: extraction.tokens_used };
  }

  const result = await writer(sanitized, {
    idempotency_key: writeIdempotencyKey(node, stateView, ctx),
  });
  return { factIds: result.fact_ids, tokensUsed: extraction.tokens_used };
}

/**
 * Deduplication scope for a reflection write: one node execution = one key.
 * Deliberately excludes the retry attempt — a retry of the same execution
 * must dedupe against the first attempt's (possibly successful) write, or
 * every retry permanently duplicates facts in long-term memory.
 */
function writeIdempotencyKey(
  node: GraphNode,
  stateView: StateView,
  ctx: NodeExecutorContext,
): string {
  return `${stateView.run_id}:${node.id}:${ctx.state.iteration_count}`;
}

/**
 * Apply the runner's `factSanitizer` (if configured) to each candidate
 * fact. Returns the filtered list:
 *
 *  - Sanitizer returns a fact → keep it (possibly replaced).
 *  - Sanitizer returns `null` → drop the fact silently.
 *  - Sanitizer throws → log and keep the original fact. By contract a
 *    downed PII service must not block compound learning.
 */
async function applySanitizer(
  facts: MemoryWriterFact[],
  nodeId: string,
  ctx: NodeExecutorContext,
): Promise<MemoryWriterFact[]> {
  const sanitizer = ctx.factSanitizer;
  if (!sanitizer) return facts;

  // Fail closed by default: a thrown sanitizer (downed PII service, buggy
  // regex) drops the fact rather than persisting it unredacted into durable,
  // cross-run memory. Hosts that prioritize reflection availability over
  // redaction guarantees can opt into 'pass' on GraphRunnerOptions.
  const failMode = ctx.factSanitizerFailMode ?? 'drop';

  const out: MemoryWriterFact[] = [];
  let dropped = 0;
  let erroredDropped = 0;
  for (const fact of facts) {
    try {
      const result = await sanitizer(fact);
      if (result === null) {
        dropped++;
        continue;
      }
      out.push(result);
    } catch (err) {
      if (failMode === 'drop') {
        erroredDropped++;
        logger.error('fact_sanitizer_failed_drop', err instanceof Error ? err : new Error(String(err)), {
          node_id: nodeId,
          fail_mode: failMode,
        });
        continue;
      }
      logger.warn('fact_sanitizer_failed_pass', {
        node_id: nodeId,
        fail_mode: failMode,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(fact);
    }
  }

  if (dropped > 0 || erroredDropped > 0) {
    logger.info('reflection_facts_sanitized', {
      node_id: nodeId,
      kept: out.length,
      dropped,
      dropped_on_error: erroredDropped,
    });
  }
  return out;
}

/**
 * Strip prompt-injection vectors from a fact's content before it is
 * persisted to long-term memory.
 *
 * Reflection facts are distilled from work that may include tainted external
 * data (web pages, tool results). Without this, an attacker could plant
 * instruction-shaped text that a *future* run retrieves via `memoryRetriever`
 * and injects into prompts — a cross-run stored-injection channel. Reuses the
 * same denylist sanitizer applied to memory before prompt embedding.
 */
function sanitizeFactContent(content: string): string {
  return sanitizeString(content);
}

// ─── Helpers (shared by both extractors) ────────────────────────────

function concatSourceValues(
  sourceKeys: readonly string[],
  memory: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of sourceKeys) {
    const value = memory[key];
    if (value === undefined || value === null) continue;
    parts.push(stringifyValue(value));
  }
  return parts.join('\n\n');
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Sentence splitter — period, exclamation, or question mark followed by
 * whitespace or end-of-string. Bullet lines (newline-leading dashes or
 * numbered items) are also treated as sentence boundaries so agent notes
 * survive intact. Pragmatic, not linguistically perfect: abbreviations
 * like "U.S." will over-split. That is acceptable for reflection where
 * downstream dedup absorbs the noise.
 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  // First, normalise bullet markers and newlines into sentence terminators.
  const normalised = text
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*[-*]\s+/g, '. ')
    .replace(/\n\s*\d+\.\s+/g, '. ')
    .replace(/\n+/g, ' ');
  return normalised.split(/(?<=[.!?])\s+/);
}

function dedupeNormalised(sentences: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentences) {
    const normalised = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalised.length === 0) continue;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(sentence);
  }
  return out;
}

function collectEntityRefs(
  entityKeys: readonly string[] | undefined,
  memory: Record<string, unknown>,
): MemoryWriterFact['entities'] {
  if (!entityKeys || entityKeys.length === 0) return undefined;
  const refs: NonNullable<MemoryWriterFact['entities']> = [];
  for (const key of entityKeys) {
    const value = memory[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      refs.push({ name: value, type: 'concept' });
    }
  }
  return refs.length > 0 ? refs : undefined;
}

function buildReflectionAction(
  node: GraphNode,
  config: ReflectionConfig,
  factIds: string[],
  attempt: number,
  ctx: NodeExecutorContext,
  tokensUsed: number,
): Action {
  const resultKey = config.result_key ?? `${node.id}_reflection`;
  return {
    id: uuidv4(),
    idempotency_key: `${node.id}:${ctx.state.iteration_count}:${attempt}`,
    type: 'update_memory',
    payload: {
      updates: {
        [resultKey]: {
          extractor_type: config.extractor.type,
          fact_ids: factIds,
          tags: config.tags,
          reflected_at: new Date().toISOString(),
        },
      },
    },
    metadata: {
      node_id: node.id,
      timestamp: new Date(),
      attempt,
      ...(tokensUsed > 0 ? { token_usage: { totalTokens: tokensUsed } } : {}),
    },
  };
}

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown when a reflection node executes without a `memoryWriter` having
 * been injected on the runner. Reflection requires the writer — there is
 * no useful fallback (in-process memory would be lost on restart).
 */
export class MemoryWriterMissingError extends Error {
  constructor(public readonly nodeId: string) {
    super(
      `Reflection node "${nodeId}" requires a memoryWriter on GraphRunnerOptions ` +
        `but none was provided`,
    );
    this.name = 'MemoryWriterMissingError';
  }
}

