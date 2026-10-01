/**
 * Tests for the pull-request wire format (src/shared/pr-wire.ts).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PR_WIRE, WORKFLOW_MENTION, allMentions, assertPrWire, markerNamespacePattern, stripMentions } from '../src/shared/pr-wire.js';
import type { PrWire } from '../src/shared/pr-wire.js';

const KEELWISE: PrWire = {
  markerNamespace: 'keelwise',
  legacyMarkerNamespaces: ['cycgraph'],
  mention: '@keelwise',
  legacyMentions: ['@cycgraph'],
};

describe('assertPrWire', () => {
  it('accepts this repository\'s wire format', () => {
    expect(() => assertPrWire(DEFAULT_PR_WIRE)).not.toThrow();
  });

  it('accepts a renamed wire format with legacy values', () => {
    expect(() => assertPrWire(KEELWISE)).not.toThrow();
  });

  it('rejects a namespace that could close the HTML comment', () => {
    expect(() => assertPrWire({ ...KEELWISE, markerNamespace: 'x -->' })).toThrow('invalid PR marker namespace: "x -->"');
  });

  it('rejects an invalid legacy namespace', () => {
    expect(() => assertPrWire({ ...KEELWISE, legacyMarkerNamespaces: ['Bad Space'] })).toThrow('invalid PR marker namespace: "Bad Space"');
  });

  it('rejects a mention without its at sign', () => {
    expect(() => assertPrWire({ ...KEELWISE, mention: 'keelwise' })).toThrow('invalid workflow mention: "keelwise"');
  });

  it('rejects a legacy mention that is not a single handle', () => {
    expect(() => assertPrWire({ ...KEELWISE, legacyMentions: ['@a b'] })).toThrow('invalid workflow mention: "@a b"');
  });
});

describe('markerNamespacePattern', () => {
  it('lists the current namespace before the legacy ones', () => {
    expect(markerNamespacePattern(KEELWISE)).toBe('keelwise|cycgraph');
  });

  it('escapes a dot so it matches only itself', () => {
    expect(markerNamespacePattern({ ...KEELWISE, markerNamespace: 'acme.bot', legacyMarkerNamespaces: [] })).toBe('acme\\.bot');
  });
});

describe('allMentions', () => {
  it('lists the current mention before the legacy ones', () => {
    expect(allMentions(KEELWISE)).toEqual(['@keelwise', '@cycgraph']);
  });
});

describe('stripMentions', () => {
  it('neutralizes the workflow-dispatching mention', () => {
    const stripped = stripMentions(`${WORKFLOW_MENTION} please review`);

    expect(stripped).toBe('cycgraph please review');
  });

  it('neutralizes the mention in mixed case', () => {
    const stripped = stripMentions('@CycGraph please run');

    expect(stripped).toBe('cycgraph please run');
  });

  it('neutralizes every occurrence', () => {
    const stripped = stripMentions('@cycgraph and @cycgraph again');

    expect(stripped).toBe('cycgraph and cycgraph again');
  });

  it('preserves punctuation trailing the mention', () => {
    const stripped = stripMentions('@cycgraph, address the findings.');

    expect(stripped).toBe('cycgraph, address the findings.');
  });

  it('neutralizes a mention embedded mid-sentence', () => {
    const stripped = stripMentions('the reviewer asked @cycgraph to revise');

    expect(stripped).toBe('the reviewer asked cycgraph to revise');
  });

  it('returns text without the mention unchanged', () => {
    const stripped = stripMentions('the tests are exact and comment-free');

    expect(stripped).toBe('the tests are exact and comment-free');
  });

  it('returns the empty string unchanged', () => {
    const stripped = stripMentions('');

    expect(stripped).toBe('');
  });

  it('neutralizes a custom mention and a legacy one', () => {
    const stripped = stripMentions('@keelwise fix it, @cycgraph too', KEELWISE);

    expect(stripped).toBe('keelwise fix it, cycgraph too');
  });

  it('leaves the default mention alone under a wire that does not list it', () => {
    const stripped = stripMentions('@cycgraph stays', { ...KEELWISE, legacyMentions: [] });

    expect(stripped).toBe('@cycgraph stays');
  });
});
