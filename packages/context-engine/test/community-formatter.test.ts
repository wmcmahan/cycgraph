/**
 * Unit tests for formatCommunities and createCommunityFormatterStage
 * (memory/graph/community-formatter).
 */

import { describe, it, expect } from 'vitest';
import { formatCommunities, createCommunityFormatterStage } from '../src/memory/graph/community-formatter.js';
import { COMMUNITIES } from './fixtures/memory-hierarchy.js';
import type { CommunitySummary } from '../src/memory/hierarchy/types.js';
import { seg, makeContext } from './helpers.js';

function communitySegment(content: string) {
  return seg('c', content, 'memory', { metadata: { contentType: 'community' } });
}

describe('formatCommunities', () => {
  it('lists community labels and summaries under a Communities header', () => {
    const result = formatCommunities(COMMUNITIES);

    expect(result).toContain('Communities:');
    expect(result).toContain('Platform Engineering Team');
    expect(result).toContain('API Architecture');
  });

  it('annotates each community with its level and entity count', () => {
    const result = formatCommunities(COMMUNITIES);

    expect(result).toContain('level 1, 4 entities');
    expect(result).toContain('level 2, 2 entities');
  });

  it('orders communities by descending weight by default', () => {
    const result = formatCommunities(COMMUNITIES);

    expect(result.indexOf('Platform Engineering Team')).toBeLessThan(result.indexOf('API Architecture'));
  });

  it('preserves input order when sortByRelevance is false', () => {
    const communities: CommunitySummary[] = [
      { id: 'low', label: 'Low Weight', summary: 's', entity_ids: [], level: 1, weight: 0.1 },
      { id: 'high', label: 'High Weight', summary: 's', entity_ids: [], level: 1, weight: 0.9 },
    ];

    const result = formatCommunities(communities, { sortByRelevance: false });

    expect(result.indexOf('Low Weight')).toBeLessThan(result.indexOf('High Weight'));
  });

  it('treats communities without a weight as weight zero when sorting', () => {
    const communities: CommunitySummary[] = [
      { id: 'a', label: 'No Weight A', summary: 's', entity_ids: [], level: 1 },
      { id: 'b', label: 'No Weight B', summary: 's', entity_ids: [], level: 1 },
    ];

    const result = formatCommunities(communities);

    expect(result).toContain('No Weight A');
    expect(result).toContain('No Weight B');
  });

  it('filters out communities above maxLevel', () => {
    const result = formatCommunities(COMMUNITIES, { maxLevel: 1 });

    expect(result).toContain('Platform Engineering Team');
    expect(result).not.toContain('API Architecture');
  });

  it('caps the number of communities at maxCommunities', () => {
    const result = formatCommunities(COMMUNITIES, { maxCommunities: 1 });

    expect(result).toContain('Platform Engineering Team');
    expect(result).not.toContain('API Architecture');
  });

  it('truncates summaries longer than maxSummaryLength with an ellipsis', () => {
    const result = formatCommunities(COMMUNITIES, { maxSummaryLength: 30 });

    expect(result).toContain('...');
  });

  it('returns an empty string when no communities remain', () => {
    expect(formatCommunities([])).toBe('');
  });
});

describe('createCommunityFormatterStage', () => {
  it('names the stage community-formatter', () => {
    expect(createCommunityFormatterStage().name).toBe('community-formatter');
  });

  it('formats segments whose metadata contentType is community', () => {
    const stage = createCommunityFormatterStage();

    const result = stage.execute([communitySegment(JSON.stringify(COMMUNITIES))], makeContext());

    expect(result.segments[0].content).toContain('Communities:');
  });

  it('passes through segments without the community contentType', () => {
    const stage = createCommunityFormatterStage();

    const result = stage.execute([seg('plain', 'just text')], makeContext());

    expect(result.segments[0].content).toBe('just text');
  });

  it('passes through community segments whose content is invalid JSON', () => {
    const stage = createCommunityFormatterStage();
    const broken = communitySegment('not json {');

    const result = stage.execute([broken], makeContext());

    expect(result.segments[0].content).toBe('not json {');
  });
});
