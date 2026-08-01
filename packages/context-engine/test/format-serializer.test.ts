/**
 * Tests for the format serializer: shape-detecting serialize() and the
 * createFormatStage pipeline wrapper.
 */

import { describe, it, expect } from 'vitest';
import { serialize, createFormatStage } from '../src/format/serializer.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();
const context = makeContext({ tokenCounter: counter });

describe('serialize', () => {
  it('auto-detects tabular data', () => {
    const result = serialize([
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ]);

    expect(result).toBe('@name @score\nAlice 92\nBob 87');
  });

  it('auto-detects a flat object', () => {
    expect(serialize({ name: 'Alice', age: 30 })).toBe('name: Alice\nage: 30');
  });

  it('auto-detects a nested object', () => {
    expect(serialize({ user: { name: 'Alice' } })).toBe('user:\n  name: Alice');
  });

  it('serializes mixed-shape data through the nested strategy', () => {
    expect(serialize([1, 2, 3])).toBe('- 1\n- 2\n- 3');
  });

  it('coerces primitives', () => {
    expect(serialize('hello')).toBe('hello');
    expect(serialize(42)).toBe('42');
    expect(serialize(null)).toBe('_');
  });

  it('respects the forceShape override', () => {
    expect(serialize({ name: 'Alice', age: 30 }, { forceShape: 'nested' })).toBe(
      'name: Alice\nage: 30',
    );
  });
});

describe('createFormatStage', () => {
  it('compresses JSON content in a segment', () => {
    const stage = createFormatStage();
    const json = JSON.stringify([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ], null, 2);

    const result = stage.execute([seg('mem', json)], context);

    expect(result.segments[0].content).toContain('@name');
    expect(result.segments[0].content.length).toBeLessThan(json.length);
  });

  it('passes through non-JSON content unchanged', () => {
    const stage = createFormatStage();
    const text = 'This is a plain text system prompt.';

    const result = stage.execute([seg('sys', text)], context);

    expect(result.segments[0].content).toBe(text);
  });

  it('passes through malformed JSON unchanged', () => {
    const stage = createFormatStage();
    const malformed = '{ not valid json';

    const result = stage.execute([seg('bad', malformed)], context);

    expect(result.segments[0].content).toBe(malformed);
  });

  it('handles multiple segments independently', () => {
    const stage = createFormatStage();

    const result = stage.execute(
      [seg('json', JSON.stringify({ a: 1, b: 2 })), seg('text', 'plain text')],
      context,
    );

    expect(result.segments[0].content).toBe('a: 1\nb: 2');
    expect(result.segments[1].content).toBe('plain text');
  });

  it('achieves at least 20% token reduction on structured JSON', () => {
    const stage = createFormatStage();
    const data = {
      supervisor_history: [
        { supervisor_id: 'sup-1', delegated_to: 'research', reasoning: 'Need research first', iteration: 1 },
        { supervisor_id: 'sup-1', delegated_to: 'writer', reasoning: 'Research complete, write now', iteration: 2 },
      ],
      research_results: { topic: 'AI Safety', findings: 'Key findings about alignment' },
      agent_config: { model: 'claude-sonnet', temperature: 0.7, maxSteps: 10 },
    };
    const json = JSON.stringify(data, null, 2);

    const result = stage.execute([seg('mem', json)], context);

    const tokensBefore = counter.countTokens(json);
    const tokensAfter = counter.countTokens(result.segments[0].content);
    const reduction = ((tokensBefore - tokensAfter) / tokensBefore) * 100;
    expect(reduction).toBeGreaterThan(20);
  });
});
