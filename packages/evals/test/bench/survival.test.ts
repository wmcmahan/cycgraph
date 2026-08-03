/**
 * Supporting-doc survival harness tests.
 *
 * Exercises the two pure exports (`selectTuningSlice`, `runSurvivalCell`)
 * over small in-memory MuSiQue fixtures — no download, no reader model.
 * The CLI `main()` is env/argv-driven and left uncovered by design.
 */

import { describe, it, expect } from 'vitest';
import { selectTuningSlice, runSurvivalCell, TUNING_SEED } from '../../src/bench/survival.js';
import type { RawMusiqueItem } from '../../src/bench/dataset/musique.js';

function makeRawItem(id: string, overrides?: Partial<RawMusiqueItem>): RawMusiqueItem {
  return {
    id,
    question: `Question for ${id}?`,
    answer: `answer-${id}`,
    answer_aliases: [],
    answerable: true,
    paragraphs: Array.from({ length: 6 }, (_, i) => ({
      idx: i,
      title: `${id}-title-${i}`,
      paragraph_text: `Paragraph ${i} body text for ${id} with enough words to tokenize.`,
      is_supporting: i < 2,
    })),
    ...overrides,
  };
}

describe('TUNING_SEED', () => {
  it('is distinct from any plausible reporting seed', () => {
    expect(TUNING_SEED).toBe(777003);
  });
});

describe('selectTuningSlice', () => {
  it('excludes every id in the reporting subset', () => {
    const raw = Array.from({ length: 20 }, (_, i) => makeRawItem(`2hop__${i}`));
    const reporting = new Set(['2hop__0', '2hop__1', '2hop__2']);

    const slice = selectTuningSlice(raw, 20, reporting);

    expect(slice.some(item => reporting.has(item.id))).toBe(false);
  });

  it('returns at most `size` items', () => {
    const raw = Array.from({ length: 20 }, (_, i) => makeRawItem(`2hop__${i}`));

    const slice = selectTuningSlice(raw, 5, new Set());

    expect(slice).toHaveLength(5);
  });

  it('is deterministic for a fixed seed and inputs', () => {
    const raw = Array.from({ length: 20 }, (_, i) => makeRawItem(`2hop__${i}`));

    const a = selectTuningSlice(raw, 8, new Set());
    const b = selectTuningSlice(raw, 8, new Set());

    expect(a.map(i => i.id)).toEqual(b.map(i => i.id));
  });

  it('is a seeded shuffle of the full set, not the first N', () => {
    const raw = Array.from({ length: 20 }, (_, i) => makeRawItem(`2hop__${i}`));

    const slice = selectTuningSlice(raw, 8, new Set());

    expect(slice.map(i => i.id)).not.toEqual(raw.slice(0, 8).map(i => i.id));
  });
});

describe('runSurvivalCell', () => {
  it('groups results by hop count parsed from the id', () => {
    const items = [
      makeRawItem('2hop__1_2'),
      makeRawItem('3hop__1_2_3'),
      makeRawItem('4hop1__1_2_3_4'),
    ];

    const cells = runSurvivalCell(items, 1.0, {}, 'default');

    expect(cells.map(c => c.hop)).toEqual(['2hop', '3hop', '4hop']);
  });

  it('reports full survival at a budget that fits the whole context', () => {
    const items = [makeRawItem('2hop__1_2'), makeRawItem('2hop__3_4')];

    const [cell] = runSurvivalCell(items, 1.0, {}, 'default');

    expect(cell.questions).toBe(2);
    expect(cell.fullChainSurvival).toBe(1);
    expect(cell.meanDocSurvival).toBe(1);
  });

  it('threads the config label onto every cell', () => {
    const items = [makeRawItem('2hop__1_2'), makeRawItem('3hop__1_2_3')];

    const cells = runSurvivalCell(items, 0.5, {}, 'prf3-t12-w07');

    expect(cells.every(c => c.config === 'prf3-t12-w07')).toBe(true);
  });

  it('drops supporting docs when the budget is far below the context size', () => {
    const items = [makeRawItem('2hop__1_2')];

    const [cell] = runSurvivalCell(items, 0.1, {}, 'tight');

    expect(cell.fullChainSurvival).toBeLessThan(1);
  });

  it('treats a question with no supporting paragraphs as fully survived', () => {
    const items = [
      makeRawItem('2hop__none', {
        paragraphs: Array.from({ length: 4 }, (_, i) => ({
          idx: i,
          title: `t-${i}`,
          paragraph_text: `body ${i}`,
          is_supporting: false,
        })),
      }),
    ];

    const [cell] = runSurvivalCell(items, 0.1, {}, 'no-support');

    expect(cell.meanDocSurvival).toBe(1);
    expect(cell.fullChainSurvival).toBe(1);
  });
});
