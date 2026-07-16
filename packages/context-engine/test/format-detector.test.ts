import { describe, it, expect } from 'vitest';
import { detectShape } from '../src/format/detector.js';

describe('detectShape', () => {
  // Primitives
  it('detects string as primitive', () => expect(detectShape('hello')).toBe('primitive'));
  it('detects number as primitive', () => expect(detectShape(42)).toBe('primitive'));
  it('detects boolean as primitive', () => expect(detectShape(true)).toBe('primitive'));
  it('detects null as primitive', () => expect(detectShape(null)).toBe('primitive'));
  it('detects undefined as primitive', () => expect(detectShape(undefined)).toBe('primitive'));

  // Flat objects
  it('detects flat object with all primitive values', () => {
    expect(detectShape({ name: 'Alice', age: 30, active: true })).toBe('flat-object');
  });

  it('detects empty object as flat-object', () => {
    expect(detectShape({})).toBe('flat-object');
  });

  // Nested objects
  it('detects object with nested object', () => {
    expect(detectShape({ user: { name: 'Alice' } })).toBe('nested');
  });

  it('detects object with array value as nested', () => {
    expect(detectShape({ tags: ['a', 'b'] })).toBe('nested');
  });

  // Tabular
  it('detects uniform array of objects as tabular', () => {
    expect(detectShape([
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ])).toBe('tabular');
  });

  it('detects single-item array of object as tabular', () => {
    expect(detectShape([{ name: 'Alice', score: 92 }])).toBe('tabular');
  });

  // Mixed
  it('detects empty array as mixed', () => {
    expect(detectShape([])).toBe('mixed');
  });

  it('detects array of primitives as mixed', () => {
    expect(detectShape([1, 2, 3])).toBe('mixed');
  });

  it('detects non-uniform object array as mixed', () => {
    expect(detectShape([
      { name: 'Alice', score: 92 },
      { name: 'Bob', rating: 4.5 }, // different keys
    ])).toBe('mixed');
  });

  it('detects mixed array (objects + primitives) as mixed', () => {
    expect(detectShape([{ name: 'Alice' }, 42])).toBe('mixed');
  });

  it('detects array with null elements as mixed', () => {
    expect(detectShape([null, { name: 'Alice' }])).toBe('mixed');
  });

  it('does not collide keys containing the old join delimiter', () => {
    // A single key "a,b" must not fingerprint-match the two keys "a" and "b" —
    // a false tabular match drops row values under the missing column.
    expect(detectShape([{ 'a,b': 1 }, { a: 2, b: 3 }])).toBe('mixed');
  });
});
