/**
 * Memory Query & Result Schemas
 *
 * Defines the input/output contract for memory retrieval.
 * A `MemoryQuery` describes what to find; a `MemoryResult`
 * contains the retrieved subset of the memory graph.
 *
 * @module schemas/query
 */

import { z } from 'zod';
import { EntitySchema } from './entity.js';
import { RelationshipSchema } from './relationship.js';
import { EpisodeSchema } from './episode.js';
import { SemanticFactSchema } from './semantic.js';
import { ThemeSchema } from './theme.js';

export const MemoryQuerySchema = z.object({
  /** Natural language query text (used for embedding if no embedding provided). */
  text: z.string().optional(),
  /** Pre-computed query embedding vector. */
  embedding: z.array(z.number()).optional(),
  /** Seed entity IDs for subgraph extraction. */
  entityIds: z.array(z.string().uuid()).optional(),
  /** Filter entities by type. */
  entityTypes: z.array(z.string()).optional(),
  /** Filter relationships by type. */
  relationTypes: z.array(z.string()).optional(),
  /** Max BFS hops for subgraph extraction (0–5). */
  maxHops: z.number().int().min(0).max(5).default(2),
  /** Return only records valid at this point in time. */
  validAt: z.coerce.date().optional(),
  /** Return only records that changed after this point in time. */
  changedSince: z.coerce.date().optional(),
  /** Maximum number of results per record type. */
  limit: z.number().int().min(1).max(100).default(20),
  /** Minimum embedding similarity threshold (0–1). */
  minSimilarity: z.number().min(0).max(1).default(0.5),
  /** Include invalidated records in results. */
  includeInvalidated: z.boolean().default(false),
  /**
   * Restrict matches to facts carrying at least one of the listed tags.
   * Omit (or leave empty) to skip tag filtering. Reflection nodes write
   * facts with tags so downstream queries can scope retrieval to lessons
   * from a specific graph or category.
   */
  tags: z.array(z.string()).default([]),
});

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const MemoryResultSchema = z.object({
  /** Matched themes (highest level of hierarchy). */
  themes: z.array(ThemeSchema).default([]),
  /** Matched semantic facts. */
  facts: z.array(SemanticFactSchema).default([]),
  /** Matched episodes. */
  episodes: z.array(EpisodeSchema).default([]),
  /** Matched entities. */
  entities: z.array(EntitySchema).default([]),
  /** Matched relationships. */
  relationships: z.array(RelationshipSchema).default([]),
});

export type MemoryResult = z.infer<typeof MemoryResultSchema>;
