/**
 * Tests for detectShape, which classifies a value into one of five
 * structural shapes that drive serialization-strategy selection.
 */

import { describe, it, expect } from 'vitest';
import { detectShape } from '../src/format/detector.js';

describe('detectShape', () => {
  it('detects a string as primitive', () => expect(detectShape('hello')).toBe('primitive'));
  it('detects a number as primitive', () => expect(detectShape(42)).toBe('primitive'));
  it('detects a boolean as primitive', () => expect(detectShape(true)).toBe('primitive'));
  it('detects null as primitive', () => expect(detectShape(null)).toBe('primitive'));
  it('detects undefined as primitive', () => expect(detectShape(undefined)).toBe('primitive'));

  it('detects a flat object with all primitive values', () => {
    expect(detectShape({ name: 'Alice', age: 30, active: true })).toBe('flat-object');
  });

  it('detects an empty object as flat-object', () => {
    expect(detectShape({})).toBe('flat-object');
  });

  it('detects an object with a nested object as nested', () => {
    expect(detectShape({ user: { name: 'Alice' } })).toBe('nested');
  });

  it('detects an object with an array value as nested', () => {
    expect(detectShape({ tags: ['a', 'b'] })).toBe('nested');
  });

  it('detects a uniform array of objects as tabular', () => {
    expect(detectShape([
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ])).toBe('tabular');
  });

  it('detects a single-item array of one object as tabular', () => {
    expect(detectShape([{ name: 'Alice', score: 92 }])).toBe('tabular');
  });

  it('detects an empty array as mixed', () => {
    expect(detectShape([])).toBe('mixed');
  });

  it('detects an array of primitives as mixed', () => {
    expect(detectShape([1, 2, 3])).toBe('mixed');
  });

  it('detects an array whose first object has no keys as mixed', () => {
    expect(detectShape([{}])).toBe('mixed');
  });

  it('detects a non-uniform object array as mixed', () => {
    expect(detectShape([
      { name: 'Alice', score: 92 },
      { name: 'Bob', rating: 4.5 },
    ])).toBe('mixed');
  });

  it('detects a mix of objects and primitives as mixed', () => {
    expect(detectShape([{ name: 'Alice' }, 42])).toBe('mixed');
  });

  it('detects an array with a null element as mixed', () => {
    expect(detectShape([null, { name: 'Alice' }])).toBe('mixed');
  });

  it('does not fingerprint-collide a key containing a comma with two separate keys', () => {
    expect(detectShape([{ 'a,b': 1 }, { a: 2, b: 3 }])).toBe('mixed');
  });
});
