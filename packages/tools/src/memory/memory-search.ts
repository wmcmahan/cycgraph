/**
 * memory_search — agent-initiated retrieval over the knowledge graph
 *
 * The orchestrator's `memory_query` directive injects facts passively,
 * before the prompt. This tool makes retrieval active: the agent decides
 * mid-task that it needs to consult memory and queries `@cycgraph/memory`
 * by tags, seed entities, or free text (when an `embed` hook is
 * configured). Fact ids are included in the result so callers can attribute
 * run outcomes to consulted facts.
 *
 * Note: tool-initiated retrieval is not recorded in
 * `state.lesson_provenance` — that field tracks prompt-injected facts. If
 * eval-gated learning should see tool-driven consultation, record the
 * returned fact ids caller-side.
 *
 * By default results are untainted (memory is first-party state). Set
 * `untrusted: true` when the store holds externally-derived content so
 * results are taint-tracked like any external source.
 *
 * @module memory/memory-search
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';
import { retrieveMemory } from '@cycgraph/memory';
import type { MemoryStore, MemoryIndex } from '@cycgraph/memory';

/** Embedding hook enabling free-text queries. */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Options for {@link createMemorySearchTool}. */
export interface MemorySearchToolOptions {
  /** The memory store to search. */
  store: MemoryStore;
  /** The vector index paired with the store. */
  index: MemoryIndex;
  /** Embedding hook for free-text queries. Without it, `query` is rejected. */
  embed?: EmbedFn;
  /**
   * Namespace scoping: facts must carry at least one of these tags to be
   * returned, regardless of what the model searched for. The underlying tag
   * query is any-of, so scoping is enforced as a result filter.
   */
  scopeTags?: string[];
  /** Max results per record type. @default 10 */
  maxResults?: number;
  /** Taint-track results (store holds externally-derived content). @default false */
  untrusted?: boolean;
  /** Per-call timeout forwarded to defineTool. @default 10000 */
  timeoutMs?: number;
}

/**
 * Create the `memory_search` tool for a store/index pair.
 */
export function createMemorySearchTool(options: MemorySearchToolOptions): DefinedTool {
  const maxResults = options.maxResults ?? 10;

  return defineTool({
    name: 'memory_search',
    description:
      'Search long-term memory for relevant facts, entities, and themes. ' +
      'Query by tags, by seed entity ids (expands the surrounding subgraph), ' +
      (options.embed ? 'or by free-text query. ' : '') +
      'Returns facts with ids and validity timestamps.',
    parameters: z.object({
      query: z.string().optional().describe('Free-text query for semantic search'),
      entityIds: z
        .array(z.uuid())
        .optional()
        .describe('Seed entity ids; retrieval expands their subgraph'),
      tags: z.array(z.string()).optional().describe('Restrict to facts carrying these tags'),
      limit: z.number().int().min(1).max(50).optional().describe(`Max results (default ${maxResults})`),
    }),
    taints: options.untrusted ?? false,
    timeoutMs: options.timeoutMs ?? 10_000,
    execute: async ({ query, entityIds, tags, limit }) => {
      const scopeTags = options.scopeTags ?? [];
      const queryTags = tags && tags.length > 0 ? tags : scopeTags;

      let embedding: number[] | undefined;
      if (query) {
        if (!options.embed) {
          throw new Error(
            'Free-text query requires an embed hook on this tool — search by tags or entityIds instead',
          );
        }
        embedding = await options.embed(query);
      }

      if (!embedding && (!entityIds || entityIds.length === 0) && queryTags.length === 0) {
        throw new Error('Provide a query, entityIds, or tags to search memory');
      }

      const result = await retrieveMemory(options.store, options.index, {
        ...(embedding ? { embedding } : {}),
        ...(entityIds && entityIds.length > 0 ? { entityIds } : {}),
        tags: queryTags,
        limit: Math.min(limit ?? maxResults, maxResults),
        maxHops: 2,
        minSimilarity: 0.5,
        includeInvalidated: false,
      });

      // The tag query above is any-of; scoping must therefore be enforced on
      // the results, or a model-supplied tag would escape the namespace.
      const scopedFacts =
        scopeTags.length > 0
          ? result.facts.filter((f) => (f.tags ?? []).some((t) => scopeTags.includes(t)))
          : result.facts;

      return {
        facts: scopedFacts.map((f) => ({
          id: f.id,
          content: f.content,
          validFrom: new Date(f.valid_from).toISOString(),
          tags: f.tags,
        })),
        entities: result.entities.map((e) => ({ id: e.id, name: e.name, type: e.entity_type })),
        themes: result.themes.map((t) => ({ label: t.label })),
      };
    },
  });
}
