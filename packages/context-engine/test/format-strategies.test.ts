import { describe, it, expect } from 'vitest';
import { serializeTabular } from '../src/format/strategies/tabular.js';
import { serializeFlatObject } from '../src/format/strategies/flat-object.js';
import { serializeNested } from '../src/format/strategies/nested.js';

describe('serializeTabular', () => {
  it('serializes uniform array with header row', () => {
    const result = serializeTabular([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ]);
    expect(result).toBe('@name @role @score\nAlice researcher 92\nBob writer 87');
  });

  it('handles null values as underscore', () => {
    const result = serializeTabular([{ name: 'Alice', note: null }]);
    expect(result).toBe('@name @note\nAlice _');
  });

  it('handles array cell values with semicolons', () => {
    const result = serializeTabular([{ name: 'Alice', tags: ['a', 'b', 'c'] }]);
    expect(result).toBe('@name @tags\nAlice "a;b;c"');
  });

  it('handles nested object cell values with key=value', () => {
    const result = serializeTabular([{ name: 'Alice', meta: { x: 1, y: 2 } }]);
    expect(result).toBe('@name @meta\nAlice "x=1,y=2"');
  });

  it('preserves deeply nested cell values as JSON instead of [object Object]', () => {
    const result = serializeTabular([
      { id: 1, meta: { tags: ['x', 'y'], deep: { z: 1 } } },
    ]);
    expect(result).not.toContain('[object Object]');
    expect(result).toContain('{""z"":1}'); // JSON inside a quoted cell ("" = escaped quote)
    expect(result).toContain('[""x"",""y""]');
  });

  it('preserves objects inside array cells as JSON', () => {
    const result = serializeTabular([{ id: 1, items: [{ a: 1 }, { b: 2 }] }]);
    expect(result).not.toContain('[object Object]');
    expect(result).toContain('{""a"":1}');
  });

  it('returns empty string for empty array', () => {
    expect(serializeTabular([])).toBe('');
  });

  it('produces fewer characters than JSON', () => {
    const data = [
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
      { name: 'Carol', role: 'reviewer', score: 95 },
    ];
    const json = JSON.stringify(data, null, 2);
    const compact = serializeTabular(data);
    expect(compact.length).toBeLessThan(json.length);
  });
});

describe('tabular quoting', () => {
  it('quotes cell values containing spaces', () => {
    const result = serializeTabular([{ name: 'Alice Smith' }]);
    expect(result).toBe('@name\n"Alice Smith"');
  });

  it('quotes cell values containing semicolons', () => {
    const result = serializeTabular([{ note: 'a;b' }]);
    expect(result).toBe('@note\n"a;b"');
  });

  it('quotes cell values containing equals', () => {
    const result = serializeTabular([{ expr: 'x=1' }]);
    expect(result).toBe('@expr\n"x=1"');
  });

  it('quotes cell values containing newlines', () => {
    const result = serializeTabular([{ note: 'line1\nline2' }]);
    expect(result).toBe('@note\n"line1\nline2"');
  });

  it('escapes double quotes inside values', () => {
    const result = serializeTabular([{ note: 'say "hello"' }]);
    expect(result).toBe('@note\n"say ""hello"""');
  });

  it('does not quote clean values', () => {
    const result = serializeTabular([{ name: 'Alice', score: 92 }]);
    expect(result).toBe('@name @score\nAlice 92');
  });

  it('quotes array joins containing delimiter chars', () => {
    const result = serializeTabular([{ tags: ['hello world', 'foo'] }]);
    expect(result).toBe('@tags\n"hello world;foo"');
  });
});

describe('serializeFlatObject', () => {
  it('serializes as key: value lines', () => {
    const result = serializeFlatObject({ name: 'Alice', age: 30, active: true });
    expect(result).toBe('name: Alice\nage: 30\nactive: true');
  });

  it('handles null values', () => {
    const result = serializeFlatObject({ name: 'Alice', note: null });
    expect(result).toBe('name: Alice\nnote: _');
  });

  it('returns empty string for empty object', () => {
    expect(serializeFlatObject({})).toBe('');
  });

  it('quotes string values containing newlines to preserve line structure', () => {
    const result = serializeFlatObject({ name: 'Alice', bio: 'line one\nline two' });
    expect(result.split('\n')).toHaveLength(2); // still one line per key
    expect(result).toContain('bio: "line one\\nline two"');
  });

  it('produces fewer characters than JSON', () => {
    const data = { name: 'Alice', role: 'researcher', score: 92, status: 'active' };
    const json = JSON.stringify(data, null, 2);
    const compact = serializeFlatObject(data);
    expect(compact.length).toBeLessThan(json.length);
  });
});

describe('serializeNested', () => {
  it('serializes flat object inline', () => {
    const result = serializeNested({ name: 'Alice', age: 30 });
    expect(result).toBe('name: Alice\nage: 30');
  });

  it('serializes nested objects with indentation', () => {
    const result = serializeNested({ user: { name: 'Alice', age: 30 } });
    expect(result).toContain('user:');
    expect(result).toContain('  name: Alice');
    expect(result).toContain('  age: 30');
  });

  it('serializes arrays with dash prefix', () => {
    const result = serializeNested({ tags: ['alpha', 'beta'] });
    expect(result).toContain('tags:');
    expect(result).toContain('  - alpha');
    expect(result).toContain('  - beta');
  });

  it('serializes array of objects with inline first key', () => {
    const result = serializeNested({
      items: [
        { id: 1, name: 'foo' },
        { id: 2, name: 'bar' },
      ],
    });
    expect(result).toContain('- id: 1');
    expect(result).toContain('  name: foo');
  });

  it('handles null and undefined', () => {
    expect(serializeNested(null)).toBe('_');
    expect(serializeNested(undefined)).toBe('_');
  });

  it('handles primitives', () => {
    expect(serializeNested('hello')).toBe('hello');
    expect(serializeNested(42)).toBe('42');
    expect(serializeNested(true)).toBe('true');
  });

  it('handles empty objects and arrays', () => {
    expect(serializeNested({})).toBe('{}');
    expect(serializeNested([])).toBe('[]');
  });

  it('produces fewer characters than JSON for nested data', () => {
    const data = {
      workflow: { id: 'abc', status: 'running' },
      agents: [
        { name: 'researcher', model: 'claude-sonnet' },
        { name: 'writer', model: 'gpt-4o' },
      ],
      config: { maxRetries: 3, timeout: 5000 },
    };
    const json = JSON.stringify(data, null, 2);
    const compact = serializeNested(data);
    expect(compact.length).toBeLessThan(json.length);
  });
});
