/**
 * Tests for the Anthropic cache-breakpoint marker
 * (agents/executors/agent/executor.ts withCacheBreakpoint).
 */

import { describe, it, expect } from 'vitest';
import { withCacheBreakpoint } from '../src/agents/executors/agent/executor.js';

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('withCacheBreakpoint', () => {
  it('marks only the last part of the last message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'tool', content: [{ type: 'tool-result', output: 'x' }, { type: 'tool-result', output: 'y' }] },
    ];

    const marked = withCacheBreakpoint(messages) as typeof messages;

    expect(marked[0]).toEqual(messages[0]);
    expect((marked[1]!.content[0] as Record<string, unknown>)['providerOptions']).toBeUndefined();
    expect((marked[1]!.content[1] as Record<string, unknown>)['providerOptions']).toEqual(CACHE);
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
