/**
 * In-Memory Memory Store
 *
 * Map-backed implementation of {@link MemoryStore} for testing and
 * lightweight deployments. Data is lost when the process exits.
 *
 * @module store/in-memory-store
 */

import type { Entity } from '../schemas/entity.js';
import type { Relationship } from '../schemas/relationship.js';
import type { Episode } from '../schemas/episode.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type {
  MemoryStore,
  EntityFilter,
  FactFilter,
  RelationshipFilter,
  PaginationOptions,
} from '../interfaces/memory-store.js';

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entities = new Map<string, Entity>();
  private readonly relationships = new Map<string, Relationship>();
  private readonly episodes = new Map<string, Episode>();
  private readonly facts = new Map<string, SemanticFact>();
  private readonly themes = new Map<string, Theme>();

  /** Secondary index: entity ID → set of relationship IDs. */
  private readonly entityRelationships = new Map<string, Set<string>>();

  // ── Entity Operations ──

  async putEntity(entity: Entity): Promise<void> {
    this.entities.set(entity.id, structuredClone(entity));
  }

  async getEntity(id: string): Promise<Entity | null> {
    const entity = this.entities.get(id);
    return entity ? structuredClone(entity) : null;
  }

  async findEntities(filter: EntityFilter & PaginationOptions = {}): Promise<Entity[]> {
    const { entity_type, include_invalidated = false, limit = 100, offset = 0 } = filter;
    let results = [...this.entities.values()];

    if (!include_invalidated) {
      results = results.filter((e) => !e.invalidated_at);
    }
    if (entity_type) {
      results = results.filter((e) => e.entity_type === entity_type);
    }

    return results.slice(offset, offset + limit).map((e) => structuredClone(e));
  }

  async deleteEntity(id: string): Promise<boolean> {
    const deleted = this.entities.delete(id);
    if (deleted) {
      // Clean up relationships and deindex from BOTH endpoints
      const relIds = this.entityRelationships.get(id);
      if (relIds) {
        for (const relId of [...relIds]) {  // spread: deindex mutates the set
          const rel = this.relationships.get(relId);
          if (rel) {
            this.relationships.delete(relId);
            this.deindexRelationship(rel);
          }
        }
      }
      // Belt-and-suspenders: remove the deleted entity's index entry
      this.entityRelationships.delete(id);
    }
    return deleted;
  }

  // ── Relationship Operations ──

  async putRelationship(relationship: Relationship): Promise<void> {
    const clone = structuredClone(relationship);
    this.relationships.set(clone.id, clone);
    this.indexRelationship(clone);
  }

  async getRelationship(id: string): Promise<Relationship | null> {
    const rel = this.relationships.get(id);
    return rel ? structuredClone(rel) : null;
  }

  async getRelationshipsForEntity(
    entityId: string,
    filter: RelationshipFilter = {},
  ): Promise<Relationship[]> {
    const { direction = 'both', relation_type, include_invalidated = false } = filter;
    const relIds = this.entityRelationships.get(entityId);
    if (!relIds) return [];

    let results: Relationship[] = [];
    for (const relId of relIds) {
      const rel = this.relationships.get(relId);
      if (!rel) continue;

      if (direction === 'outgoing' && rel.source_id !== entityId) continue;
      if (direction === 'incoming' && rel.target_id !== entityId) continue;
      if (!include_invalidated && rel.invalidated_by) continue;
      if (relation_type && rel.relation_type !== relation_type) continue;

      results.push(structuredClone(rel));
    }

    return results;
  }

  async deleteRelationship(id: string): Promise<boolean> {
    const rel = this.relationships.get(id);
    if (!rel) return false;

    this.relationships.delete(id);
    this.deindexRelationship(rel);
    return true;
  }

  // ── Episode Operations ──

  async putEpisode(episode: Episode): Promise<void> {
    this.episodes.set(episode.id, structuredClone(episode));
  }

  async getEpisode(id: string): Promise<Episode | null> {
    const episode = this.episodes.get(id);
    return episode ? structuredClone(episode) : null;
  }

  async listEpisodes(opts: PaginationOptions = {}): Promise<Episode[]> {
    const { limit = 100, offset = 0 } = opts;
    return [...this.episodes.values()]
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
      .slice(offset, offset + limit)
      .map((e) => structuredClone(e));
  }

  async deleteEpisode(id: string): Promise<boolean> {
    return this.episodes.delete(id);
  }

  // ── Semantic Fact Operations ──

  async putFact(fact: SemanticFact): Promise<void> {
    this.facts.set(fact.id, structuredClone(fact));
  }

  async getFact(id: string): Promise<SemanticFact | null> {
    const fact = this.facts.get(id);
    return fact ? structuredClone(fact) : null;
  }

  async findFacts(filter: FactFilter & PaginationOptions = {}): Promise<SemanticFact[]> {
    const { theme_id, entity_id, tags, exclude_tags, include_invalidated = false, limit = 100, offset = 0 } = filter;
    let results = [...this.facts.values()];

    if (!include_invalidated) {
      results = results.filter((f) => !f.invalidated_by);
    }
    if (theme_id) {
      results = results.filter((f) => f.theme_id === theme_id);
    }
    if (entity_id) {
      results = results.filter((f) => f.entity_ids.includes(entity_id));
    }
    if (tags && tags.length > 0) {
      const wanted = new Set(tags);
      results = results.filter((f) => f.tags.some((t) => wanted.has(t)));
    }
    if (exclude_tags && exclude_tags.length > 0) {
      const unwanted = new Set(exclude_tags);
      results = results.filter((f) => !(f.tags ?? []).some((t) => unwanted.has(t)));
    }

    // Map iteration is insertion-ordered, so pagination here is already
    // deterministic. (The DB-backed store applies an explicit ORDER BY to get
    // the same stability — see drizzle-memory-store.findFacts.)
    return results.slice(offset, offset + limit).map((f) => structuredClone(f));
  }

  async deleteFact(id: string): Promise<boolean> {
    return this.facts.delete(id);
  }

  // ── Theme Operations ──

  async putTheme(theme: Theme): Promise<void> {
    this.themes.set(theme.id, structuredClone(theme));
  }

  async getTheme(id: string): Promise<Theme | null> {
    const theme = this.themes.get(id);
    return theme ? structuredClone(theme) : null;
  }

  async listThemes(): Promise<Theme[]> {
    return [...this.themes.values()].map((t) => structuredClone(t));
  }

  async deleteTheme(id: string): Promise<boolean> {
    return this.themes.delete(id);
  }

  // ── Batch Operations ──

  async getEntities(ids: string[]): Promise<Map<string, Entity>> {
    const result = new Map<string, Entity>();
    for (const id of ids) {
      const entity = this.entities.get(id);
      if (entity) result.set(id, structuredClone(entity));
    }
    return result;
  }

  async getFacts(ids: string[]): Promise<Map<string, SemanticFact>> {
    const result = new Map<string, SemanticFact>();
    for (const id of ids) {
      const fact = this.facts.get(id);
      if (fact) result.set(id, structuredClone(fact));
    }
    return result;
  }

  async getEpisodes(ids: string[]): Promise<Map<string, Episode>> {
    const result = new Map<string, Episode>();
    for (const id of ids) {
      const episode = this.episodes.get(id);
      if (episode) result.set(id, structuredClone(episode));
    }
    return result;
  }

  async getThemes(ids: string[]): Promise<Map<string, Theme>> {
    const result = new Map<string, Theme>();
    for (const id of ids) {
      const theme = this.themes.get(id);
      if (theme) result.set(id, structuredClone(theme));
    }
    return result;
  }

  // ── Lifecycle ──

  async clear(): Promise<void> {
    this.entities.clear();
    this.relationships.clear();
    this.episodes.clear();
    this.facts.clear();
    this.themes.clear();
    this.entityRelationships.clear();
  }

  // ── Internal Index Management ──

  private indexRelationship(rel: Relationship): void {
    for (const entityId of [rel.source_id, rel.target_id]) {
      let set = this.entityRelationships.get(entityId);
      if (!set) {
        set = new Set();
        this.entityRelationships.set(entityId, set);
      }
      set.add(rel.id);
    }
  }

  private deindexRelationship(rel: Relationship): void {
    for (const entityId of [rel.source_id, rel.target_id]) {
      const set = this.entityRelationships.get(entityId);
      if (set) {
        set.delete(rel.id);
        if (set.size === 0) this.entityRelationships.delete(entityId);
      }
    }
  }
}
