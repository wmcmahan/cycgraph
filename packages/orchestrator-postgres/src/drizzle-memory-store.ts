/**
 * Drizzle Memory Store
 *
 * Implements the MemoryStore interface from @cycgraph/memory using
 * Drizzle ORM + PostgreSQL with pgvector for embedding storage.
 *
 * @module @cycgraph/orchestrator-postgres/drizzle-memory-store
 */

import { getDb } from './connection.js';
import {
  memory_entities,
  memory_relationships,
  memory_episodes,
  memory_facts,
  memory_themes,
  memory_entity_facts,
} from './schema.js';
import type { MemoryProvenanceJson } from './schema.js';
import { eq, and, or, isNull, inArray, desc, sql } from 'drizzle-orm';
import type {
  MemoryStore,
  EntityFilter,
  FactFilter,
  RelationshipFilter,
  PaginationOptions,
} from '@cycgraph/memory';
import type {
  Entity,
  Relationship,
  Episode,
  SemanticFact,
  Theme,
  Provenance,
} from '@cycgraph/memory';

// ─── Type Conversion Helpers ─────────────────────────────────────────

function toProvenanceJson(p: Provenance): MemoryProvenanceJson {
  return {
    source: p.source,
    agent_id: p.agent_id,
    tool_name: p.tool_name,
    run_id: p.run_id,
    node_id: p.node_id,
    confidence: p.confidence,
    created_at: p.created_at.toISOString(),
  };
}

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

function toDbEntity(entity: Entity) {
  return {
    id: entity.id,
    name: entity.name,
    entity_type: entity.entity_type,
    attributes: entity.attributes,
    embedding: entity.embedding ?? null,
    provenance: toProvenanceJson(entity.provenance),
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    invalidated_at: entity.invalidated_at ?? null,
    superseded_by: entity.superseded_by ?? null,
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

function toDbRelationship(rel: Relationship) {
  return {
    id: rel.id,
    source_id: rel.source_id,
    target_id: rel.target_id,
    relation_type: rel.relation_type,
    weight: rel.weight,
    attributes: rel.attributes,
    valid_from: rel.valid_from,
    valid_until: rel.valid_until ?? null,
    provenance: toProvenanceJson(rel.provenance),
    invalidated_by: rel.invalidated_by ?? null,
  };
}

function fromDbRelationship(row: typeof memory_relationships.$inferSelect): Relationship {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    relation_type: row.relation_type,
    weight: row.weight,
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    valid_from: row.valid_from,
    valid_until: row.valid_until ?? undefined,
    provenance: fromProvenanceJson(row.provenance),
    invalidated_by: row.invalidated_by ?? undefined,
  };
}

function toDbEpisode(ep: Episode) {
  return {
    id: ep.id,
    topic: ep.topic,
    messages: ep.messages as unknown[],
    started_at: ep.started_at,
    ended_at: ep.ended_at,
    embedding: ep.embedding ?? null,
    fact_ids: ep.fact_ids,
    provenance: toProvenanceJson(ep.provenance),
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

function toDbFact(fact: SemanticFact) {
  return {
    id: fact.id,
    content: fact.content,
    source_episode_ids: fact.source_episode_ids,
    entity_ids: fact.entity_ids,
    theme_id: fact.theme_id ?? null,
    embedding: fact.embedding ?? null,
    provenance: toProvenanceJson(fact.provenance),
    valid_from: fact.valid_from,
    valid_until: fact.valid_until ?? null,
    invalidated_by: fact.invalidated_by ?? null,
    access_count: fact.access_count ?? 0,
    last_accessed_at: fact.last_accessed_at ?? null,
    tags: fact.tags,
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

function toDbTheme(theme: Theme) {
  return {
    id: theme.id,
    label: theme.label,
    description: theme.description,
    fact_ids: theme.fact_ids,
    embedding: theme.embedding ?? null,
    provenance: toProvenanceJson(theme.provenance),
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

// ─── DrizzleMemoryStore ──────────────────────────────────────────────

export class DrizzleMemoryStore implements MemoryStore {

  // ── Entity Operations ──

  async putEntity(entity: Entity): Promise<void> {
    const db = await getDb();
    const values = toDbEntity(entity);
    await db.insert(memory_entities)
      .values(values)
      .onConflictDoUpdate({
        target: memory_entities.id,
        set: {
          name: values.name,
          entity_type: values.entity_type,
          attributes: values.attributes,
          embedding: values.embedding,
          provenance: values.provenance,
          updated_at: values.updated_at,
          invalidated_at: values.invalidated_at,
          superseded_by: values.superseded_by,
        },
      });
  }

  async getEntity(id: string): Promise<Entity | null> {
    const db = await getDb();
    const rows = await db.select().from(memory_entities)
      .where(eq(memory_entities.id, id))
      .limit(1);
    return rows.length > 0 ? fromDbEntity(rows[0]) : null;
  }

  async findEntities(filter: EntityFilter & PaginationOptions = {}): Promise<Entity[]> {
    const db = await getDb();
    const conditions = [];

    if (filter.entity_type) {
      conditions.push(eq(memory_entities.entity_type, filter.entity_type));
    }
    if (!filter.include_invalidated) {
      conditions.push(isNull(memory_entities.invalidated_at));
    }

    const query = db.select().from(memory_entities);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await (whereClause ? query.where(whereClause) : query)
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    return rows.map(fromDbEntity);
  }

  async deleteEntity(id: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.delete(memory_entities)
      .where(eq(memory_entities.id, id))
      .returning({ id: memory_entities.id });
    return result.length > 0;
  }

  // ── Relationship Operations ──

  async putRelationship(relationship: Relationship): Promise<void> {
    const db = await getDb();
    const values = toDbRelationship(relationship);
    await db.insert(memory_relationships)
      .values(values)
      .onConflictDoUpdate({
        target: memory_relationships.id,
        set: {
          source_id: values.source_id,
          target_id: values.target_id,
          relation_type: values.relation_type,
          weight: values.weight,
          attributes: values.attributes,
          valid_from: values.valid_from,
          valid_until: values.valid_until,
          provenance: values.provenance,
          invalidated_by: values.invalidated_by,
        },
      });
  }

  async getRelationship(id: string): Promise<Relationship | null> {
    const db = await getDb();
    const rows = await db.select().from(memory_relationships)
      .where(eq(memory_relationships.id, id))
      .limit(1);
    return rows.length > 0 ? fromDbRelationship(rows[0]) : null;
  }

  async getRelationshipsForEntity(
    entityId: string,
    filter: RelationshipFilter = {},
  ): Promise<Relationship[]> {
    const db = await getDb();
    const conditions = [];

    const direction = filter.direction ?? 'both';
    if (direction === 'outgoing') {
      conditions.push(eq(memory_relationships.source_id, entityId));
    } else if (direction === 'incoming') {
      conditions.push(eq(memory_relationships.target_id, entityId));
    } else {
      conditions.push(
        or(
          eq(memory_relationships.source_id, entityId),
          eq(memory_relationships.target_id, entityId),
        )!,
      );
    }

    if (filter.relation_type) {
      conditions.push(eq(memory_relationships.relation_type, filter.relation_type));
    }
    if (!filter.include_invalidated) {
      conditions.push(isNull(memory_relationships.invalidated_by));
    }

    const rows = await db.select().from(memory_relationships)
      .where(and(...conditions));

    return rows.map(fromDbRelationship);
  }

  async deleteRelationship(id: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.delete(memory_relationships)
      .where(eq(memory_relationships.id, id))
      .returning({ id: memory_relationships.id });
    return result.length > 0;
  }

  // ── Episode Operations ──

  async putEpisode(episode: Episode): Promise<void> {
    const db = await getDb();
    const values = toDbEpisode(episode);
    await db.insert(memory_episodes)
      .values(values)
      .onConflictDoUpdate({
        target: memory_episodes.id,
        set: {
          topic: values.topic,
          messages: values.messages,
          started_at: values.started_at,
          ended_at: values.ended_at,
          embedding: values.embedding,
          fact_ids: values.fact_ids,
          provenance: values.provenance,
        },
      });
  }

  async getEpisode(id: string): Promise<Episode | null> {
    const db = await getDb();
    const rows = await db.select().from(memory_episodes)
      .where(eq(memory_episodes.id, id))
      .limit(1);
    return rows.length > 0 ? fromDbEpisode(rows[0]) : null;
  }

  async listEpisodes(opts: PaginationOptions = {}): Promise<Episode[]> {
    const db = await getDb();
    const rows = await db.select().from(memory_episodes)
      .orderBy(desc(memory_episodes.started_at))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map(fromDbEpisode);
  }

  async deleteEpisode(id: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.delete(memory_episodes)
      .where(eq(memory_episodes.id, id))
      .returning({ id: memory_episodes.id });
    return result.length > 0;
  }

  // ── Semantic Fact Operations ──

  async putFact(fact: SemanticFact): Promise<void> {
    const db = await getDb();
    const values = toDbFact(fact);
    await db.transaction(async (tx) => {
      await tx.insert(memory_facts)
        .values(values)
        .onConflictDoUpdate({
          target: memory_facts.id,
          set: {
            content: values.content,
            source_episode_ids: values.source_episode_ids,
            entity_ids: values.entity_ids,
            theme_id: values.theme_id,
            embedding: values.embedding,
            provenance: values.provenance,
            valid_from: values.valid_from,
            valid_until: values.valid_until,
            invalidated_by: values.invalidated_by,
            access_count: values.access_count,
            last_accessed_at: values.last_accessed_at,
          },
        });

      // Sync join table
      await tx.delete(memory_entity_facts)
        .where(eq(memory_entity_facts.fact_id, fact.id));

      if (fact.entity_ids.length > 0) {
        await tx.insert(memory_entity_facts).values(
          fact.entity_ids.map((eid: string) => ({ fact_id: fact.id, entity_id: eid })),
        );
      }
    });
  }

  async getFact(id: string): Promise<SemanticFact | null> {
    const db = await getDb();
    const rows = await db.select().from(memory_facts)
      .where(eq(memory_facts.id, id))
      .limit(1);
    return rows.length > 0 ? fromDbFact(rows[0]) : null;
  }

  async findFacts(filter: FactFilter & PaginationOptions = {}): Promise<SemanticFact[]> {
    const db = await getDb();
    const conditions = [];

    if (!filter.include_invalidated) {
      conditions.push(isNull(memory_facts.invalidated_by));
    }
    if (filter.theme_id) {
      conditions.push(eq(memory_facts.theme_id, filter.theme_id));
    }
    if (filter.entity_id) {
      const factIdsForEntity = db.select({ fact_id: memory_entity_facts.fact_id })
        .from(memory_entity_facts)
        .where(eq(memory_entity_facts.entity_id, filter.entity_id));
      conditions.push(inArray(memory_facts.id, factIdsForEntity));
    }
    if (filter.tags && filter.tags.length > 0) {
      // `tags ?| $1::text[]` — true if the jsonb `tags` array shares ANY element
      // with the requested tags. Resolved via the GIN index on `tags`
      // (migration 0015) instead of a client-side table scan. The tag list is
      // bound as a single parameterized text[] (no string interpolation).
      conditions.push(sql`${memory_facts.tags} ?| ${[...filter.tags]}::text[]`);
    }

    const query = db.select().from(memory_facts);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Deterministic order so LIMIT/OFFSET pagination is stable across calls
    // (newest facts first; id as a tiebreak for equal timestamps).
    const rows = await (whereClause ? query.where(whereClause) : query)
      .orderBy(desc(memory_facts.valid_from), memory_facts.id)
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    return rows.map(fromDbFact);
  }

  async deleteFact(id: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.delete(memory_facts)
      .where(eq(memory_facts.id, id))
      .returning({ id: memory_facts.id });
    return result.length > 0;
  }

  // ── Theme Operations ──

  async putTheme(theme: Theme): Promise<void> {
    const db = await getDb();
    const values = toDbTheme(theme);
    await db.insert(memory_themes)
      .values(values)
      .onConflictDoUpdate({
        target: memory_themes.id,
        set: {
          label: values.label,
          description: values.description,
          fact_ids: values.fact_ids,
          embedding: values.embedding,
          provenance: values.provenance,
        },
      });
  }

  async getTheme(id: string): Promise<Theme | null> {
    const db = await getDb();
    const rows = await db.select().from(memory_themes)
      .where(eq(memory_themes.id, id))
      .limit(1);
    return rows.length > 0 ? fromDbTheme(rows[0]) : null;
  }

  async listThemes(): Promise<Theme[]> {
    const db = await getDb();
    const rows = await db.select().from(memory_themes);
    return rows.map(fromDbTheme);
  }

  async deleteTheme(id: string): Promise<boolean> {
    const db = await getDb();
    const result = await db.delete(memory_themes)
      .where(eq(memory_themes.id, id))
      .returning({ id: memory_themes.id });
    return result.length > 0;
  }

  // ── Batch Operations ──

  async getEntities(ids: string[]): Promise<Map<string, Entity>> {
    if (ids.length === 0) return new Map();
    const db = await getDb();
    const rows = await db.select().from(memory_entities)
      .where(inArray(memory_entities.id, ids));
    const result = new Map<string, Entity>();
    for (const row of rows) {
      const entity = fromDbEntity(row);
      result.set(entity.id, entity);
    }
    return result;
  }

  async getFacts(ids: string[]): Promise<Map<string, SemanticFact>> {
    if (ids.length === 0) return new Map();
    const db = await getDb();
    const rows = await db.select().from(memory_facts)
      .where(inArray(memory_facts.id, ids));
    const result = new Map<string, SemanticFact>();
    for (const row of rows) {
      const fact = fromDbFact(row);
      result.set(fact.id, fact);
    }
    return result;
  }

  async getEpisodes(ids: string[]): Promise<Map<string, Episode>> {
    if (ids.length === 0) return new Map();
    const db = await getDb();
    const rows = await db.select().from(memory_episodes)
      .where(inArray(memory_episodes.id, ids));
    const result = new Map<string, Episode>();
    for (const row of rows) {
      const episode = fromDbEpisode(row);
      result.set(episode.id, episode);
    }
    return result;
  }

  async getThemes(ids: string[]): Promise<Map<string, Theme>> {
    if (ids.length === 0) return new Map();
    const db = await getDb();
    const rows = await db.select().from(memory_themes)
      .where(inArray(memory_themes.id, ids));
    const result = new Map<string, Theme>();
    for (const row of rows) {
      const theme = fromDbTheme(row);
      result.set(theme.id, theme);
    }
    return result;
  }

  // ── Lifecycle ──

  async clear(): Promise<void> {
    const db = await getDb();
    // Delete in correct order for foreign keys
    await db.delete(memory_entity_facts);
    await db.delete(memory_facts);
    await db.delete(memory_relationships);
    await db.delete(memory_episodes);
    await db.delete(memory_themes);
    await db.delete(memory_entities);
  }
}
