/**
 * Tests for the model-aware format selector: selectFormat() and the
 * createFormatSelectorStage pipeline stage.
 */

import { describe, it, expect } from 'vitest';
import { selectFormat, createFormatSelectorStage } from '../src/routing/format-selector.js';
import type { ModelProfile } from '../src/routing/model-profiles.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

const NON_TABULAR_PROFILE: ModelProfile = {
  family: 'my-local',
  supportsTabular: false,
  prefersJson: false,
  maxContextTokens: 8192,
  supportsCaching: false,
};

describe('selectFormat', () => {
  it('returns compact JSON for a JSON-preferring model', () => {
    const result = selectFormat('gemma-2-9b');

    expect(result.dataShape).toBe('json');
    expect(result.useCompactJson).toBe(true);
  });

  it('returns compact JSON for phi because it prefers JSON', () => {
    expect(selectFormat('phi-3-mini').useCompactJson).toBe(true);
  });

  it('returns auto-detect for a capable model', () => {
    const result = selectFormat('claude-sonnet-4-6');

    expect(result.dataShape).toBe('auto');
    expect(result.useCompactJson).toBe(false);
  });

  it('returns auto-detect for an unknown model', () => {
    const result = selectFormat('unknown-model');

    expect(result.dataShape).toBe('auto');
    expect(result.useCompactJson).toBe(false);
  });

  it('respects the forceJson override', () => {
    const result = selectFormat('claude-sonnet-4-6', { forceJson: true });

    expect(result.dataShape).toBe('json');
    expect(result.useCompactJson).toBe(true);
  });

  it('forces nested output for a custom non-tabular profile matched by prefix', () => {
    const result = selectFormat('my-local-model', {
      customProfiles: { 'my-local': NON_TABULAR_PROFILE },
    });

    expect(result.dataShape).toBe('nested');
    expect(result.useCompactJson).toBe(false);
  });

  it('falls back to a built-in profile when no custom prefix matches', () => {
    const result = selectFormat('gpt-4o-mini', {
      customProfiles: { 'my-local': NON_TABULAR_PROFILE },
    });

    expect(result.dataShape).toBe('auto');
    expect(result.useCompactJson).toBe(false);
  });
});

describe('createFormatSelectorStage', () => {
  it('is named format-selector', () => {
    expect(createFormatSelectorStage().name).toBe('format-selector');
  });

  it('emits compact JSON for a JSON-preferring model', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice', score: 92 }, null, 2);

    const result = stage.execute(
      [seg('a', json)],
      makeContext({ tokenCounter: counter, model: 'gemma-2-9b' }),
    );

    expect(result.segments[0].content).toBe('{"name":"Alice","score":92}');
  });

  it('emits a token-efficient format for a capable model', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice', score: 92 }, null, 2);

    const result = stage.execute(
      [seg('a', json)],
      makeContext({ tokenCounter: counter, model: 'claude-sonnet-4-6' }),
    );

    expect(result.segments[0].content).toBe('name: Alice\nscore: 92');
  });

  it('passes through non-JSON content', () => {
    const stage = createFormatSelectorStage();

    const result = stage.execute(
      [seg('a', 'plain text content')],
      makeContext({ tokenCounter: counter, model: 'gemma-2-9b' }),
    );

    expect(result.segments[0].content).toBe('plain text content');
  });

  it('passes through malformed JSON', () => {
    const stage = createFormatSelectorStage();
    const malformed = '{ not valid json';

    const result = stage.execute(
      [seg('a', malformed)],
      makeContext({ tokenCounter: counter, model: 'gemma-2-9b' }),
    );

    expect(result.segments[0].content).toBe(malformed);
  });

  it('skips segments tagged with a contentType for specialized formatters', () => {
    const stage = createFormatSelectorStage();
    const json = JSON.stringify({ name: 'Alice' }, null, 2);

    const result = stage.execute(
      [seg('h', json, 'memory', { metadata: { contentType: 'hierarchy' } })],
      makeContext({ tokenCounter: counter, model: 'gemma-2-9b' }),
    );

    expect(result.segments[0].content).toBe(json);
  });

  it('forces nested format when a custom profile disallows tabular', () => {
    const stage = createFormatSelectorStage({
      customProfiles: { 'my-local': NON_TABULAR_PROFILE },
    });
    const json = JSON.stringify([
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ]);

    const result = stage.execute(
      [seg('a', json)],
      makeContext({ tokenCounter: counter, model: 'my-local-model' }),
    );

    expect(result.segments[0].content).not.toContain('@name');
    expect(result.segments[0].content).toContain('- name: Alice');
  });
});
