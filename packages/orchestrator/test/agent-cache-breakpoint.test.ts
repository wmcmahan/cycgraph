/**
 * Tests for the Anthropic cache-breakpoint marker
 * (agents/executors/agent/executor.ts withCacheBreakpoint).
 */

import { describe, it, expect } from 'vitest';
import { withCacheBreakpoint } from '../src/agents/executors/agent/executor.js';

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('withCacheBreakpoint', () => {
  it('marks the final part of each of the last three messages, none earlier', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'tool', content: [{ type: 'tool-result', output: 'x' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
      { role: 'tool', content: [{ type: 'tool-result', output: 'y' }, { type: 'tool-result', output: 'z' }] },
    ];

    const marked = withCacheBreakpoint(messages) as typeof messages;

    expect(marked[0]).toEqual(messages[0]);
    expect(marked[1]).toEqual(messages[1]);
    expect((marked[2]!.content[0] as Record<string, unknown>)['providerOptions']).toEqual(CACHE);
    expect((marked[3]!.content[0] as Record<string, unknown>)['providerOptions']).toEqual(CACHE);
    expect((marked[4]!.content[0] as Record<string, unknown>)['providerOptions']).toBeUndefined();
    expect((marked[4]!.content[1] as Record<string, unknown>)['providerOptions']).toEqual(CACHE);
  });

  it('marks every message when there are fewer than three', () => {
    const marked = withCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ]) as { content: Array<Record<string, unknown>> }[];

    expect(marked[0]!.content[0]!['providerOptions']).toEqual(CACHE);
    expect(marked[1]!.content[0]!['providerOptions']).toEqual(CACHE);
  });

  it('wraps string content into a marked text part', () => {
    const marked = withCacheBreakpoint([{ role: 'user', content: 'hello' }]) as
      { content: Array<Record<string, unknown>> }[];

    expect(marked[0]!.content).toEqual([{ type: 'text', text: 'hello', providerOptions: CACHE }]);
  });

  it('preserves existing part providerOptions while adding the marker', () => {
    const marked = withCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'a', providerOptions: { other: { k: 1 } } }] },
    ]) as { content: Array<Record<string, unknown>> }[];

    expect(marked[0]!.content[0]!['providerOptions']).toEqual({ other: { k: 1 }, ...CACHE });
  });

  it('returns empty input unchanged', () => {
    expect(withCacheBreakpoint([])).toEqual([]);
  });
});

describe('cachePrepareStep', () => {
  it('returns the marked messages for the step', async () => {
    const { cachePrepareStep } = await import('../src/agents/executors/agent/executor.js');

    const result = cachePrepareStep({ messages: [{ role: 'user', content: 'hi' }] });

    expect((result.messages as unknown as { content: unknown[] }[])[0]!.content).toEqual([
      { type: 'text', text: 'hi', providerOptions: CACHE },
    ]);
  });
});

describe('sumStepUsage', () => {
  it('sums per-step usage and derives missing totals', async () => {
    const { sumStepUsage } = await import('../src/agents/executors/agent/executor.js');

    const summed = sumStepUsage([
      { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      { usage: { inputTokens: 200, outputTokens: 20 } },
      {},
    ]);

    expect(summed).toEqual({ inputTokens: 300, outputTokens: 30, totalTokens: 330 });
  });

  it('returns zeros for no steps', async () => {
    const { sumStepUsage } = await import('../src/agents/executors/agent/executor.js');

    expect(sumStepUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });
});

describe('billedTokenTotal', () => {
  it('weights cache reads at a tenth and writes at a quarter premium', async () => {
    const { billedTokenTotal } = await import('../src/agents/executors/agent/executor.js');

    const billed = billedTokenTotal({
      inputTokens: 1_000_000,
      outputTokens: 10_000,
      inputTokenDetails: { noCacheTokens: 50_000, cacheReadTokens: 900_000, cacheWriteTokens: 50_000 },
    });

    expect(billed).toBe(50_000 + 62_500 + 90_000 + 10_000);
  });

  it('derives the uncached share when the provider omits it', async () => {
    const { billedTokenTotal } = await import('../src/agents/executors/agent/executor.js');

    const billed = billedTokenTotal({
      inputTokens: 100_000,
      outputTokens: 1_000,
      inputTokenDetails: { cacheReadTokens: 80_000, cacheWriteTokens: 10_000 },
    });

    expect(billed).toBe(10_000 + 12_500 + 8_000 + 1_000);
  });

  it('is plain input plus output without cache detail', async () => {
    const { billedTokenTotal } = await import('../src/agents/executors/agent/executor.js');

    expect(billedTokenTotal({ inputTokens: 500, outputTokens: 50 })).toBe(550);
    expect(billedTokenTotal({ inputTokens: 500, outputTokens: 50, totalTokens: 555 })).toBe(555);
    expect(billedTokenTotal(undefined)).toBe(0);
  });
});

describe('withCacheBreakpoint stale-mark stripping', () => {
  it('removes marks that fell outside the trailing window', () => {
    const stale = { role: 'user', content: [{ type: 'text', text: 'old', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } }, other: { k: 1 } } }] };
    const messages = [
      stale,
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
    ];

    const marked = withCacheBreakpoint(messages) as { content: Array<Record<string, unknown>> }[];

    expect(marked[0]!.content[0]!['providerOptions']).toEqual({ anthropic: {}, other: { k: 1 } });
    expect(marked[1]!.content[0]!['providerOptions']).toEqual(CACHE);
    expect(marked[3]!.content[0]!['providerOptions']).toEqual(CACHE);
  });
});
