/**
 * Tests for canonical serialization (src/replay/canonical.ts).
 */

import { describe, expect, it } from 'vitest';
import { canonicalEquals, canonicalJson } from '../src/replay/canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('treats an undefined-valued key as absent', () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it('serializes the undefined sentinel distinctly from null', () => {
    expect(canonicalJson(undefined)).toBe('undefined');
    expect(canonicalJson(null)).toBe('null');
  });

  it('renders an unserializable primitive as null', () => {
    expect(canonicalJson(Symbol('x'))).toBe('null');
  });

  it('serializes arrays element-wise without reordering', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });
});

describe('canonicalEquals', () => {
  it('treats key order as irrelevant', () => {
    expect(canonicalEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('distinguishes values that differ', () => {
    expect(canonicalEquals({ a: 1 }, { a: 2 })).toBe(false);
  });
});
