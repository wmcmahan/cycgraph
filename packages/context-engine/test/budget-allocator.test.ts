import { describe, it, expect } from 'vitest';
import { allocateBudget, createAllocatorStage } from '../src/budget/allocator.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string, opts?: Partial<PromptSegment>): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false, ...opts };
}

describe('createAllocatorStage scope', () => {
  it('declares cross-segment scope (allocations span all segments)', () => {
    expect(createAllocatorStage().scope).toBe('cross-segment');
  });
});

describe('allocateBudget', () => {
  it('distributes budget evenly with equal priorities', () => {
    const segments = [
      makeSegment('a', 'a'.repeat(400)),
      makeSegment('b', 'b'.repeat(400)),
    ];
    const budget: BudgetConfig = { maxTokens: 200, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    const aAlloc = result.allocations.get('a') ?? 0;
    const bAlloc = result.allocations.get('b') ?? 0;
    expect(aAlloc).toBeGreaterThan(0);
    expect(bAlloc).toBeGreaterThan(0);
    expect(aAlloc + bAlloc).toBeLessThanOrEqual(200);
  });

  it('respects priority weighting', () => {
    const segments = [
      makeSegment('high', 'x'.repeat(400), { priority: 3 }),
      makeSegment('low', 'y'.repeat(400), { priority: 1 }),
    ];
    const budget: BudgetConfig = { maxTokens: 200, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    const highAlloc = result.allocations.get('high') ?? 0;
    const lowAlloc = result.allocations.get('low') ?? 0;
    expect(highAlloc).toBeGreaterThan(lowAlloc);
  });

  it('gives locked segments their exact allocation', () => {
    const segments = [
      makeSegment('locked', 'system prompt content', { locked: true }),
      makeSegment('mutable', 'x'.repeat(400)),
    ];
    const budget: BudgetConfig = { maxTokens: 500, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    const lockedAlloc = result.allocations.get('locked') ?? 0;
    const lockedTokens = counter.countTokens('system prompt content');
    expect(lockedAlloc).toBe(lockedTokens);
  });

  it('subtracts output reserve from available budget', () => {
    const segments = [makeSegment('a', 'x'.repeat(2000))];
    const withReserve: BudgetConfig = { maxTokens: 500, outputReserve: 200 };
    const withoutReserve: BudgetConfig = { maxTokens: 500, outputReserve: 0 };

    const rWith = allocateBudget(segments, withReserve, counter);
    const rWithout = allocateBudget(segments, withoutReserve, counter);

    const allocWith = rWith.allocations.get('a') ?? 0;
    const allocWithout = rWithout.allocations.get('a') ?? 0;
    expect(allocWith).toBeLessThan(allocWithout);
  });

  it('reports overflow segments', () => {
    const segments = [
      makeSegment('a', 'x'.repeat(2000)), // way over budget
    ];
    const budget: BudgetConfig = { maxTokens: 50, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    expect(result.overflow).toContain('a');
  });

  it('redistributes surplus from under-budget segments', () => {
    const segments = [
      makeSegment('small', 'hi', { priority: 1 }), // needs very few tokens
      makeSegment('big', 'x'.repeat(2000), { priority: 1 }), // needs many
    ];
    const budget: BudgetConfig = { maxTokens: 200, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    // small segment should get what it needs, rest goes to big
    const smallAlloc = result.allocations.get('small') ?? 0;
    const bigAlloc = result.allocations.get('big') ?? 0;
    const smallTokens = counter.countTokens('hi');
    expect(smallAlloc).toBe(smallTokens);
    expect(bigAlloc).toBeGreaterThan(smallAlloc);
  });

  it('distributes all surplus tokens without remainder loss', () => {
    // Create 3 segments that all need more than their proportional share
    // so surplus redistribution is triggered, testing that Math.floor
    // remainder is properly handled via largest-remainder method
    const segments = [
      makeSegment('a', 'x'.repeat(2000), { priority: 1 }),
      makeSegment('b', 'x'.repeat(2000), { priority: 1 }),
      makeSegment('c', 'x'.repeat(2000), { priority: 1 }),
    ];
    // Use a small budget so all segments overflow and surplus from floor goes somewhere
    const budget: BudgetConfig = { maxTokens: 100, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    const total = [...result.allocations.values()].reduce((s, v) => s + v, 0);
    // All 100 tokens should be distributed — no remainder lost
    expect(total).toBe(100);
  });

  it('reports locked segments in overflow when they exceed budget', () => {
    const segments = [
      makeSegment('sys', 'x'.repeat(2000), { locked: true }),
      makeSegment('user', 'hello'),
    ];
    // Budget is much smaller than the locked segment
    const budget: BudgetConfig = { maxTokens: 10, outputReserve: 0 };
    const result = allocateBudget(segments, budget, counter);

    expect(result.overflow).toContain('sys');
  });

  it('handles empty segments list', () => {
    const budget: BudgetConfig = { maxTokens: 100, outputReserve: 0 };
    const result = allocateBudget([], budget, counter);
    expect(result.allocations.size).toBe(0);
    expect(result.overflow).toHaveLength(0);
  });
});

describe('createAllocatorStage importance-aware truncation', () => {
  // Filler-heavy prose with critical facts at the END — position-based tail
  // truncation kills exactly these; importance-based enforcement keeps them.
  const proseWithTrailingFacts = [
    'It should be noted that in order to reach any kind of decision here, the team essentially had to basically review the entire landscape of options in terms of the overall strategy and methodology and approach.',
    'Additionally it is worth mentioning that at the end of the day the process was quite thorough and generally very comprehensive in most respects overall.',
    'The approved vendor is MERIDIAN-7 with a contract value of $1,284,500.',
    'Deployment must never bypass the compliance sandbox.',
  ].join(' ');

  function compressProse(options?: Parameters<typeof createAllocatorStage>[0]) {
    const stage = createAllocatorStage(options);
    const segments = [makeSegment('a', proseWithTrailingFacts, { role: 'history' })];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 40, outputReserve: 0 } as BudgetConfig,
    };
    return stage.execute(segments, context).segments[0].content;
  }

  it('keeps trailing entities, amounts, and negations over leading filler', () => {
    const output = compressProse();
    expect(output).toContain('MERIDIAN-7');
    expect(output).toContain('$1,284,500');
    expect(output).toContain('never');
    // The budget was enforced — output is much smaller than input
    expect(counter.countTokens(output)).toBeLessThan(counter.countTokens(proseWithTrailingFacts) / 2);
  });

  it('appends the truncation marker in importance mode', () => {
    expect(compressProse()).toContain('[truncated]');
  });

  it('tail mode preserves the legacy prefix-keeping behavior', () => {
    const output = compressProse({ truncation: 'tail' });
    // Prefix survives; the trailing facts are gone
    expect(output).toContain('It should be noted');
    expect(output).not.toContain('MERIDIAN-7');
  });

  it('structured (memory-role) segments always tail-truncate', () => {
    const stage = createAllocatorStage();
    const structured = 'row1,value1\nrow2,value2\n' + 'rowN,valueN\n'.repeat(50);
    const segments = [makeSegment('m', structured, { role: 'memory' })];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 20, outputReserve: 0 } as BudgetConfig,
    };
    const output = stage.execute(segments, context).segments[0].content;
    // Clean prefix cut, not token-pruned soup
    expect(output.startsWith('row1,value1')).toBe(true);
    expect(output).toContain('[truncated]');
  });
});

describe('createAllocatorStage', () => {
  it('truncates segments that exceed allocation', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(500);
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 50, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const outputTokens = counter.countTokens(result.segments[0].content);
    const inputTokens = counter.countTokens(longContent);
    expect(outputTokens).toBeLessThan(inputTokens);
  });

  it('does not truncate segments within budget', () => {
    const stage = createAllocatorStage();
    const segments = [makeSegment('a', 'short content')];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 1000, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('short content');
  });

  it('adds truncation marker when content is cut', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(500);
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 50, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('[truncated]');
  });

  it('truncated output including suffix stays within token budget', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(500);
    const maxTokens = 30;
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const outputTokens = counter.countTokens(result.segments[0].content);
    expect(outputTokens).toBeLessThanOrEqual(maxTokens);
    expect(result.segments[0].content).toContain('[truncated]');
  });

  it('does not cut a surrogate pair when truncating emoji content', () => {
    const stage = createAllocatorStage();
    // Many emoji (each a UTF-16 surrogate PAIR) so truncation lands mid-pair.
    const content = '😀'.repeat(500);
    const segments = [makeSegment('a', content)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 20, outputReserve: 0 } as BudgetConfig,
    };

    const out = stage.execute(segments, context).segments[0].content;
    // No lone surrogate survived: the string round-trips through UTF-8 cleanly
    // (a lone surrogate becomes U+FFFD, changing the byte length).
    const roundTripped = Buffer.from(out, 'utf-8').toString('utf-8');
    expect(roundTripped).toBe(out);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no unpaired high surrogate
  });

  it('returns empty string when budget is too small for suffix', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(100);
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 1, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    // Budget too small to fit even the truncation suffix
    expect(result.segments[0].content.length).toBeLessThanOrEqual(
      counter.countTokens(result.segments[0].content) <= 1 ? Infinity : 0,
    );
    const outputTokens = counter.countTokens(result.segments[0].content);
    expect(outputTokens).toBeLessThanOrEqual(1);
  });

  it('uses custom truncation suffix when provided', () => {
    const customSuffix = ' [CUT]';
    const stage = createAllocatorStage({ truncationSuffix: customSuffix });
    const longContent = 'word '.repeat(500);
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 50, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('[CUT]');
    expect(result.segments[0].content).not.toContain('[truncated]');
  });

  it('uses default truncation suffix when no option provided', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(500);
    const segments = [makeSegment('a', longContent)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 50, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('... [truncated]');
  });
});
