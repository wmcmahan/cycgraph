import { describe, it, expect } from 'vitest';
import {
  ProvenanceSchema,
  EntitySchema,
  RelationshipSchema,
  MessageSchema,
  EpisodeSchema,
  SemanticFactSchema,
  ThemeSchema,
  MemoryQuerySchema,
  MemoryResultSchema,
} from '../src/index.js';

const now = new Date();
const uuid = () => crypto.randomUUID();

const provenance = { source: 'agent' as const, created_at: now };

describe('ProvenanceSchema', () => {
  it('parses valid provenance', () => {
    const result = ProvenanceSchema.parse({
      source: 'tool',
      tool_name: 'web_search',
      created_at: now.toISOString(),
    });
    expect(result.source).toBe('tool');
    expect(result.created_at).toBeInstanceOf(Date);
  });

  it('rejects invalid source', () => {
    expect(() => ProvenanceSchema.parse({ source: 'invalid', created_at: now })).toThrow();
  });

  it('coerces date strings', () => {
    const result = ProvenanceSchema.parse({ source: 'human', created_at: '2024-01-01' });
    expect(result.created_at).toBeInstanceOf(Date);
  });
});

describe('EntitySchema', () => {
  it('parses valid entity with defaults', () => {
    const result = EntitySchema.parse({
      id: uuid(),
      name: 'Alice',
      entity_type: 'person',
      provenance,
      created_at: now,
      updated_at: now,
    });
    expect(result.attributes).toEqual({});
    expect(result.embedding).toBeUndefined();
    expect(result.invalidated_at).toBeUndefined();
  });

  it('rejects empty name', () => {
    expect(() => EntitySchema.parse({
      id: uuid(), name: '', entity_type: 'person', provenance, created_at: now, updated_at: now,
    })).toThrow();
  });
});

describe('RelationshipSchema', () => {
  it('parses with defaults', () => {
    const result = RelationshipSchema.parse({
      id: uuid(),
      source_id: uuid(),
      target_id: uuid(),
      relation_type: 'works_at',
      valid_from: now,
      provenance,
    });
    expect(result.weight).toBe(1);
    expect(result.attributes).toEqual({});
    expect(result.valid_until).toBeUndefined();
  });

  it('rejects weight out of range', () => {
    expect(() => RelationshipSchema.parse({
      id: uuid(), source_id: uuid(), target_id: uuid(),
      relation_type: 'x', weight: 1.5, valid_from: now, provenance,
    })).toThrow();
  });
});

describe('MessageSchema', () => {
  it('parses valid message', () => {
    const result = MessageSchema.parse({
      id: uuid(), role: 'user', content: 'Hello', timestamp: now,
    });
    expect(result.metadata).toEqual({});
  });
});

describe('EpisodeSchema', () => {
  it('parses with defaults', () => {
    const msg = { id: uuid(), role: 'user' as const, content: 'Hi', timestamp: now };
    const result = EpisodeSchema.parse({
      id: uuid(), topic: 'Greeting', messages: [msg],
      started_at: now, ended_at: now, provenance,
    });
    expect(result.fact_ids).toEqual([]);
  });
});

describe('SemanticFactSchema', () => {
  it('parses with defaults', () => {
    const result = SemanticFactSchema.parse({
      id: uuid(), content: 'Alice works at Acme',
      provenance, valid_from: now,
    });
    expect(result.source_episode_ids).toEqual([]);
    expect(result.entity_ids).toEqual([]);
  });

  it('rejects empty content', () => {
    expect(() => SemanticFactSchema.parse({
      id: uuid(), content: '', provenance, valid_from: now,
    })).toThrow();
  });
});

describe('ThemeSchema', () => {
  it('parses with defaults', () => {
    const result = ThemeSchema.parse({
      id: uuid(), label: 'Team', provenance,
    });
    expect(result.description).toBe('');
    expect(result.fact_ids).toEqual([]);
  });
});

describe('MemoryQuerySchema', () => {
  it('applies defaults', () => {
    const result = MemoryQuerySchema.parse({});
    expect(result.maxHops).toBe(2);
    expect(result.limit).toBe(20);
    expect(result.minSimilarity).toBe(0.5);
    expect(result.includeInvalidated).toBe(false);
  });

  it('rejects maxHops > 5', () => {
    expect(() => MemoryQuerySchema.parse({ maxHops: 6 })).toThrow();
  });
});

describe('MemoryResultSchema', () => {
  it('parses empty result with defaults', () => {
    const result = MemoryResultSchema.parse({});
    expect(result.themes).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.episodes).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });
});
