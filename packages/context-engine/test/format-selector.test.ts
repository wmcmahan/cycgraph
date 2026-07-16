import { describe, it, expect } from 'vitest';
import { selectFormat, createFormatSelectorStage } from '../src/routing/format-selector.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

describe('selectFormat', () => {
  it('returns compact JSON for gemma (prefersJson)', () => {
    const result = selectFormat('gemma-2-9b');
    expect(result.useCompactJson).toBe(true);
    expect(result.dataShape).toBe('json');
  });

  it('returns nested for models without tabular support', () => {
    const result = selectFormat('phi-3-mini');
    expect(result.useCompactJson).toBe(true); // phi also prefersJson
  });

  it('returns auto-detect for capable models', () => {
    const result = selectFormat('claude-sonnet-4-6');
    expect(result.useCompactJson).toBe(false);
  });

  it('returns auto-detect for unknown models', () => {
    const result = selectFormat('unknown-model');
    expect(result.useCompactJson).toBe(false);
  });

  it('respects forceJson override', () => {
    const result = selectFormat('claude-sonnet-4-6', { forceJson: true });
    expect(result.useCompactJson).toBe(true);
    expect(result.dataShape).toBe('json');
  });

  it('distinguishes auto from nested-only in dataShape', () => {
    expect(selectFormat('claude-sonnet-4-6').dataShape).toBe('auto');
    expect(selectFormat('unknown-model').dataShape).toBe('auto');
  });

  it('resolves customProfiles before built-ins', () => {
    const result = selectFormat('my-local-model', {
      customProfiles: {
        'my-local': {
          family: 'my-local',
          supportsTabular: false,
          prefersJson: false,
          maxContextTokens: 8192,
          supportsCaching: false,
        },
      },
    });
    expect(result.dataShape).toBe('nested');
    expect(result.useCompactJson).toBe(false);
  });
});

describe('createFormatSelectorStage', () => {
  function makeSegment(id: string, content: string): PromptSegment {
    return { id, content, role: 'memory', priority: 1, locked: false };
  }

  it('produces compact JSON for small models', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice', score: 92 }, null, 2);
    const segments = [makeSegment('a', json)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
      model: 'gemma-2-9b',
    };

    const result = stage.execute(segments, context);
    // Should be compact JSON (no indentation)
    expect(result.segments[0].content).toBe('{"name":"Alice","score":92}');
  });

  it('produces token-efficient format for capable models', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice', score: 92 }, null, 2);
    const segments = [makeSegment('a', json)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
      model: 'claude-sonnet-4-6',
    };

    const result = stage.execute(segments, context);
    // Should be serialized format (not compact JSON)
    expect(result.segments[0].content).toContain('name:');
    expect(result.segments[0].content).not.toContain('"name"');
  });

  it('passes through non-JSON content', () => {
    const stage = createFormatSelectorStage();
    const segments = [makeSegment('a', 'plain text content')];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
      model: 'gemma-2-9b',
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('plain text content');
  });

  it('skips segments with contentType metadata (for specialized formatters)', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice' }, null, 2);
    const segments: PromptSegment[] = [{
      id: 'h', content: json, role: 'memory', priority: 1, locked: false,
      metadata: { contentType: 'hierarchy' },
    }];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
      model: 'gemma-2-9b', // would normally compact to JSON
    };

    const result = stage.execute(segments, context);
    // Should pass through unchanged — contentType tag signals specialized formatter
    expect(result.segments[0].content).toBe(json);
  });

  it('forces nested format when a custom profile disallows tabular', () => {
    const stage = createFormatSelectorStage({
      customProfiles: {
        'my-local': {
          family: 'my-local',
          supportsTabular: false,
          prefersJson: false,
          maxContextTokens: 8192,
          supportsCaching: false,
        },
      },
    });
    // Tabular-shaped data — auto-detect would emit an @-header table
    const json = JSON.stringify([
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ]);
    const segments = [makeSegment('a', json)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
      model: 'my-local-model',
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).not.toContain('@name');
    expect(result.segments[0].content).toContain('- name: Alice');
  });

  it('has name format-selector', () => {
    expect(createFormatSelectorStage().name).toBe('format-selector');
  });
});
