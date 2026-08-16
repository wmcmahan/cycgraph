/**
 * Prompt-Time Memory Retrieval
 *
 * Shared by the agent and supervisor executors: resolves a node's
 * `memory_query` directive against the injected {@link MemoryRetriever}
 * before prompt construction.
 *
 * Best-effort by contract — any retriever failure is logged and
 * swallowed so a downed knowledge store never blocks the workflow; the
 * node still gets the workflow-state memory in its prompt.
 *
 * @module memory/retrieve-for-prompt
 */

import type { StateView } from '../state/state.js';
import type { MemoryRetriever, MemoryRetrievalResult } from './memory-retriever.js';
import { createLogger } from '../observability/logger.js';
import { getTracer, withSpan } from '../observability/tracing.js';

const logger = createLogger('agent.retrieve-for-prompt');
const tracer = getTracer('memory.retrieve');

/**
 * Range of the scores an adapter supplied, when it supplies any.
 *
 * A prompt filled with weak matches and one filled with strong matches are
 * the same size and read the same in a log; the spread is what tells them
 * apart.
 */
function scoreSummary(
  facts: Array<{ score?: number }> | undefined,
): { score_min?: number; score_max?: number } {
  const scores = (facts ?? []).map((fact) => fact.score).filter((score): score is number => score !== undefined);
  if (scores.length === 0) return {};
  return { score_min: Math.min(...scores), score_max: Math.max(...scores) };
}

/**
 * Resolve memory for an upcoming prompt via the injected `memoryRetriever`.
 * Returns `null` when no retriever or no query is provided.
 *
 * Defaults `text` to `stateView.goal` when neither `text`, `entityIds`,
 * nor `tags` is set on the query, so RAG-style use cases work with
 * `memory_query: {}`. The fallback is skipped when tags or entityIds are
 * present — those queries are intentional and adding a goal-derived text
 * would muddy the retriever's intent.
 */
export async function retrieveForPrompt(
  retriever: MemoryRetriever | undefined,
  rawQuery:
    | { text?: string; entityIds?: string[]; tags?: string[]; maxFacts?: number }
    | undefined,
  stateView: StateView,
  model: string,
  nodeId?: string,
): Promise<MemoryRetrievalResult | null> {
  if (!retriever || !rawQuery) return null;

  const query: { text?: string; entityIds?: string[]; tags?: string[] } = {};
  if (rawQuery.text) query.text = rawQuery.text;
  if (rawQuery.entityIds && rawQuery.entityIds.length > 0) query.entityIds = rawQuery.entityIds;
  if (rawQuery.tags && rawQuery.tags.length > 0) query.tags = rawQuery.tags;

  if (
    query.text === undefined &&
    query.entityIds === undefined &&
    query.tags === undefined
  ) {
    query.text = stateView.goal;
  }

  const started = Date.now();
  try {
    const result = await withSpan(tracer, 'memory.retrieve', async (span) => {
      if (nodeId) span.setAttribute('memory.node_id', nodeId);
      if (query.tags) span.setAttribute('memory.query.tags', query.tags.join(','));
      span.setAttribute('memory.query.has_text', query.text !== undefined);
      span.setAttribute('memory.query.entity_count', query.entityIds?.length ?? 0);
      if (rawQuery.maxFacts !== undefined) span.setAttribute('memory.query.max_facts', rawQuery.maxFacts);

      const retrieved = await retriever(query, {
        ...(rawQuery.maxFacts !== undefined ? { maxFacts: rawQuery.maxFacts } : {}),
        model,
      });

      span.setAttribute('memory.facts_returned', retrieved?.facts.length ?? 0);
      span.setAttribute('memory.entities_returned', retrieved?.entities.length ?? 0);
      span.setAttribute('memory.themes_returned', retrieved?.themes.length ?? 0);
      return retrieved;
    });

    // What reached the prompt, recorded whether or not anything came back: a
    // query that retrieves nothing is the case worth seeing, and it is
    // indistinguishable from a retriever that was never consulted otherwise.
    logger.info('memory_retrieved', {
      node_id: nodeId,
      tags: query.tags,
      has_text: query.text !== undefined,
      entity_ids: query.entityIds?.length ?? 0,
      max_facts: rawQuery.maxFacts,
      facts: result?.facts.length ?? 0,
      entities: result?.entities.length ?? 0,
      themes: result?.themes.length ?? 0,
      // A fact without an id cannot be attributed to a run outcome, so an
      // adapter that strips ids disables eval gating silently.
      facts_without_id: result?.facts.filter((fact) => !fact.id).length ?? 0,
      ...scoreSummary(result?.facts),
      duration_ms: Date.now() - started,
    });
    return result;
  } catch (err) {
    logger.warn('memory_retriever_failed', {
      node_id: nodeId,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    });
    return null;
  }
}
