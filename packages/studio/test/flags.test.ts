/** Tests for scenario flag parsing (src/cli/flags.ts). */

import { describe, it, expect } from 'vitest';
import { FlagError, parseFlags } from '../src/cli/flags.js';
import type { ParamField } from '../src/params/introspect.js';

const FIELDS: ParamField[] = [
  { path: 'budget.maxTokens', flag: '--budget-max-tokens', kind: 'integer' },
  { path: 'verbose', flag: '--verbose', kind: 'boolean' },
  { path: '__proto__.polluted', flag: '--polluted', kind: 'boolean' },
  { path: 'constructor.prototype.polluted', flag: '--deep-polluted', kind: 'boolean' },
];

describe('parseFlags', () => {
  it('builds a nested object from a dotted path', () => {
    expect(parseFlags(['--budget-max-tokens', '500'], FIELDS)).toEqual({ budget: { maxTokens: 500 } });
  });

  it('accepts a bare boolean flag', () => {
    expect(parseFlags(['--verbose'], FIELDS)).toEqual({ verbose: true });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseFlags(['--nope', '1'], FIELDS)).toThrow(FlagError);
  });

  it('refuses a path whose leaf would rewrite the prototype', () => {
    expect(() => parseFlags(['--polluted'], FIELDS)).toThrow(/not a valid parameter path/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a path with a prototype segment in the middle', () => {
    expect(() => parseFlags(['--deep-polluted'], FIELDS)).toThrow(/not a valid parameter path/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
