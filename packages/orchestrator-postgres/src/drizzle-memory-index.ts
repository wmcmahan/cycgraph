/**
 * Drizzle Memory Index
 *
 * Implements the MemoryIndex interface from @cycgraph/memory using
 * pgvector HNSW cosine similarity search.
 *
 * @module @cycgraph/orchestrator-postgres/drizzle-memory-index
 */

import { sql, and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from './connection.js';
import { withTenant, type Tx, type TenantContext } from './tenancy.js';
import {
  memory_entities,
  memory_episodes,
  memory_facts,
  memory_themes,
} from './schema.js';
import type {
  MemoryIndex,
  MemoryStore,
  ScoredResult,
  SearchOptions,
  Entity,
  SemanticFact,
  Theme,
  Episode,
  Provenance,
} from '@cycgraph/memory';
import type { MemoryProvenanceJson } from './schema.js';

// ─── Type Conversion ─────────────────────────────────────────────────

function fromProvenanceJson(j: MemoryProvenanceJson): Provenance {
  return {
    source: j.source as Provenance['source'],
    agent_id: j.agent_id,
    tool_name: j.tool_name,
    run_id: j.run_id,
    node_id: j.node_id,
    confidence: j.confidence,
    created_at: new Date(j.created_at),
  };
}

function fromDbEntity(row: typeof memory_entities.$inferSelect): Entity {
  return {
    id: row.id,
    name: row.name,
    entity_type: row.entity_type,
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    embedding: row.embedding ? (row.embedding as unknown as number[]) : undefined,
    provenance: fromProvenanceJson(row.provenance),
    created_at: row.created_at,
    updated_at: row.updated_at,
    invalidated_at: row.invalidated_at ?? undefined,
    superseded_by: row.superseded_by ?? undefined,
  };
}

function fromDbFact(row: typeof memory_facts.$inferSelect): SemanticFact {
  return {
    id: row.id,
    content: row.content,
    source_episode_ids: (row.source_episode_ids ?? []) as string[],
    entity_ids: (row.entity_ids ?? []) as string[],
    theme_id: row.theme_id ?? undefined,
    embedding: row.embedding ? (row.embedding as unknown as number[]) : undefined,
    provenance: fromProvenanceJson(row.provenance),
    valid_from: row.valid_from,
    valid_until: row.valid_until ?? undefined,
    invalidated_by: row.invalidated_by ?? undefined,
    access_count: row.access_count ?? 0,
    last_accessed_at: row.last_accessed_at ?? undefined,
    tags: (row.tags ?? []) as string[],
  };
}

function fromDbTheme(row: typeof memory_themes.$inferSelect): Theme {
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? '',
    fact_ids: (row.fact_ids ?? []) as string[],
    embedding: row.embedding ? (row.embedding as unknown as number[]) : undefined,
    provenance: fromProvenanceJson(row.provenance),
  };
}

function fromDbEpisode(row: typeof memory_episodes.$inferSelect): Episode {
  return {
    id: row.id,
    topic: row.topic,
    messages: (row.messages ?? []) as Episode['messages'],
    started_at: row.started_at,
    ended_at: row.ended_at,
    embedding: row.embedding ? (row.embedding as unknown as number[]) : undefined,
    fact_ids: (row.fact_ids ?? []) as string[],
    provenance: fromProvenanceJson(row.provenance),
  };
}

// ─── DrizzleMemoryIndex ──────────────────────────────────────────────

/** A query handle usable for both standalone (`db`) and tenant-scoped (`tx`) work. */
type Queryer = Awaited<ReturnType<typeof getDb>> | Tx;

export interface DrizzleMemoryIndexOptions {
  /**
   * Tenant whose vectors this index searches. When set, every similarity
   * search is filtered to the tenant — so a nearest-neighbour query can never
   * return another tenant's facts/entities/themes/episodes. When omitted,
   * single-tenant (seed default).
   *
   * SECURITY: this is the vector-search half of the lesson-isolation boundary
   * (the keyword/tag half lives in DrizzleMemoryStore.findFacts).
   */
  tenant?: TenantContext;
}

export class DrizzleMemoryIndex implements MemoryIndex {
  private readonly tenant?: TenantContext;

  constructor(options?: DrizzleMemoryIndexOptions) {
    this.tenant = options?.tenant;
  }

  private tenantEq(col: AnyPgColumn): SQL | undefined {
    return this.tenant ? eq(col, this.tenant.tenant_id) : undefined;
  }

  private async read<T>(fn: (db: Queryer) => Promise<T>): Promise<T> {
    const database = await getDb();
    return this.tenant ? withTenant(this.tenant.tenant_id, fn) : fn(database);
  }

  async searchEntities(
    embedding: number[],
    opts: SearchOptions = {},
  ): Promise<ScoredResult<Entity>[]> {
    const { limit = 20, min_similarity = 0.5 } = opts;
    const vectorStr = `[${embedding.join(',')}]`;

    const rows = await this.read((db) => db
      .select({
        id: memory_entities.id,
        name: memory_entities.name,
        entity_type: memory_entities.entity_type,
        attributes: memory_entities.attributes,
        embedding: memory_entities.embedding,
        provenance: memory_entities.provenance,
        created_at: memory_entities.created_at,
        updated_at: memory_entities.updated_at,
        invalidated_at: memory_entities.invalidated_at,
        superseded_by: memory_entities.superseded_by,
        score: sql<number>`1 - (${memory_entities.embedding} <=> ${vectorStr}::vector)`.as('score'),
      })
      .from(memory_entities)
      .where(
        and(
          sql`${memory_entities.embedding} IS NOT NULL AND 1 - (${memory_entities.embedding} <=> ${vectorStr}::vector) >= ${min_similarity}`,
          this.tenantEq(memory_entities.tenant_id),
        ),
      )
      .orderBy(sql`${memory_entities.embedding} <=> ${vectorStr}::vector`)
      .limit(limit));

    return rows.map(({ score, ...row }) => ({
      item: fromDbEntity(row as typeof memory_entities.$inferSelect),
      score,
    }));
  }

  async searchFacts(
    embedding: number[],
    opts: SearchOptions = {},
  ): Promise<ScoredResult<SemanticFact>[]> {
    const { limit = 20, min_similarity = 0.5 } = opts;
    const vectorStr = `[${embedding.join(',')}]`;

    const rows = await this.read((db) => db
      .select({
        id: memory_facts.id,
        content: memory_facts.content,
        source_episode_ids: memory_facts.source_episode_ids,
        entity_ids: memory_facts.entity_ids,
        theme_id: memory_facts.theme_id,
        embedding: memory_facts.embedding,
        provenance: memory_facts.provenance,
        valid_from: memory_facts.valid_from,
        valid_until: memory_facts.valid_until,
        invalidated_by: memory_facts.invalidated_by,
        access_count: memory_facts.access_count,
        last_accessed_at: memory_facts.last_accessed_at,
        score: sql<number>`1 - (${memory_facts.embedding} <=> ${vectorStr}::vector)`.as('score'),
      })
      .from(memory_facts)
      .where(
        and(
          sql`${memory_facts.embedding} IS NOT NULL AND 1 - (${memory_facts.embedding} <=> ${vectorStr}::vector) >= ${min_similarity}`,
          this.tenantEq(memory_facts.tenant_id),
        ),
      )
      .orderBy(sql`${memory_facts.embedding} <=> ${vectorStr}::vector`)
      .limit(limit));

    return rows.map(({ score, ...row }) => ({
      item: fromDbFact(row as typeof memory_facts.$inferSelect),
      score,
    }));
  }

  async searchThemes(
    embedding: number[],
    opts: SearchOptions = {},
  ): Promise<ScoredResult<Theme>[]> {
    const { limit = 20, min_similarity = 0.5 } = opts;
    const vectorStr = `[${embedding.join(',')}]`;

    const rows = await this.read((db) => db
      .select({
        id: memory_themes.id,
        label: memory_themes.label,
        description: memory_themes.description,
        fact_ids: memory_themes.fact_ids,
        embedding: memory_themes.embedding,
        provenance: memory_themes.provenance,
        score: sql<number>`1 - (${memory_themes.embedding} <=> ${vectorStr}::vector)`.as('score'),
      })
      .from(memory_themes)
      .where(
        and(
          sql`${memory_themes.embedding} IS NOT NULL AND 1 - (${memory_themes.embedding} <=> ${vectorStr}::vector) >= ${min_similarity}`,
          this.tenantEq(memory_themes.tenant_id),
        ),
      )
      .orderBy(sql`${memory_themes.embedding} <=> ${vectorStr}::vector`)
      .limit(limit));

    return rows.map(({ score, ...row }) => ({
      item: fromDbTheme(row as typeof memory_themes.$inferSelect),
      score,
    }));
  }

  async searchEpisodes(
    embedding: number[],
    opts: SearchOptions = {},
  ): Promise<ScoredResult<Episode>[]> {
    const { limit = 20, min_similarity = 0.5 } = opts;
    const vectorStr = `[${embedding.join(',')}]`;

    const rows = await this.read((db) => db
      .select({
        id: memory_episodes.id,
        topic: memory_episodes.topic,
        messages: memory_episodes.messages,
        started_at: memory_episodes.started_at,
        ended_at: memory_episodes.ended_at,
        embedding: memory_episodes.embedding,
        fact_ids: memory_episodes.fact_ids,
        provenance: memory_episodes.provenance,
        score: sql<number>`1 - (${memory_episodes.embedding} <=> ${vectorStr}::vector)`.as('score'),
      })
      .from(memory_episodes)
      .where(
        and(
          sql`${memory_episodes.embedding} IS NOT NULL AND 1 - (${memory_episodes.embedding} <=> ${vectorStr}::vector) >= ${min_similarity}`,
          this.tenantEq(memory_episodes.tenant_id),
        ),
      )
      .orderBy(sql`${memory_episodes.embedding} <=> ${vectorStr}::vector`)
      .limit(limit));

    return rows.map(({ score, ...row }) => ({
      item: fromDbEpisode(row as typeof memory_episodes.$inferSelect),
      score,
    }));
  }

  async rebuild(_store: MemoryStore): Promise<void> {
    // HNSW indexes are automatically maintained by pgvector.
    // No manual rebuild needed.
  }
}
