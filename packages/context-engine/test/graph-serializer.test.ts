/**
 * Unit tests for serializeGraph and createGraphSerializerStage
 * (memory/graph/serializer).
 */

import { describe, it, expect } from 'vitest';
import { serializeGraph, createGraphSerializerStage } from '../src/memory/graph/serializer.js';
import { ENTITIES, RELATIONSHIPS } from './fixtures/memory-hierarchy.js';
import type { GraphEntity, GraphRelationship } from '../src/memory/hierarchy/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

function graphSegment(content: string) {
  return seg('g', content, 'memory', { metadata: { contentType: 'graph' } });
}

describe('serializeGraph', () => {
  it('returns an empty string for empty inputs', () => {
    expect(serializeGraph([], [])).toBe('');
  });

  it('renders uniform entity types as a table with @-prefixed columns', () => {
    const persons = ENTITIES.filter(e => e.entity_type === 'person' && !e.invalidated_at);

    const result = serializeGraph(persons, [], { mode: 'tabular' });

    expect(result).toContain('@name');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  it('resolves relationship endpoints to entity names', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS);

    expect(result).toContain('Alice');
    expect(result).toContain('leads');
    expect(result).toContain('cycgraph Platform');
  });

  it('excludes invalidated entities by default', () => {
    expect(serializeGraph(ENTITIES, RELATIONSHIPS)).not.toContain('Legacy Service');
  });

  it('includes invalidated entities when includeInvalidated is set', () => {
    expect(serializeGraph(ENTITIES, RELATIONSHIPS, { includeInvalidated: true })).toContain('Legacy Service');
  });

  it('excludes expired relationships by default', () => {
    expect(serializeGraph(ENTITIES, RELATIONSHIPS)).not.toContain('maintained');
  });

  it('includes expired relationships when includeExpired is set', () => {
    expect(serializeGraph(ENTITIES, RELATIONSHIPS, { includeExpired: true })).toContain('maintained');
  });

  it('formats adjacency mode as "name (type): edges"', () => {
    const result = serializeGraph(ENTITIES, RELATIONSHIPS, { mode: 'adjacency' });

    expect(result).toContain('Alice (person)');
    expect(result).toContain('->');
  });

  it('quotes multi-word cells in tabular mode', () => {
    const entities: GraphEntity[] = [
      { id: 'e1', name: 'Alice Johnson', entity_type: 'person', attributes: { role: 'staff engineer' } },
      { id: 'e2', name: 'Bob', entity_type: 'person', attributes: { role: 'writer' } },
    ];
    const rels: GraphRelationship[] = [
      { id: 'r1', source_id: 'e1', target_id: 'e2', relation_type: 'mentors', weight: 0.9, attributes: {}, valid_from: new Date('2026-01-01') },
    ];

    const result = serializeGraph(entities, rels, { mode: 'tabular' });

    expect(result).toContain('"Alice Johnson" mentors Bob 0.9');
    expect(result).toContain('"staff engineer"');
  });

  it('falls back to adjacency when a multi-entity type group has ragged attribute keys', () => {
    const entities: GraphEntity[] = [
      { id: 'p1', name: 'Alice', entity_type: 'person', attributes: { role: 'eng' } },
      { id: 'p2', name: 'Bob', entity_type: 'person', attributes: { role: 'writer' } },
      { id: 's1', name: 'ServiceA', entity_type: 'service', attributes: { lang: 'ts' } },
      { id: 's2', name: 'ServiceB', entity_type: 'service', attributes: { region: 'us-east' } },
    ];

    const result = serializeGraph(entities, []);

    expect(result).toContain('lang=ts');
    expect(result).toContain('region=us-east');
    expect(result).not.toContain('@name');
  });

  it('does not treat attribute keys containing a comma as colliding', () => {
    const entities: GraphEntity[] = [
      { id: 'x1', name: 'X1', entity_type: 't', attributes: { 'a,b': 1 } },
      { id: 'x2', name: 'X2', entity_type: 't', attributes: { a: 2, b: 3 } },
    ];

    const result = serializeGraph(entities, []);

    expect(result).toContain('a=2');
    expect(result).toContain('b=3');
  });

  it('uses adjacency when the only uniform group has zero attributes', () => {
    const entities: GraphEntity[] = [
      { id: 'a', name: 'Anon A', entity_type: 'node', attributes: {} },
      { id: 'b', name: 'Anon B', entity_type: 'node', attributes: {} },
    ];

    const result = serializeGraph(entities, []);

    expect(result).toContain('Anon A (node)');
    expect(result).not.toContain('@name');
  });

  it('falls back to raw ids for tabular relationship endpoints missing from the entity set', () => {
    const entities: GraphEntity[] = [
      { id: 'p1', name: 'Alice', entity_type: 'person', attributes: { role: 'eng' } },
      { id: 'p2', name: 'Bob', entity_type: 'person', attributes: { role: 'writer' } },
    ];
    const rels: GraphRelationship[] = [
      { id: 'r1', source_id: 'ghost-src', target_id: 'ghost-tgt', relation_type: 'links', weight: 1, attributes: {}, valid_from: new Date('2026-01-01') },
    ];

    const result = serializeGraph(entities, rels, { mode: 'tabular' });

    expect(result).toContain('ghost-src links ghost-tgt 1');
  });

  it('falls back to raw ids for adjacency edge targets missing from the entity set', () => {
    const entities: GraphEntity[] = [
      { id: 'a', name: 'Alice', entity_type: 'person', attributes: { role: 'eng' } },
    ];
    const rels: GraphRelationship[] = [
      { id: 'r1', source_id: 'a', target_id: 'ghost-tgt', relation_type: 'knows', weight: 1, attributes: {}, valid_from: new Date('2026-01-01') },
    ];

    const result = serializeGraph(entities, rels, { mode: 'adjacency' });

    expect(result).toContain('knows -> ghost-tgt');
  });

  it('caps adjacency output at ten times maxEntitiesPerType', () => {
    const entities: GraphEntity[] = Array.from({ length: 11 }, (_, i) => ({
      id: `e${i}`, name: `E${i}`, entity_type: 'node', attributes: {},
    }));

    const result = serializeGraph(entities, [], { mode: 'adjacency', maxEntitiesPerType: 1 });

    expect(result.split('\n')).toHaveLength(10);
  });

  it('omits the attribute clause for adjacency entities with no attributes', () => {
    const entities: GraphEntity[] = [
      { id: 'a', name: 'Alice', entity_type: 'person', attributes: {} },
    ];

    const result = serializeGraph(entities, [], { mode: 'adjacency' });

    expect(result).toBe('Alice (person)');
  });

  it('renders null attributes as "_" and Date attributes as an ISO date', () => {
    const entities: GraphEntity[] = [
      { id: 'a', name: 'Alice', entity_type: 'person', attributes: { missing: null, joined: new Date('2026-01-15') } },
    ];

    const result = serializeGraph(entities, [], { mode: 'adjacency' });

    expect(result).toContain('missing=_');
    expect(result).toContain('joined=2026-01-15');
  });

  it('respects maxEntitiesPerType in tabular mode', () => {
    const persons = ENTITIES.filter(e => e.entity_type === 'person' && !e.invalidated_at);

    const result = serializeGraph(persons, [], { maxEntitiesPerType: 1, mode: 'tabular' });

    const dataLines = result.split('\n').filter(l => !l.startsWith('@') && !l.startsWith('Entities') && l.trim().length > 0);
    expect(dataLines).toHaveLength(1);
  });

  it('produces fewer tokens than pretty JSON', () => {
    const json = JSON.stringify({ entities: ENTITIES, relationships: RELATIONSHIPS }, null, 2);
    const formatted = serializeGraph(ENTITIES, RELATIONSHIPS);

    expect(counter.countTokens(formatted)).toBeLessThan(counter.countTokens(json));
  });
});

describe('createGraphSerializerStage', () => {
  it('names the stage graph-serializer', () => {
    expect(createGraphSerializerStage().name).toBe('graph-serializer');
  });

  it('serializes segments whose metadata contentType is graph', () => {
    const stage = createGraphSerializerStage();
    const content = JSON.stringify({ entities: ENTITIES, relationships: RELATIONSHIPS });

    const result = stage.execute([graphSegment(content)], makeContext());

    expect(result.segments[0].content).toContain('Alice');
    expect(result.segments[0].content).not.toContain('"entities"');
  });

  it('passes through segments without the graph contentType', () => {
    const stage = createGraphSerializerStage();

    const result = stage.execute([seg('plain', 'just text')], makeContext());

    expect(result.segments[0].content).toBe('just text');
  });

  it('defaults missing entities and relationships to empty', () => {
    const stage = createGraphSerializerStage();

    const result = stage.execute([graphSegment('{}')], makeContext());

    expect(result.segments[0].content).toBe('');
  });

  it('passes through graph segments whose content is invalid JSON', () => {
    const stage = createGraphSerializerStage();
    const broken = graphSegment('not json {');

    const result = stage.execute([broken], makeContext());

    expect(result.segments[0].content).toBe('not json {');
  });
});
