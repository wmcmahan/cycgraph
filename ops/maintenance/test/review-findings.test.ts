/**
 * Tests for the pr-review finding parser (src/review-findings.ts).
 */

import { describe, expect, it } from 'vitest';
import { inlineFindingMarker, parseAddressedFindings, parseFindingMarker, parseNumberedReplies, parseReviewFindings } from '../src/review-findings.js';

describe('parseReviewFindings', () => {
  it('lifts path and line from an anchored finding', () => {
    const review = [
      'VERDICT: REVISE',
      'One helper is duplicated.',
      '1. packages/tools/src/git/pr.ts:42 — duplicates ghEnv — reuse the existing helper',
    ].join('\n');

    expect(parseReviewFindings(review)).toEqual([
      { ordinal: 1, path: 'packages/tools/src/git/pr.ts', line: 42, text: 'duplicates ghEnv — reuse the existing helper' },
    ]);
  });

  it('strips backticks around an anchor', () => {
    const findings = parseReviewFindings('1. `src/a.ts:7` — off by one — use <=');

    expect(findings).toEqual([{ ordinal: 1, path: 'src/a.ts', line: 7, text: 'off by one — use <=' }]);
  });

  it('parses a path with no line as a file-only anchor', () => {
    const findings = parseReviewFindings('2. src/b.ts — the module is unused — delete it');

    expect(findings).toEqual([{ ordinal: 2, path: 'src/b.ts', text: 'the module is unused — delete it' }]);
  });

  it('keeps an unanchored finding with its full text', () => {
    const findings = parseReviewFindings('3. The PR description omits the migration step — document it');

    expect(findings).toEqual([{ ordinal: 3, text: 'The PR description omits the migration step — document it' }]);
  });

  it('ignores verdict, summary, and continuation lines', () => {
    const review = [
      'VERDICT: APPROVE',
      'Solid change overall.',
      '1. src/a.ts:3 — nit — rename',
      'this line continues nothing numbered',
    ].join('\n');

    expect(parseReviewFindings(review)).toHaveLength(1);
  });

  it('returns findings in order across multiple entries', () => {
    const review = [
      '1. src/a.ts:1 — first — fix',
      '2. src/b.ts:2 — second — fix',
    ].join('\n');

    expect(parseReviewFindings(review).map((f) => f.ordinal)).toEqual([1, 2]);
  });
});

describe('inlineFindingMarker', () => {
  it('round-trips through parseFindingMarker', () => {
    const body = `${inlineFindingMarker(3)} — off by one — use <=`;

    expect(parseFindingMarker(body)).toEqual({ ordinal: 3 });
  });
});

describe('parseFindingMarker', () => {
  it('returns undefined for a body without the marker', () => {
    expect(parseFindingMarker('just a human comment')).toBeUndefined();
  });

  it('returns undefined when the marker is not at the start', () => {
    expect(parseFindingMarker('re: **Finding 1**')).toBeUndefined();
  });
});

describe('parseAddressedFindings', () => {
  it('collects ordinals from ADDRESSED lines only', () => {
    const review = [
      'VERDICT: APPROVE',
      'FINDING 1: ADDRESSED — the helper is now reused',
      'FINDING 2: UNRESOLVED — the cast is still unchecked',
      'FINDING 3: ADDRESSED — the test asserts the real value',
    ].join('\n');

    expect(parseAddressedFindings(review)).toEqual([1, 3]);
  });

  it('ignores prose that mentions addressed without the line shape', () => {
    expect(parseAddressedFindings('Everything was addressed nicely.')).toEqual([]);
  });
});

describe('parseNumberedReplies', () => {
  it('maps reply lines to their feedback item numbers', () => {
    const report = [
      'Renamed the helper and tightened the type.',
      'REPLY 1: renamed resolveX to resolveTarget as requested',
      'REPLY 3: added the missing null check with a test',
    ].join('\n');

    const replies = parseNumberedReplies(report);

    expect(replies.get(1)).toBe('renamed resolveX to resolveTarget as requested');
    expect(replies.get(3)).toBe('added the missing null check with a test');
    expect(replies.has(2)).toBe(false);
  });

  it('returns an empty map for a report without reply lines', () => {
    expect(parseNumberedReplies('summary only').size).toBe(0);
  });
});
