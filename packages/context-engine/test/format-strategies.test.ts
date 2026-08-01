/**
 * Tests for the three structural serialization strategies:
 * tabular, flat-object, and nested.
 */

import { describe, it, expect } from 'vitest';
import {
  serializeTabular,
  needsQuoting,
  quoteValue,
} from '../src/format/strategies/tabular.js';
import { serializeFlatObject } from '../src/format/strategies/flat-object.js';
import { serializeNested } from '../src/format/strategies/nested.js';

const FIXED_DATE = new Date('2020-06-01T12:00:00.000Z');
const FIXED_DATE_ISO = '2020-06-01T12:00:00.000Z';

describe('serializeTabular', () => {
  it('serializes a uniform array with an @-prefixed header row', () => {
    const result = serializeTabular([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ]);

    expect(result).toBe('@name @role @score\nAlice researcher 92\nBob writer 87');
  });

  it('renders null cell values as underscore', () => {
    expect(serializeTabular([{ name: 'Alice', note: null }])).toBe('@name @note\nAlice _');
  });

  it('renders a null element inside an array cell as underscore', () => {
    expect(serializeTabular([{ name: 'Alice', tags: [null] }])).toBe('@name @tags\nAlice _');
  });

  it('renders a Date element inside an array cell as an ISO string', () => {
    expect(serializeTabular([{ id: 1, dates: [FIXED_DATE] }])).toBe(
      `@id @dates\n1 ${FIXED_DATE_ISO}`,
    );
  });

  it('joins array cell values with semicolons', () => {
    expect(serializeTabular([{ name: 'Alice', tags: ['a', 'b', 'c'] }])).toBe(
      '@name @tags\nAlice "a;b;c"',
    );
  });

  it('renders nested object cell values as comma-joined key=value pairs', () => {
    expect(serializeTabular([{ name: 'Alice', meta: { x: 1, y: 2 } }])).toBe(
      '@name @meta\nAlice "x=1,y=2"',
    );
  });

  it('preserves deeply nested cell values as JSON instead of [object Object]', () => {
    const result = serializeTabular([{ id: 1, meta: { tags: ['x', 'y'], deep: { z: 1 } } }]);

    expect(result).not.toContain('[object Object]');
    expect(result).toContain('{""z"":1}');
    expect(result).toContain('[""x"",""y""]');
  });

  it('preserves objects inside array cells as JSON', () => {
    const result = serializeTabular([{ id: 1, items: [{ a: 1 }, { b: 2 }] }]);

    expect(result).not.toContain('[object Object]');
    expect(result).toContain('{""a"":1}');
  });

  it('returns an empty string for an empty array', () => {
    expect(serializeTabular([])).toBe('');
  });

  it('produces fewer characters than pretty-printed JSON', () => {
    const data = [
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
      { name: 'Carol', role: 'reviewer', score: 95 },
    ];

    expect(serializeTabular(data).length).toBeLessThan(JSON.stringify(data, null, 2).length);
  });

  describe('cell quoting', () => {
    it('quotes cell values containing spaces', () => {
      expect(serializeTabular([{ name: 'Alice Smith' }])).toBe('@name\n"Alice Smith"');
    });

    it('quotes cell values containing semicolons', () => {
      expect(serializeTabular([{ note: 'a;b' }])).toBe('@note\n"a;b"');
    });

    it('quotes cell values containing equals signs', () => {
      expect(serializeTabular([{ expr: 'x=1' }])).toBe('@expr\n"x=1"');
    });

    it('quotes cell values containing newlines', () => {
      expect(serializeTabular([{ note: 'line1\nline2' }])).toBe('@note\n"line1\nline2"');
    });

    it('escapes embedded double quotes by doubling them', () => {
      expect(serializeTabular([{ note: 'say "hello"' }])).toBe('@note\n"say ""hello"""');
    });

    it('leaves clean values unquoted', () => {
      expect(serializeTabular([{ name: 'Alice', score: 92 }])).toBe('@name @score\nAlice 92');
    });

    it('quotes an array join that contains delimiter characters', () => {
      expect(serializeTabular([{ tags: ['hello world', 'foo'] }])).toBe('@tags\n"hello world;foo"');
    });
  });
});

describe('needsQuoting', () => {
  it('flags values with column-breaking characters', () => {
    expect(needsQuoting('a b')).toBe(true);
    expect(needsQuoting('a;b')).toBe(true);
    expect(needsQuoting('a,b')).toBe(true);
    expect(needsQuoting('a=b')).toBe(true);
    expect(needsQuoting('a\nb')).toBe(true);
    expect(needsQuoting('a"b')).toBe(true);
  });

  it('leaves clean values unflagged', () => {
    expect(needsQuoting('Alice')).toBe(false);
  });
});

describe('quoteValue', () => {
  it('wraps in double quotes and doubles embedded quotes', () => {
    expect(quoteValue('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('serializeFlatObject', () => {
  it('serializes as key: value lines', () => {
    expect(serializeFlatObject({ name: 'Alice', age: 30, active: true })).toBe(
      'name: Alice\nage: 30\nactive: true',
    );
  });

  it('renders null values as underscore', () => {
    expect(serializeFlatObject({ name: 'Alice', note: null })).toBe('name: Alice\nnote: _');
  });

  it('renders Date values as ISO strings', () => {
    expect(serializeFlatObject({ created: FIXED_DATE })).toBe(`created: ${FIXED_DATE_ISO}`);
  });

  it('preserves an object value as JSON instead of [object Object]', () => {
    expect(serializeFlatObject({ meta: { x: 1, y: 2 } })).toBe('meta: {"x":1,"y":2}');
  });

  it('returns an empty string for an empty object', () => {
    expect(serializeFlatObject({})).toBe('');
  });

  it('quotes string values containing newlines to preserve the line-per-key structure', () => {
    const result = serializeFlatObject({ name: 'Alice', bio: 'line one\nline two' });

    expect(result.split('\n')).toHaveLength(2);
    expect(result).toContain('bio: "line one\\nline two"');
  });

  it('produces fewer characters than pretty-printed JSON', () => {
    const data = { name: 'Alice', role: 'researcher', score: 92, status: 'active' };

    expect(serializeFlatObject(data).length).toBeLessThan(JSON.stringify(data, null, 2).length);
  });
});

describe('serializeNested', () => {
  it('serializes a flat object inline', () => {
    expect(serializeNested({ name: 'Alice', age: 30 })).toBe('name: Alice\nage: 30');
  });

  it('serializes nested objects with two-space indentation', () => {
    const result = serializeNested({ user: { name: 'Alice', age: 30 } });

    expect(result).toBe('user:\n  name: Alice\n  age: 30');
  });

  it('serializes a top-level array of primitives with dash prefixes', () => {
    expect(serializeNested([1, 2, 3])).toBe('- 1\n- 2\n- 3');
  });

  it('serializes an object array value with dash prefixes', () => {
    const result = serializeNested({ tags: ['alpha', 'beta'] });

    expect(result).toBe('tags:\n  - alpha\n  - beta');
  });

  it('serializes an array of objects inlining the first key on the dash line', () => {
    const result = serializeNested({
      items: [
        { id: 1, name: 'foo' },
        { id: 2, name: 'bar' },
      ],
    });

    expect(result).toBe('items:\n  - id: 1\n    name: foo\n  - id: 2\n    name: bar');
  });

  it('serializes a top-level array of arrays', () => {
    expect(serializeNested([[1, 2], [3, 4]])).toBe('-\n  - 1\n  - 2\n-\n  - 3\n  - 4');
  });

  it('renders a null element in a top-level array as underscore', () => {
    expect(serializeNested([null])).toBe('- _');
  });

  it('renders an empty object element in an array as inline braces', () => {
    expect(serializeNested([{}])).toBe('- {}');
  });

  it('renders null and undefined as underscore', () => {
    expect(serializeNested(null)).toBe('_');
    expect(serializeNested(undefined)).toBe('_');
  });

  it('renders primitives via string coercion', () => {
    expect(serializeNested('hello')).toBe('hello');
    expect(serializeNested(42)).toBe('42');
    expect(serializeNested(true)).toBe('true');
  });

  it('renders empty objects and arrays as inline braces', () => {
    expect(serializeNested({})).toBe('{}');
    expect(serializeNested([])).toBe('[]');
  });

  describe('Date values', () => {
    it('renders a top-level Date as an ISO string', () => {
      expect(serializeNested(FIXED_DATE)).toBe('2020-06-01T12:00:00.000Z');
    });

    it('renders a Date property value as an ISO string', () => {
      expect(serializeNested({ at: FIXED_DATE })).toBe('at: 2020-06-01T12:00:00.000Z');
    });

    it('renders a Date array element as an ISO string', () => {
      expect(serializeNested([FIXED_DATE])).toBe('- 2020-06-01T12:00:00.000Z');
    });

    it('renders a Date inside an array-of-objects as an ISO string', () => {
      expect(serializeNested([{ at: FIXED_DATE, id: 1 }])).toBe(
        '- at: 2020-06-01T12:00:00.000Z\n  id: 1',
      );
    });
  });

  it('produces fewer characters than pretty-printed JSON for nested data', () => {
    const data = {
      workflow: { id: 'abc', status: 'running' },
      agents: [
        { name: 'researcher', model: 'claude-sonnet' },
        { name: 'writer', model: 'gpt-4o' },
      ],
      config: { maxRetries: 3, timeout: 5000 },
    };

    expect(serializeNested(data).length).toBeLessThan(JSON.stringify(data, null, 2).length);
  });

  describe('object value edge cases', () => {
    it('renders a null property value as underscore', () => {
      expect(serializeNested({ name: 'Alice', note: null })).toBe('name: Alice\nnote: _');
    });

    it('renders an empty array property value as inline brackets', () => {
      expect(serializeNested({ tags: [] })).toBe('tags: []');
    });

    it('renders an empty object property value as inline braces', () => {
      expect(serializeNested({ meta: {} })).toBe('meta: {}');
    });
  });

  describe('array-of-objects inline value edge cases', () => {
    it('renders an empty array value inline', () => {
      expect(serializeNested([{ id: 1, tags: [] }])).toBe('- id: 1\n  tags: []');
    });

    it('renders a non-empty array value on indented dash lines', () => {
      expect(serializeNested([{ id: 1, tags: ['a', 'b'] }])).toBe(
        '- id: 1\n  tags:\n    - a\n    - b',
      );
    });

    it('renders an empty object value inline', () => {
      expect(serializeNested([{ id: 1, meta: {} }])).toBe('- id: 1\n  meta: {}');
    });

    it('renders a nested object value on indented lines', () => {
      expect(serializeNested([{ id: 1, meta: { x: 1 } }])).toBe(
        '- id: 1\n  meta:\n    x: 1',
      );
    });
  });

  describe('string quoting', () => {
    it('quotes a string containing a colon-space sequence', () => {
      expect(serializeNested('a: b')).toBe('"a: b"');
    });

    it('quotes a string starting with a special character', () => {
      expect(serializeNested('- leading dash')).toBe('"- leading dash"');
    });

    it('quotes a string containing a newline while preserving the literal newline', () => {
      expect(serializeNested('line1\nline2')).toBe('"line1\nline2"');
    });

    it('quotes an empty string', () => {
      expect(serializeNested('')).toBe('""');
    });

    it('leaves a plain string unquoted', () => {
      expect(serializeNested('plain')).toBe('plain');
    });
  });
});
