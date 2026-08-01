/**
 * Tests for budget/allocator — token-budget distribution (allocateBudget)
 * and its enforcement stage (createAllocatorStage), including the BM25
 * relevance scorer that drives relevance-mode allocation.
 */

import { describe, it, expect } from 'vitest';
import { allocateBudget, createAllocatorStage } from '../src/budget/allocator.js';
import { scoreSegmentRelevance } from '../src/budget/relevance.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import type { BudgetConfig } from '../src/pipeline/types.js';
import { seg, makeContext } from './helpers.js';

const counter = new DefaultTokenCounter();

describe('scoreSegmentRelevance', () => {
  const segments = [
    seg('relevant', 'Northgate Holdings is headquartered in Denver and acquired Meridian Systems in 2019.'),
    seg('adjacent', 'Meridian Systems builds workflow orchestration software for regulated industries.'),
    seg('irrelevant', 'Batch schedulers queue jobs by priority and resource requirements across the cluster.'),
  ];

  it('ranks query-matching segments above non-matching ones', () => {
    const scores = scoreSegmentRelevance(segments, 'Where is Northgate Holdings headquartered?');

    expect(scores.get('relevant')!).toBeGreaterThan(scores.get('adjacent')!);
    expect(scores.get('adjacent')!).toBeGreaterThanOrEqual(0);
    expect(scores.get('irrelevant')).toBe(0);
  });

  it('returns all zeros for an empty query', () => {
    const scores = scoreSegmentRelevance(segments, '');
    expect([...scores.values()]).toEqual([0, 0, 0]);
  });

  it('returns all zeros for a stopword-only query', () => {
    const scores = scoreSegmentRelevance(segments, 'the of and');
    expect([...scores.values()]).toEqual([0, 0, 0]);
  });

  it('returns all zeros when no segment has scorable content', () => {
    const empty = [seg('a', 'the a of'), seg('b', 'and or but')];
    const scores = scoreSegmentRelevance(empty, 'kubernetes deployment');
    expect([...scores.values()]).toEqual([0, 0]);
  });

  it('is deterministic across identical calls', () => {
    const a = scoreSegmentRelevance(segments, 'Meridian Systems acquisition');
    const b = scoreSegmentRelevance(segments, 'Meridian Systems acquisition');
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('stems morphological variants so headquarters matches headquartered', () => {
    const scores = scoreSegmentRelevance(segments, 'headquarters location');
    expect(scores.get('relevant')!).toBeGreaterThan(0);
  });

  it('scores nothing extra when the top segment yields no expansion terms', () => {
    const scores = scoreSegmentRelevance([seg('only', 'kubernetes')], 'kubernetes');
    expect(scores.get('only')!).toBeGreaterThan(0);
  });

  it('bridges a two-hop question via pseudo-relevance feedback', () => {
    const hops = [
      seg('hop1', 'Meridian Systems is a software vendor. In 2019 it was acquired by Northgate Holdings.'),
      seg('hop2', 'Northgate Holdings is a private investment group based in Denver with a dozen portfolio vendors.'),
      seg('noise', 'Batch schedulers queue jobs by priority and resource requirements across the cluster.'),
    ];

    const scores = scoreSegmentRelevance(hops, 'In which city is the company that acquired Meridian Systems based?');

    expect(scores.get('hop1')!).toBeGreaterThan(0);
    expect(scores.get('hop2')!).toBeGreaterThan(scores.get('noise')!);
  });

  it('ranks expansion terms by term frequency with an alphabetical tiebreak', () => {
    const chain = [
      seg('hop1', 'Meridian Systems software software vendor acquired Northgate Holdings elephant giraffe.'),
      seg('hop2', 'Northgate Holdings investment group based in Denver.'),
      seg('noise', 'Batch schedulers queue jobs by priority and resource across the cluster.'),
    ];

    const scores = scoreSegmentRelevance(chain, 'the company that acquired Meridian Systems');

    expect(scores.get('hop1')!).toBeGreaterThan(0);
    expect(scores.get('hop2')!).toBeGreaterThan(scores.get('noise')!);
  });

  it('chains a third hop only with a second feedback round', () => {
    const chain = [
      seg('hop1', 'Meridian Systems is a software vendor. In 2019 it was acquired by Northgate Holdings.'),
      seg('hop2', 'Northgate Holdings is a subsidiary of Ashford Group, an investment conglomerate.'),
      seg('hop3', 'Ashford Group maintains corporate offices in Zurich near the lake.'),
      seg('noise', 'Batch schedulers queue jobs by priority and resource requirements across the cluster.'),
    ];
    const query = 'Where is the parent organization of the company that acquired Meridian Systems located?';

    const oneRound = scoreSegmentRelevance(chain, query, { prfRounds: 1, expansionTerms: 8, expansionWeight: 0.5 });
    const twoRounds = scoreSegmentRelevance(chain, query);

    expect(oneRound.get('hop3')).toBe(0);
    expect(twoRounds.get('hop3')!).toBeGreaterThan(twoRounds.get('noise')!);
  });
});

describe('allocateBudget', () => {
  it('distributes budget across equal-priority segments', () => {
    const segments = [seg('a', 'a'.repeat(400)), seg('b', 'b'.repeat(400))];

    const result = allocateBudget(segments, { maxTokens: 200, outputReserve: 0 }, counter);

    const a = result.allocations.get('a')!;
    const b = result.allocations.get('b')!;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a + b).toBeLessThanOrEqual(200);
  });

  it('gives a higher-priority segment a larger allocation when budget is scarce', () => {
    const segments = [seg('high', 'x'.repeat(2000), 'memory', { priority: 3 }), seg('low', 'y'.repeat(2000), 'memory', { priority: 1 })];

    const result = allocateBudget(segments, { maxTokens: 200, outputReserve: 0 }, counter);

    expect(result.allocations.get('high')!).toBeGreaterThan(result.allocations.get('low')!);
  });

  it('gives locked segments their exact token count', () => {
    const segments = [seg('locked', 'system prompt content', 'system', { locked: true }), seg('mutable', 'x'.repeat(400))];

    const result = allocateBudget(segments, { maxTokens: 500, outputReserve: 0 }, counter);

    expect(result.allocations.get('locked')).toBe(counter.countTokens('system prompt content'));
  });

  it('subtracts the output reserve from the available budget', () => {
    const segments = [seg('a', 'x'.repeat(2000))];

    const withReserve = allocateBudget(segments, { maxTokens: 500, outputReserve: 200 }, counter);
    const withoutReserve = allocateBudget(segments, { maxTokens: 500, outputReserve: 0 }, counter);

    expect(withReserve.allocations.get('a')!).toBeLessThan(withoutReserve.allocations.get('a')!);
  });

  it('reports an over-budget segment as overflow', () => {
    const result = allocateBudget([seg('a', 'x'.repeat(2000))], { maxTokens: 50, outputReserve: 0 }, counter);
    expect(result.overflow).toContain('a');
  });

  it('gives a small segment its exact count and the rest to a larger one', () => {
    const segments = [seg('small', 'hi', 'memory', { priority: 1 }), seg('big', 'x'.repeat(2000), 'memory', { priority: 1 })];

    const result = allocateBudget(segments, { maxTokens: 200, outputReserve: 0 }, counter);

    expect(result.allocations.get('small')).toBe(counter.countTokens('hi'));
    expect(result.allocations.get('big')!).toBeGreaterThan(result.allocations.get('small')!);
  });

  it('distributes fractional remainders without loss when no segment caps below its share', () => {
    const segments = [seg('a', 'x'.repeat(2000)), seg('b', 'x'.repeat(2000)), seg('c', 'x'.repeat(2000))];

    const result = allocateBudget(segments, { maxTokens: 100, outputReserve: 0 }, counter);

    const total = [...result.allocations.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(100);
  });

  it('redistributes budget freed by a capped small segment to the larger one', () => {
    const wordCounter = { countTokens: (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0) };
    const segments = [seg('small', 'one two', 'memory', { priority: 1 }), seg('big', 'w '.repeat(500).trim(), 'memory', { priority: 1 })];

    const result = allocateBudget(segments, { maxTokens: 200, outputReserve: 0 }, wordCounter);

    expect(result.allocations.get('small')).toBe(2);
    expect(result.allocations.get('big')).toBe(198);
  });

  it('splits freed budget across multiple needy segments proportionally to their need', () => {
    const wordCounter = { countTokens: (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0) };
    const segments = [
      seg('small', 'one two', 'memory', { priority: 1 }),
      seg('mid', 'w '.repeat(300).trim(), 'memory', { priority: 1 }),
      seg('large', 'w '.repeat(500).trim(), 'memory', { priority: 1 }),
    ];

    const result = allocateBudget(segments, { maxTokens: 300, outputReserve: 0 }, wordCounter);

    const total = [...result.allocations.values()].reduce((s, v) => s + v, 0);
    expect(result.allocations.get('small')).toBe(2);
    expect(result.allocations.get('mid')).toBe(133);
    expect(result.allocations.get('large')).toBe(165);
    expect(total).toBe(300);
  });

  it('grants every needy segment its full size when freed budget covers all needs', () => {
    const wordCounter = { countTokens: (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0) };
    const segments = [
      seg('needy', 'w '.repeat(100).trim(), 'memory', { priority: 1 }),
      seg('capped', 'w '.repeat(50).trim(), 'memory', { priority: 9 }),
    ];

    const result = allocateBudget(segments, { maxTokens: 200, outputReserve: 0 }, wordCounter);

    expect(result.allocations.get('needy')).toBe(100);
    expect(result.allocations.get('capped')).toBe(50);
    expect(result.overflow).toEqual([]);
  });

  it('defaults an omitted priority to 1', () => {
    const withoutPriority = [
      { id: 'a', content: 'x '.repeat(200), role: 'memory' as const },
      { id: 'b', content: 'y '.repeat(200), role: 'memory' as const },
    ];
    const withExplicitPriority = [seg('a', 'x '.repeat(200)), seg('b', 'y '.repeat(200))];

    const defaulted = allocateBudget(withoutPriority, { maxTokens: 100, outputReserve: 0 }, counter);
    const explicit = allocateBudget(withExplicitPriority, { maxTokens: 100, outputReserve: 0 }, counter);

    expect(defaulted.allocations).toEqual(explicit.allocations);
  });

  it('returns no allocations when every mutable segment has zero priority', () => {
    const segments = [seg('a', 'hello world', 'memory', { priority: 0 }), seg('b', 'foo bar', 'memory', { priority: 0 })];

    const result = allocateBudget(segments, { maxTokens: 100, outputReserve: 0 }, counter);

    expect(result.allocations.size).toBe(0);
    expect(result.overflow).toEqual([]);
  });

  it('reports overflow for over-budget locked segments even when no mutable segments exist', () => {
    const segments = [seg('sys', 'x'.repeat(2000), 'system', { locked: true })];

    const result = allocateBudget(segments, { maxTokens: 10, outputReserve: 0 }, counter);

    expect(result.allocations.get('sys')).toBe(counter.countTokens('x'.repeat(2000)));
    expect(result.overflow).toEqual(['sys']);
  });

  it('reports an over-budget locked segment as overflow when a mutable segment is also present', () => {
    const segments = [seg('sys', 'x'.repeat(2000), 'system', { locked: true }), seg('user', 'hello')];

    const result = allocateBudget(segments, { maxTokens: 10, outputReserve: 0 }, counter);

    expect(result.overflow).toContain('sys');
  });

  it('returns empty results for an empty segment list', () => {
    const result = allocateBudget([], { maxTokens: 100, outputReserve: 0 }, counter);
    expect(result.allocations.size).toBe(0);
    expect(result.overflow).toHaveLength(0);
  });
});

describe('allocateBudget relevance mode', () => {
  const docs = [
    seg('doc-irrelevant', 'Batch schedulers queue jobs by priority and resource requirements. Preemption balances throughput against latency. '.repeat(3)),
    seg('doc-relevant', 'Northgate Holdings is headquartered in Denver. The investment group acquired Meridian Systems in 2019. '.repeat(3)),
    seg('doc-adjacent', 'Meridian Systems builds workflow orchestration software for regulated industries and banks. '.repeat(3)),
  ];
  const query = 'Where is the company that acquired Meridian Systems headquartered?';

  it('grants the full budget to the relevant segment and zero to the irrelevant one', () => {
    const total = docs.reduce((sum, d) => sum + counter.countTokens(d.content), 0);
    const budget: BudgetConfig = { maxTokens: Math.ceil(total * 0.4), outputReserve: 0 };

    const result = allocateBudget(docs, budget, counter, undefined, { query, allocation: 'relevance' });

    expect(result.allocations.get('doc-relevant')).toBe(counter.countTokens(docs[1].content));
    expect(result.allocations.get('doc-irrelevant')).toBe(0);
  });

  it('reports partially and fully starved segments as overflow', () => {
    const total = docs.reduce((sum, d) => sum + counter.countTokens(d.content), 0);
    const budget: BudgetConfig = { maxTokens: Math.ceil(total * 0.3), outputReserve: 0 };

    const result = allocateBudget(docs, budget, counter, undefined, { query, allocation: 'relevance' });

    expect(result.overflow).toContain('doc-irrelevant');
  });

  it('breaks ties between equally relevant segments by original order', () => {
    const twins = [
      seg('first', 'Denver headquarters figures '.repeat(20)),
      seg('second', 'Denver headquarters figures '.repeat(20)),
      seg('noise', 'unrelated cluster scheduling content '.repeat(20)),
    ];
    const total = twins.reduce((sum, d) => sum + counter.countTokens(d.content), 0);
    const budget: BudgetConfig = { maxTokens: Math.ceil(total * 0.4), outputReserve: 0 };

    const result = allocateBudget(twins, budget, counter, undefined, {
      query: 'Where is the Denver headquarters?',
      allocation: 'relevance',
    });

    expect(result.allocations.get('first')).toBe(counter.countTokens(twins[0].content));
    expect(result.allocations.get('noise')).toBe(0);
  });

  it('falls back to proportional allocation when nothing matches the query', () => {
    const budget: BudgetConfig = { maxTokens: 60, outputReserve: 0 };

    const result = allocateBudget(docs, budget, counter, undefined, {
      query: 'zebra xylophone quantum',
      allocation: 'relevance',
    });

    for (const doc of docs) {
      expect(result.allocations.get(doc.id)!).toBeGreaterThan(0);
    }
  });

  it('falls back to proportional allocation when no query is given', () => {
    const budget: BudgetConfig = { maxTokens: 60, outputReserve: 0 };

    const withMode = allocateBudget(docs, budget, counter, undefined, { allocation: 'relevance' });
    const plain = allocateBudget(docs, budget, counter);

    expect([...withMode.allocations.entries()]).toEqual([...plain.allocations.entries()]);
  });
});

describe('createAllocatorStage', () => {
  it('declares cross-segment scope', () => {
    expect(createAllocatorStage().scope).toBe('cross-segment');
  });

  it('truncates a segment that exceeds its allocation', () => {
    const stage = createAllocatorStage();
    const longContent = 'word '.repeat(500);

    const result = stage.execute([seg('a', longContent)], makeContext({ tokenCounter: counter, maxTokens: 50 }));

    expect(counter.countTokens(result.segments[0].content)).toBeLessThan(counter.countTokens(longContent));
  });

  it('leaves a segment within budget unchanged', () => {
    const stage = createAllocatorStage();

    const result = stage.execute([seg('a', 'short content')], makeContext({ tokenCounter: counter, maxTokens: 1000 }));

    expect(result.segments[0].content).toBe('short content');
  });

  it('keeps truncated output within the token budget', () => {
    const stage = createAllocatorStage();
    const maxTokens = 30;

    const result = stage.execute([seg('a', 'word '.repeat(500))], makeContext({ tokenCounter: counter, maxTokens }));

    expect(counter.countTokens(result.segments[0].content)).toBeLessThanOrEqual(maxTokens);
    expect(result.segments[0].content).toContain('[truncated]');
  });

  it('appends the default truncation marker when content is cut', () => {
    const stage = createAllocatorStage();

    const result = stage.execute([seg('a', 'word '.repeat(500))], makeContext({ tokenCounter: counter, maxTokens: 50 }));

    expect(result.segments[0].content).toContain('... [truncated]');
  });

  it('appends a custom truncation suffix when provided', () => {
    const stage = createAllocatorStage({ truncationSuffix: ' [CUT]' });

    const result = stage.execute([seg('a', 'word '.repeat(500))], makeContext({ tokenCounter: counter, maxTokens: 50 }));

    expect(result.segments[0].content).toContain('[CUT]');
    expect(result.segments[0].content).not.toContain('[truncated]');
  });

  it('returns an empty string when the budget is too small for the suffix', () => {
    const stage = createAllocatorStage();

    const result = stage.execute([seg('a', 'word '.repeat(100))], makeContext({ tokenCounter: counter, maxTokens: 1 }));

    expect(counter.countTokens(result.segments[0].content)).toBeLessThanOrEqual(1);
  });

  it('does not split a surrogate pair when truncating emoji content', () => {
    const stage = createAllocatorStage();

    const out = stage.execute([seg('a', '😀'.repeat(500))], makeContext({ tokenCounter: counter, maxTokens: 20 })).segments[0].content;

    expect(Buffer.from(out, 'utf-8').toString('utf-8')).toBe(out);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('drops a trailing high surrogate when the tail cut lands inside a pair', () => {
    const charCounter = { countTokens: (t: string) => Math.ceil(t.length / 4) };
    const stage = createAllocatorStage({ truncation: 'tail' });
    const content = 'a' + '😀'.repeat(100);

    const out = stage.execute([seg('a', content)], makeContext({ tokenCounter: charCounter, maxTokens: 20 })).segments[0].content;

    expect(out).toBe('a' + '😀'.repeat(31) + '\n... [truncated]');
  });

  it('passes a segment through untouched when it received no allocation', () => {
    const stage = createAllocatorStage();
    const zeroPriority = seg('a', 'word '.repeat(500), 'memory', { priority: 0 });

    const result = stage.execute([zeroPriority], makeContext({ tokenCounter: counter, maxTokens: 50 }));

    expect(result.segments[0]).toBe(zeroPriority);
  });

  it('empties a segment granted zero tokens in relevance mode', () => {
    const stage = createAllocatorStage({ allocation: 'relevance', truncation: 'tail' });
    const relevant = seg('rel', 'Northgate Holdings acquired Meridian Systems in Denver. '.repeat(5), 'history');
    const irrelevant = seg('irr', 'Batch schedulers queue jobs by resource requirements. '.repeat(5), 'history');
    const winnerTokens = counter.countTokens(relevant.content);

    const result = stage.execute(
      [relevant, irrelevant],
      makeContext({ tokenCounter: counter, maxTokens: winnerTokens, query: 'Where is Northgate Holdings headquartered?' }),
    );

    const byId = new Map(result.segments.map(s => [s.id, s.content]));
    expect(byId.get('rel')).toBe(relevant.content);
    expect(byId.get('irr')).toBe('');
  });

  describe('importance-aware truncation', () => {
    const proseWithTrailingFacts = [
      'It should be noted that in order to reach any kind of decision here, the team essentially had to basically review the entire landscape of options in terms of the overall strategy and methodology and approach.',
      'Additionally it is worth mentioning that at the end of the day the process was quite thorough and generally very comprehensive in most respects overall.',
      'The approved vendor is MERIDIAN-7 with a contract value of $1,284,500.',
      'Deployment must never bypass the compliance sandbox.',
    ].join(' ');

    function compressProse(options?: Parameters<typeof createAllocatorStage>[0]) {
      const stage = createAllocatorStage(options);
      return stage.execute([seg('a', proseWithTrailingFacts, 'history')], makeContext({ tokenCounter: counter, maxTokens: 40 })).segments[0].content;
    }

    it('keeps trailing entities, amounts, and negations over leading filler', () => {
      const output = compressProse();

      expect(output).toContain('MERIDIAN-7');
      expect(output).toContain('$1,284,500');
      expect(output).toContain('never');
      expect(counter.countTokens(output)).toBeLessThan(counter.countTokens(proseWithTrailingFacts) / 2);
    });

    it('appends the truncation marker in importance mode', () => {
      expect(compressProse()).toContain('[truncated]');
    });

    it('keeps the leading prefix and drops trailing facts in tail mode', () => {
      const output = compressProse({ truncation: 'tail' });

      expect(output).toContain('It should be noted');
      expect(output).not.toContain('MERIDIAN-7');
    });

    it('tail-truncates structured memory-role segments even in importance mode', () => {
      const stage = createAllocatorStage();
      const structured = 'row1,value1\nrow2,value2\n' + 'rowN,valueN\n'.repeat(50);

      const output = stage.execute([seg('m', structured, 'memory')], makeContext({ tokenCounter: counter, maxTokens: 20 })).segments[0].content;

      expect(output.startsWith('row1,value1')).toBe(true);
      expect(output).toContain('[truncated]');
    });

    it('keeps query-relevant content preferentially when a query is present', () => {
      const content = [
        'It should be noted that the team essentially reviewed the entire landscape of options in considerable depth.',
        'Budget approved by MERIDIAN-7 for $50,000 on 2026-03-14.',
        'the launch window opens after the spring thaw in the northern region.',
      ].join(' ');

      const run = (query?: string) =>
        createAllocatorStage()
          .execute([seg('a', content, 'history')], makeContext({ tokenCounter: counter, maxTokens: 18, query }))
          .segments[0].content;

      const withQuery = run('When does the launch window open?');
      const withoutQuery = run();

      expect(withQuery).toContain('launch');
      expect(withQuery).not.toBe(withoutQuery);
    });
  });

  describe('relevance mode', () => {
    const docs = [
      seg('doc-irrelevant', 'Batch schedulers queue jobs by priority and resource requirements. Preemption balances throughput against latency. '.repeat(3), 'history'),
      seg('doc-relevant', 'Northgate Holdings is headquartered in Denver. The investment group acquired Meridian Systems in 2019. '.repeat(3), 'history'),
      seg('doc-adjacent', 'Meridian Systems builds workflow orchestration software for regulated industries and banks. '.repeat(3), 'history'),
    ];
    const query = 'Where is the company that acquired Meridian Systems headquartered?';

    it('keeps the relevant doc whole and empties the irrelevant one', () => {
      const stage = createAllocatorStage({ allocation: 'relevance' });
      const total = docs.reduce((sum, d) => sum + counter.countTokens(d.content), 0);

      const result = stage.execute(docs, makeContext({ tokenCounter: counter, maxTokens: Math.ceil(total * 0.4), query }));

      const byId = new Map(result.segments.map(s => [s.id, s.content]));
      expect(byId.get('doc-relevant')).toContain('Denver');
      expect(byId.get('doc-irrelevant')!.length).toBeLessThan(30);
    });

    it('defaults an omitted priority to 1 in relevance ranking', () => {
      const withoutPriority = [
        { id: 'rel', content: 'Northgate Holdings is headquartered in Denver. '.repeat(3), role: 'history' as const },
        { id: 'irr', content: 'Batch schedulers queue jobs by resource requirements. '.repeat(3), role: 'history' as const },
      ];

      const result = allocateBudget(
        withoutPriority,
        { maxTokens: counter.countTokens(withoutPriority[0].content), outputReserve: 0 },
        counter,
        undefined,
        { allocation: 'relevance', query: 'Where is Northgate Holdings headquartered?' },
      );

      expect(result.allocations.get('rel')).toBe(counter.countTokens(withoutPriority[0].content));
      expect(result.allocations.get('irr')).toBe(0);
    });
  });
});
