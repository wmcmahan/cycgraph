/**
 * Unit tests for formatHierarchy and createHierarchyFormatterStage
 * (memory/hierarchy/hierarchy-formatter).
 */

import { describe, it, expect } from 'vitest';
import { formatHierarchy, createHierarchyFormatterStage } from '../src/memory/hierarchy/hierarchy-formatter.js';
import { FULL_MEMORY_PAYLOAD } from './fixtures/memory-hierarchy.js';
import type { MemoryPayload } from '../src/memory/hierarchy/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

function hierarchySegment(payload: unknown) {
  return seg('mem', JSON.stringify(payload), 'memory', { metadata: { contentType: 'hierarchy' } });
}

describe('formatHierarchy', () => {
  it('groups facts under their theme labels', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result).toContain('System Architecture');
    expect(result).toContain('graph-based workflow engine');
    expect(result).toContain('Team & People');
    expect(result).toContain('Alice is the lead engineer');
  });

  it('annotates facts with their valid-from date', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result).toContain('2026-01-15');
    expect(result).toContain('2026-03-01');
  });

  it('lists facts with no theme under Ungrouped Facts', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result).toContain('Ungrouped Facts');
    expect(result).toContain('CI pipeline runs in under 3 minutes');
  });

  it('orders multiple ungrouped facts most-recent first', () => {
    const payload: MemoryPayload = {
      facts: [
        { id: 'old', content: 'older orphan', source_episode_ids: [], entity_ids: [], valid_from: new Date('2026-01-01') },
        { id: 'new', content: 'newer orphan', source_episode_ids: [], entity_ids: [], valid_from: new Date('2026-05-01') },
      ],
    };

    const result = formatHierarchy(payload);

    expect(result.indexOf('newer orphan')).toBeLessThan(result.indexOf('older orphan'));
  });

  it('renders a validity range when a fact has valid_until', () => {
    const payload: MemoryPayload = {
      themes: [{ id: 't', label: 'Temporal', description: '', fact_ids: ['f'] }],
      facts: [{
        id: 'f', content: 'expired fact', source_episode_ids: [], entity_ids: [], theme_id: 't',
        valid_from: new Date('2026-01-01'), valid_until: new Date('2026-06-01'),
      }],
    };

    const result = formatHierarchy(payload);

    expect(result).toContain('expired fact (2026-01-01 – 2026-06-01)');
  });

  it('accepts string dates on facts including valid_until', () => {
    const payload = {
      themes: [{ id: 't', label: 'Temporal', description: '', fact_ids: ['f'] }],
      facts: [{
        id: 'f', content: 'string dated', source_episode_ids: [], entity_ids: [], theme_id: 't',
        valid_from: '2026-02-01', valid_until: '2026-04-01',
      }],
    } as unknown as MemoryPayload;

    const result = formatHierarchy(payload);

    expect(result).toContain('string dated (2026-02-01 – 2026-04-01)');
  });

  it('accepts string dates on episodes', () => {
    const payload = {
      episodes: [{
        id: 'ep', topic: 'string episode',
        messages: [{ role: 'user', content: 'hi', timestamp: '2026-01-01T10:00:00Z' }],
        started_at: '2026-01-01T10:00:00Z', ended_at: '2026-01-01T10:05:00Z', fact_ids: [],
      }],
    } as unknown as MemoryPayload;

    const result = formatHierarchy(payload);

    expect(result).toContain('string episode (2026-01-01 10:00 – 2026-01-01 10:05, 1 msgs, 0 facts)');
  });

  it('summarizes episodes with message and fact counts', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result).toContain('Recent Episodes');
    expect(result).toContain('Architecture design review');
    expect(result).toContain('4 msgs');
    expect(result).toContain('2 facts');
  });

  it('orders episodes most-recent first', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result.indexOf('Cost optimization research')).toBeLessThan(result.indexOf('Architecture design review'));
  });

  it('omits episode messages by default', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD);

    expect(result).not.toContain('[user]');
    expect(result).not.toContain('[assistant]');
  });

  it('includes episode messages when includeMessages is set', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD, { includeMessages: true });

    expect(result).toContain('[user]');
    expect(result).toContain('[assistant]');
  });

  it('caps episodes at maxEpisodes', () => {
    const result = formatHierarchy(FULL_MEMORY_PAYLOAD, { maxEpisodes: 2 });

    const episodeSection = result.slice(result.indexOf('Recent Episodes'));
    const matches = episodeSection.match(/^\s{2}- /gm);
    expect(matches?.length).toBeLessThanOrEqual(2);
  });

  it('skips themes with no matching facts by default', () => {
    const payload: MemoryPayload = {
      themes: [{ id: 'empty', label: 'Empty Theme', description: 'No facts', fact_ids: ['nonexistent'] }],
      facts: [],
    };

    expect(formatHierarchy(payload)).not.toContain('Empty Theme');
  });

  it('shows empty themes when skipEmptyThemes is false', () => {
    const payload: MemoryPayload = {
      themes: [{ id: 'empty', label: 'Empty Theme', description: 'No facts', fact_ids: ['nonexistent'] }],
      facts: [],
    };

    expect(formatHierarchy(payload, { skipEmptyThemes: false })).toContain('Empty Theme');
  });

  it('returns an empty string for an empty payload', () => {
    expect(formatHierarchy({})).toBe('');
  });

  it('produces at least 40% fewer tokens than pretty JSON', () => {
    const json = JSON.stringify(FULL_MEMORY_PAYLOAD, null, 2);
    const formatted = formatHierarchy(FULL_MEMORY_PAYLOAD);

    const reduction = ((counter.countTokens(json) - counter.countTokens(formatted)) / counter.countTokens(json)) * 100;

    expect(reduction).toBeGreaterThanOrEqual(40);
  });
});

describe('createHierarchyFormatterStage', () => {
  it('names the stage hierarchy-formatter', () => {
    expect(createHierarchyFormatterStage().name).toBe('hierarchy-formatter');
  });

  it('formats segments whose metadata contentType is hierarchy', () => {
    const stage = createHierarchyFormatterStage();

    const result = stage.execute([hierarchySegment(FULL_MEMORY_PAYLOAD)], makeContext());

    expect(result.segments[0].content).toContain('Themes:');
    expect(result.segments[0].content).not.toContain('"themes"');
  });

  it('passes through segments without the hierarchy contentType', () => {
    const stage = createHierarchyFormatterStage();

    const result = stage.execute([seg('other', 'plain text')], makeContext());

    expect(result.segments[0].content).toBe('plain text');
  });

  it('passes through hierarchy segments whose content is invalid JSON', () => {
    const stage = createHierarchyFormatterStage();
    const broken = seg('mem', 'not json {', 'memory', { metadata: { contentType: 'hierarchy' } });

    const result = stage.execute([broken], makeContext());

    expect(result.segments[0].content).toBe('not json {');
  });

  it('revives numeric fact timestamps and string valid_until dates', () => {
    const stage = createHierarchyFormatterStage();
    const payload = {
      themes: [{ id: 't', label: 'T', description: '', fact_ids: ['f'] }],
      facts: [{
        id: 'f', content: 'numeric from', source_episode_ids: [], entity_ids: [], theme_id: 't',
        valid_from: new Date('2026-02-01').getTime(), valid_until: '2026-05-01',
      }],
    };

    const result = stage.execute([hierarchySegment(payload)], makeContext());

    expect(result.segments[0].content).toContain('numeric from (2026-02-01 – 2026-05-01)');
  });

  it('revives numeric episode and message timestamps', () => {
    const stage = createHierarchyFormatterStage();
    const payload = {
      episodes: [{
        id: 'ep', topic: 'numeric episode',
        messages: [{ role: 'user', content: 'hi', timestamp: new Date('2026-01-01T10:00:00Z').getTime() }],
        started_at: new Date('2026-01-01T10:00:00Z').getTime(),
        ended_at: new Date('2026-01-01T10:05:00Z').getTime(),
        fact_ids: [],
      }],
    };

    const result = stage.execute([hierarchySegment(payload)], makeContext());

    expect(result.segments[0].content).toContain('numeric episode (2026-01-01 10:00 – 2026-01-01 10:05, 1 msgs, 0 facts)');
  });

  it('formats hierarchy content that has themes but no facts or episodes', () => {
    const stage = createHierarchyFormatterStage({ skipEmptyThemes: false });
    const payload = { themes: [{ id: 't', label: 'Lonely Theme', description: '', fact_ids: [] }] };

    const result = stage.execute([hierarchySegment(payload)], makeContext());

    expect(result.segments[0].content).toContain('Lonely Theme');
  });
});
