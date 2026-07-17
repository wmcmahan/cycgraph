import { describe, it, expect } from 'vitest';
import { serializeGraph, createGraphSerializerStage } from '../src/memory/graph/serializer.js';
import { ENTITIES, RELATIONSHIPS } from './fixtures/memory-hierarchy.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';

const counter = new DefaultTokenCounter();

describe('serializeGraph', () => {
  it('auto-detects tabular mode for uniform entity types', () => {
    // Person entities have uniform attributes
    const persons = ENTITIES.filter(e => e.entity_type === 'person' && !e.invalidated_at);
    const result = serializeGraph(persons, [], { mode: 'tabular' });
    expect(result).toContain('@name');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  it('serializes relationships with entity names', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS);
    expect(result).toContain('Alice');
    expect(result).toContain('leads');
    expect(result).toContain('cycgraph Platform');
  });

  it('filters invalidated entities by default', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS);
    expect(result).not.toContain('Legacy Service');
  });

  it('includes invalidated entities when requested', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS, { includeInvalidated: true });
    expect(result).toContain('Legacy Service');
  });

  it('filters expired relationships by default', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS);
    expect(result).not.toContain('maintained');
  });

  it('adjacency mode formats as name (type): edges', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS, { mode: 'adjacency' });
    expect(result).toContain('Alice (person)');
    expect(result).toContain('->');
  });

  it('handles empty inputs', () => {
    expect(serializeGraph([], [])).toBe('');
  });

  it('quotes entity names containing spaces in tabular cells', () => {
    const entities = [
      { id: 'e1', name: 'Alice Johnson', entity_type: 'person', attributes: { role: 'staff engineer' } },
      { id: 'e2', name: 'Bob', entity_type: 'person', attributes: { role: 'writer' } },
    ];
    const rels = [{
      id: 'r1', source_id: 'e1', target_id: 'e2', relation_type: 'mentors',
      weight: 0.9, attributes: {}, valid_from: new Date(),
    }];
    const result = serializeGraph(entities, rels, { mode: 'tabular' });

    // Multi-word cells must be quoted or every following column misaligns
    expect(result).toContain('"Alice Johnson"');
    expect(result).toContain('"staff engineer"');
    expect(result).toContain('"Alice Johnson" mentors Bob 0.9');
  });

  it('falls back to lossless adjacency when any multi-entity group is ragged', () => {
    const entities = [
      // Uniform group would previously force tabular for ALL groups...
      { id: 'p1', name: 'Alice', entity_type: 'person', attributes: { role: 'eng' } },
      { id: 'p2', name: 'Bob', entity_type: 'person', attributes: { role: 'writer' } },
      // ...silently dropping this group's non-first-entity attributes
      { id: 's1', name: 'ServiceA', entity_type: 'service', attributes: { lang: 'ts' } },
      { id: 's2', name: 'ServiceB', entity_type: 'service', attributes: { region: 'us-east' } },
    ];
    const result = serializeGraph(entities, []);

    // Adjacency preserves every attribute
    expect(result).toContain('lang=ts');
    expect(result).toContain('region=us-east');
    expect(result).not.toContain('@name');
  });

  it('does not collide attribute keys containing the old join delimiter', () => {
    const entities = [
      { id: 'x1', name: 'X1', entity_type: 't', attributes: { 'a,b': 1 } },
      { id: 'x2', name: 'X2', entity_type: 't', attributes: { a: 2, b: 3 } },
    ];
    // Ragged group (different real key sets) → adjacency, nothing dropped
    const result = serializeGraph(entities, []);
    expect(result).toContain('a=2');
    expect(result).toContain('b=3');
  });

  it('respects maxEntitiesPerType in tabular mode', () => {
    const persons = ENTITIES.filter(e => e.entity_type === 'person' && !e.invalidated_at);
    const result = serializeGraph(persons, [], { maxEntitiesPerType: 1, mode: 'tabular' });
    // Header + 1 data row only (not both Alice and Bob)
    const dataLines = result.split('\n').filter(l => !l.startsWith('@') && !l.startsWith('Entities') && l.trim().length > 0);
    expect(dataLines.length).toBeLessThanOrEqual(1);
  });

  it('produces fewer tokens than JSON.stringify', () => {
    const json = JSON.stringify({ entities: ENTITIES, relationships: RELATIONSHIPS }, null, 2);
    const formatted = serializeGraph(ENTITIES, RELATIONSHIPS);

    const jsonTokens = counter.countTokens(json);
    const formattedTokens = counter.countTokens(formatted);
    expect(formattedTokens).toBeLessThan(jsonTokens);
  });
});

describe('createGraphSerializerStage', () => {
  it('formats segments with contentType graph', () => {
    const stage = createGraphSerializerStage();
    const content = JSON.stringify({ entities: ENTITIES, relationships: RELATIONSHIPS });
    const segments: PromptSegment[] = [{
      id: 'g', content, role: 'memory', priority: 1, locked: false,
      metadata: { contentType: 'graph' },
    }];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('Alice');
    expect(result.segments[0].content).not.toContain('"entities"');
  });

  it('has name graph-serializer', () => {
    expect(createGraphSerializerStage().name).toBe('graph-serializer');
  });
});
