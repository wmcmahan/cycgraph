/**
 * Tests for the Tier 2 data tools: csv_parse (src/data/csv-parse.ts),
 * stats (src/data/stats.ts), and text_extract (src/data/text-extract.ts)
 * including the worker-terminating ReDoS guard.
 */

import { describe, it, expect } from 'vitest';
import { createCsvParseTool, parseCsv } from '../src/data/csv-parse.js';
import { createStatsTool } from '../src/data/stats.js';
import { createTextExtractTool } from '../src/data/text-extract.js';

type CsvResult = {
  headers: string[] | null;
  rows: Array<Record<string, string>> | string[][];
  totalRows: number;
  truncated: boolean;
};

type StatsResult = {
  count: number; sum: number; mean: number; median: number; min: number; max: number;
  stdDev: number; p25: number; p75: number; p95: number;
};

type ExtractResult = {
  matches: Array<{ match: string; index: number; groups: string[]; named: Record<string, string> }>;
  count: number;
  truncated: boolean;
};

describe('parseCsv', () => {
  it('parses simple rows and fields', () => {
    expect(parseCsv('a,b\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps delimiters and newlines inside quoted fields', () => {
    expect(parseCsv('"a,1","b\nc"\nplain,end', ',')).toEqual([['a,1', 'b\nc'], ['plain', 'end']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",x', ',')).toEqual([['say "hi"', 'x']]);
  });

  it('handles CRLF endings and a trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n', ',')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('preserves empty fields', () => {
    expect(parseCsv('a,,c', ',')).toEqual([['a', '', 'c']]);
  });
});

describe('createCsvParseTool', () => {
  const tool = createCsvParseTool();

  it('returns object rows keyed by header by default', async () => {
    const result = (await tool.execute({ csv: 'name,age\nAda,36\nGrace,44' })) as CsvResult;

    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '44' },
    ]);
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('returns positional rows when hasHeader is false', async () => {
    const result = (await tool.execute({ csv: 'a,b\nc,d', hasHeader: false })) as CsvResult;

    expect(result.headers).toBeNull();
    expect(result.rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('supports alternative delimiters', async () => {
    const result = (await tool.execute({ csv: 'x;y\n1;2', delimiter: ';' })) as CsvResult;

    expect(result.rows).toEqual([{ x: '1', y: '2' }]);
  });

  it('fills missing trailing fields with empty strings', async () => {
    const result = (await tool.execute({ csv: 'a,b,c\n1,2' })) as CsvResult;

    expect(result.rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('caps returned rows at the limit and reports the total', async () => {
    const csv = 'n\n' + Array.from({ length: 10 }, (_, i) => String(i)).join('\n');

    const result = (await tool.execute({ csv, limit: 3 })) as CsvResult;

    expect(result.rows).toHaveLength(3);
    expect(result.totalRows).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('rejects oversized input', async () => {
    const small = createCsvParseTool({ maxInputBytes: 10 });

    await expect(small.execute({ csv: 'a,b\n1,2\n3,4' })).rejects.toThrow(/exceeds/);
  });
});

describe('createStatsTool', () => {
  const tool = createStatsTool();

  it('computes the full summary over a known dataset', async () => {
    const result = (await tool.execute({ values: [4, 1, 3, 2] })) as StatsResult;

    expect(result.count).toBe(4);
    expect(result.sum).toBe(10);
    expect(result.mean).toBe(2.5);
    expect(result.median).toBe(2.5);
    expect(result.min).toBe(1);
    expect(result.max).toBe(4);
    expect(result.stdDev).toBeCloseTo(1.2909944, 6);
    expect(result.p25).toBe(1.75);
    expect(result.p75).toBe(3.25);
    expect(result.p95).toBeCloseTo(3.85, 10);
  });

  it('handles a single value with zero deviation', async () => {
    const result = (await tool.execute({ values: [7] })) as StatsResult;

    expect(result.median).toBe(7);
    expect(result.stdDev).toBe(0);
    expect(result.p95).toBe(7);
  });

  it('rejects an empty array via the schema', async () => {
    await expect(tool.execute({ values: [] })).rejects.toThrow();
  });

  it('rejects non-finite values via the schema', async () => {
    await expect(tool.execute({ values: [1, Infinity] })).rejects.toThrow();
  });
});

describe('createTextExtractTool', () => {
  const tool = createTextExtractTool();

  it('extracts all matches with the g flag', async () => {
    const result = (await tool.execute({
      text: 'order o-12 and order o-34',
      pattern: 'o-(\\d+)',
      flags: 'g',
    })) as ExtractResult;

    expect(result.count).toBe(2);
    expect(result.matches[0]).toEqual({ match: 'o-12', index: 6, groups: ['12'], named: {} });
    expect(result.matches[1].groups).toEqual(['34']);
  });

  it('extracts only the first match without the g flag', async () => {
    const result = (await tool.execute({
      text: 'a1 a2 a3',
      pattern: 'a(\\d)',
    })) as ExtractResult;

    expect(result.count).toBe(1);
  });

  it('returns named capture groups', async () => {
    const result = (await tool.execute({
      text: 'from alice@example.com',
      pattern: '(?<user>\\w+)@(?<host>[\\w.]+)',
    })) as ExtractResult;

    expect(result.matches[0].named).toEqual({ user: 'alice', host: 'example.com' });
  });

  it('caps matches and flags truncation', async () => {
    const capped = createTextExtractTool({ maxMatches: 2 });

    const result = (await capped.execute({
      text: 'x x x x x',
      pattern: 'x',
      flags: 'g',
    })) as ExtractResult;

    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects an invalid pattern before spawning a worker', async () => {
    await expect(tool.execute({ text: 'abc', pattern: '(' })).rejects.toThrow(/Invalid regex/);
  });

  it('rejects disallowed flags via the schema', async () => {
    await expect(tool.execute({ text: 'abc', pattern: 'a', flags: 'y' })).rejects.toThrow();
  });

  it('terminates catastrophic backtracking at the deadline', async () => {
    const guarded = createTextExtractTool({ regexTimeoutMs: 200 });

    await expect(
      guarded.execute({
        text: `${'a'.repeat(40)}b`,
        pattern: '(a+)+$',
      }),
    ).rejects.toThrow(/terminated/);
  });

  it('handles zero-width matches without looping forever', async () => {
    const result = (await tool.execute({
      text: 'abc',
      pattern: '\\b',
      flags: 'g',
    })) as ExtractResult;

    expect(result.count).toBe(2);
  });
});
