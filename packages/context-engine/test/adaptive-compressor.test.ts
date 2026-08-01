/**
 * Unit tests for createAdaptiveMemoryStage (memory/adaptive-compressor).
 * Covers prioritization, recency boost, truncation, and pass-through paths.
 */

import { describe, it, expect } from 'vitest';
import { createAdaptiveMemoryStage } from '../src/memory/adaptive-compressor.js';
import { seg, makeContext } from './helpers.js';

function memoryJson(payload: {
  themes?: Array<{ id: string; label: string; description: string; fact_ids: string[] }>;
  facts?: Array<{ id: string; content: string; valid_from: string; theme_id?: string;[k: string]: unknown }>;
  entities?: unknown[];
  relationships?: unknown[];
}): string {
  return JSON.stringify(payload);
}

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function factIds(content: string): string[] {
  return JSON.parse(content).facts.map((f: { id: string }) => f.id);
}

describe('createAdaptiveMemoryStage', () => {
  it('names the stage "adaptive-memory"', () => {
    expect(createAdaptiveMemoryStage().name).toBe('adaptive-memory');
  });

  it('passes non-memory segments through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const segments = [seg('s1', 'You are an assistant', 'system'), seg('u1', 'Hello', 'user')];

    const result = stage.execute(segments, makeContext());

    expect(result.segments).toEqual(segments);
  });

  it('passes locked memory segments through unchanged', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1', 'f2'] }],
      facts: [
        { id: 'f2', content: 'b', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f1', content: 'a', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });
    const locked = seg('m1', content, 'memory', { locked: true });

    const result = stage.execute([locked], makeContext());

    expect(result.segments[0]).toBe(locked);
  });

  it('passes memory segments shorter than minContentLength through unchanged', () => {
    const stage = createAdaptiveMemoryStage({ minContentLength: 1000 });
    const short = seg('m1', memoryJson({ facts: [{ id: 'f1', content: 'x', valid_from: daysAgo(1) }] }));

    const result = stage.execute([short], makeContext());

    expect(result.segments[0]).toBe(short);
  });

  it('passes invalid JSON content through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = 'this is not valid JSON {{{';

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(result.segments[0].content).toBe(content);
  });

  it('passes memory payloads lacking both themes and facts through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = JSON.stringify({ someOtherData: [1, 2, 3] });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(result.segments[0].content).toBe(content);
  });

  it('passes payloads that have themes but no facts array through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({ themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1'] }] });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(result.segments[0].content).toBe(content);
  });

  it('passes payloads with an empty facts array through unchanged', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: [] }],
      facts: [],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(JSON.parse(result.segments[0].content).facts).toHaveLength(0);
  });

  it('reorders facts so larger-theme facts precede smaller-theme facts', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [
        { id: 't1', label: 'Big', description: 'big theme', fact_ids: ['f1', 'f2', 'f3'] },
        { id: 't2', label: 'Small', description: 'small theme', fact_ids: ['f4'] },
      ],
      facts: [
        { id: 'f4', content: 'small theme fact', valid_from: daysAgo(100), theme_id: 't2' },
        { id: 'f1', content: 'big theme fact 1', valid_from: daysAgo(100), theme_id: 't1' },
        { id: 'f2', content: 'big theme fact 2', valid_from: daysAgo(100), theme_id: 't1' },
        { id: 'f3', content: 'big theme fact 3', valid_from: daysAgo(100), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content)).toEqual(['f1', 'f2', 'f3', 'f4']);
  });

  it('ranks recent facts above older facts in the same theme', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 7, recencyMultiplier: 10 });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'Theme', description: 'theme', fact_ids: ['f-old', 'f-new'] }],
      facts: [
        { id: 'f-old', content: 'old fact', valid_from: daysAgo(30), theme_id: 't1' },
        { id: 'f-new', content: 'new fact', valid_from: daysAgo(1), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content)).toEqual(['f-new', 'f-old']);
  });

  it('lets recencyMultiplier lift a recent small-theme fact above an old large-theme fact', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 7, recencyMultiplier: 100 });
    const content = memoryJson({
      themes: [
        { id: 'big', label: 'Big', description: 'big', fact_ids: ['f1', 'f2', 'f3'] },
        { id: 'small', label: 'Small', description: 'small', fact_ids: ['f4'] },
      ],
      facts: [
        { id: 'f1', content: 'old big', valid_from: daysAgo(30), theme_id: 'big' },
        { id: 'f4', content: 'new small', valid_from: daysAgo(1), theme_id: 'small' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content)).toEqual(['f4', 'f1']);
  });

  it('truncates each theme to maxFactsPerTheme facts', () => {
    const stage = createAdaptiveMemoryStage({ maxFactsPerTheme: 2, recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'Theme', description: 'theme', fact_ids: ['f1', 'f2', 'f3', 'f4'] }],
      facts: [
        { id: 'f1', content: 'fact 1', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f2', content: 'fact 2', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f3', content: 'fact 3', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f4', content: 'fact 4', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(JSON.parse(result.segments[0].content).facts).toHaveLength(2);
  });

  it('keeps every fact when the theme is under maxFactsPerTheme', () => {
    const stage = createAdaptiveMemoryStage({ maxFactsPerTheme: 10, recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1', 'f2', 'f3'] }],
      facts: [
        { id: 'f1', content: 'a', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f2', content: 'b', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f3', content: 'c', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content).sort()).toEqual(['f1', 'f2', 'f3']);
  });

  it('groups facts without a theme_id under a single ungrouped bucket', () => {
    const stage = createAdaptiveMemoryStage({ maxFactsPerTheme: 2, recencyBoostDays: 0 });
    const content = memoryJson({
      facts: [
        { id: 'f1', content: 'a', valid_from: daysAgo(10) },
        { id: 'f2', content: 'b', valid_from: daysAgo(10) },
        { id: 'f3', content: 'c', valid_from: daysAgo(10) },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(JSON.parse(result.segments[0].content).facts).toHaveLength(2);
  });

  it('scores a fact whose theme_id is absent from themes with base priority one', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [{ id: 'known', label: 'Known', description: 'd', fact_ids: ['f1'] }],
      facts: [
        { id: 'f1', content: 'known theme', valid_from: daysAgo(10), theme_id: 'known' },
        { id: 'f2', content: 'ghost theme', valid_from: daysAgo(10), theme_id: 'ghost' },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content).sort()).toEqual(['f1', 'f2']);
  });

  it('maps a fact to its theme via theme.fact_ids when the fact omits theme_id', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const content = memoryJson({
      themes: [
        { id: 'big', label: 'Big', description: 'd', fact_ids: ['f1', 'f2', 'f3'] },
        { id: 'small', label: 'Small', description: 'd', fact_ids: ['f4'] },
      ],
      facts: [
        { id: 'f4', content: 'small', valid_from: daysAgo(10) },
        { id: 'f1', content: 'big', valid_from: daysAgo(10) },
      ],
    });

    const result = stage.execute([seg('m1', content)], makeContext());

    expect(factIds(result.segments[0].content)).toEqual(['f1', 'f4']);
  });

  it('only rewrites the memory segment among a mixed batch', () => {
    const stage = createAdaptiveMemoryStage({ recencyBoostDays: 0 });
    const memContent = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1', 'f2'] }],
      facts: [
        { id: 'f2', content: 'b', valid_from: daysAgo(10), theme_id: 't1' },
        { id: 'f1', content: 'a', valid_from: daysAgo(10), theme_id: 't1' },
      ],
    });
    const segments = [
      seg('s1', 'system prompt', 'system'),
      seg('m1', memContent, 'memory'),
      seg('u1', 'user msg', 'user'),
    ];

    const result = stage.execute(segments, makeContext());

    expect(result.segments[0].content).toBe('system prompt');
    expect(result.segments[2].content).toBe('user msg');
    expect(JSON.parse(result.segments[1].content).facts).toHaveLength(2);
  });

  it('preserves segment id, role, and metadata on the rewritten segment', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'fact', valid_from: daysAgo(1) }],
    });

    const result = stage.execute(
      [seg('m1', content, 'memory', { metadata: { source: 'test', version: 2 } })],
      makeContext(),
    );

    expect(result.segments[0].id).toBe('m1');
    expect(result.segments[0].role).toBe('memory');
    expect(result.segments[0].metadata).toEqual({ source: 'test', version: 2 });
  });

  it('emits compact JSON without newlines or indentation', () => {
    const stage = createAdaptiveMemoryStage();
    const content = memoryJson({
      themes: [{ id: 't1', label: 'Theme', description: 'desc', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'fact content', valid_from: daysAgo(1) }],
    });

    const output = stage.execute([seg('m1', content)], makeContext()).segments[0].content;

    expect(output).not.toContain('\n');
    expect(output).not.toMatch(/ {2}/);
  });

  it('invokes onShapeMismatch with the segment id when a memory payload fails the schema', () => {
    const mismatches: Array<{ segmentId?: string; issueCount: number }> = [];
    const stage = createAdaptiveMemoryStage({
      onShapeMismatch: (error, segmentId) => mismatches.push({ segmentId, issueCount: error.issues.length }),
    });
    const content = JSON.stringify({ unrelated: { shape: true } });

    const result = stage.execute([seg('bad-shape', content)], makeContext());

    expect(mismatches).toEqual([{ segmentId: 'bad-shape', issueCount: 1 }]);
    expect(result.segments[0].content).toBe(content);
  });

  it('does not invoke onShapeMismatch when JSON parsing fails', () => {
    const mismatches: unknown[] = [];
    const stage = createAdaptiveMemoryStage({ onShapeMismatch: (error) => mismatches.push(error) });

    const result = stage.execute([seg('bad-json', 'not valid json {')], makeContext());

    expect(mismatches).toHaveLength(0);
    expect(result.segments[0].content).toBe('not valid json {');
  });

  it('does not invoke onShapeMismatch for valid memory payloads', () => {
    const mismatches: unknown[] = [];
    const stage = createAdaptiveMemoryStage({ onShapeMismatch: (error) => mismatches.push(error) });
    const content = memoryJson({
      themes: [{ id: 't1', label: 'T', description: 'd', fact_ids: ['f1'] }],
      facts: [{ id: 'f1', content: 'ok', valid_from: daysAgo(1) }],
    });

    stage.execute([seg('good', content)], makeContext());

    expect(mismatches).toHaveLength(0);
  });
});
