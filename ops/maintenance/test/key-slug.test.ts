/**
 * Tests for the ledger-key slug (src/key-slug.ts) — normalization and
 * the truncation boundary two long findings must not collide across.
 */

import { describe, it, expect } from 'vitest';
import { keySlug, legacyKeySlug } from '../src/shared/key-slug.js';

const EIGHTY = 'retriever-drops-fact-ids-when-the-adapter-maps-lessons-into-the-prompt-builder-1';

describe('keySlug', () => {
  it('lowercases text and collapses punctuation runs into single dashes', () => {
    expect(keySlug('Retriever drops fact IDs!  (adapter)')).toBe('retriever-drops-fact-ids-adapter');
  });

  it('leaves text at the truncation boundary whole and undigested', () => {
    expect(EIGHTY).toHaveLength(80);
    expect(keySlug(EIGHTY)).toBe(EIGHTY);
  });

  it('keys two texts apart when they differ only past the truncation boundary', () => {
    const planner = keySlug(`${EIGHTY}-the-planner`);
    const supervisor = keySlug(`${EIGHTY}-the-supervisor`);

    expect(planner.startsWith(EIGHTY)).toBe(true);
    expect(supervisor.startsWith(EIGHTY)).toBe(true);
    expect(planner).not.toBe(supervisor);
  });

  it('bounds a truncated slug to the text limit plus a digest', () => {
    expect(keySlug(`${EIGHTY}-and-a-very-long-tail-that-goes-on-well-past-the-limit`)).toHaveLength(89);
  });

  it('is deterministic for the same text', () => {
    expect(keySlug(`${EIGHTY}-the-planner`)).toBe(keySlug(`${EIGHTY}-the-planner`));
  });

  it('does not digest a short slug into a long one', () => {
    expect(keySlug('  Batch variant, for the Memory Writer!  ')).toBe('batch-variant-for-the-memory-writer');
  });
});

describe('legacyKeySlug', () => {
  it('matches keySlug for text within the truncation boundary', () => {
    expect(legacyKeySlug(EIGHTY)).toBe(keySlug(EIGHTY));
    expect(legacyKeySlug('Retriever drops fact IDs!  (adapter)')).toBe('retriever-drops-fact-ids-adapter');
  });

  it('bare-truncates past the boundary where keySlug appends a digest', () => {
    const text = `${EIGHTY}-the-planner`;

    const legacy = legacyKeySlug(text);

    expect(legacy).toBe(EIGHTY);
    expect(legacy).toHaveLength(80);
    expect(keySlug(text)).not.toBe(legacy);
    expect(keySlug(text).startsWith(legacy)).toBe(true);
  });
});
