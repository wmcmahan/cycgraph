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
 * @module agent/retrieve-for-prompt
 */

import type { StateView } from '../types/state.js';
import type { MemoryRetriever, MemoryRetrievalResult } from './memory-retriever.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent.retrieve-for-prompt');

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

  try {
    return await retriever(query, {
      ...(rawQuery.maxFacts !== undefined ? { maxFacts: rawQuery.maxFacts } : {}),
      model,
    });
  } catch (err) {
    logger.warn('memory_retriever_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
