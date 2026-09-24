/**
 * Tests for the pr-review and pr-revise text conventions (src/shared/review-findings.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  OVERALL_HEADING,
  RESOLVED_HEADING,
  composeReviewBody,
  inlineFindingBody,
  isFindingThread,
  markerKindOf,
  markerProvenance,
  parseOverallFindings,
  parsePriorVerdicts,
  parseReplies,
  parseReviewFindings,
  parseReviewVerdict,
  parseThreadVerdicts,
  reviewMarker,
  withoutMarkers,
  withoutReplies,
} from '../src/shared/review-findings.js';

describe('parseReviewFindings', () => {
  it('lifts path and line from an anchored finding', () => {
    const review = [
      'VERDICT: REVISE',
      'One helper is duplicated.',
      '1. packages/tools/src/git/pr.ts:42 — duplicates ghEnv — reuse the existing helper',
    ].join('\n');

    expect(parseReviewFindings(review)).toEqual([
      { ordinal: 1, path: 'packages/tools/src/git/pr.ts', line: 42, text: 'duplicates ghEnv — reuse the existing helper', evidence: [] },
    ]);
  });

  it('strips backticks around an anchor', () => {
    const findings = parseReviewFindings('1. `src/a.ts:7` — off by one — use <=');

    expect(findings).toEqual([{ ordinal: 1, path: 'src/a.ts', line: 7, text: 'off by one — use <=', evidence: [] }]);
  });

  it('parses a path with no line as a file-only anchor', () => {
    const findings = parseReviewFindings('2. src/b.ts — the module is unused — delete it');

    expect(findings).toEqual([{ ordinal: 2, path: 'src/b.ts', text: 'the module is unused — delete it', evidence: [] }]);
  });

  it('keeps an unanchored finding with its full text', () => {
    const findings = parseReviewFindings('3. The PR description omits the migration step — document it');

    expect(findings).toEqual([{ ordinal: 3, text: 'The PR description omits the migration step — document it', evidence: [] }]);
  });

  it('collects indented continuation lines as evidence, across blank lines', () => {
    const review = [
      '1. src/a.ts:3 — duplicates ghEnv — reuse it',
      '   ghEnv already lives at src/git/pr.ts:120',
      '',
      '   the copy differs only in its name',
      'Good: the tests assert real values.',
    ].join('\n');

    expect(parseReviewFindings(review)[0]!.evidence).toEqual([
      'ghEnv already lives at src/git/pr.ts:120',
      'the copy differs only in its name',
    ]);
  });

  it('ends a finding at the next numbered line', () => {
    const review = [
      '1. src/a.ts:1 — first — fix',
      '   first evidence',
      '2. src/b.ts:2 — second — fix',
    ].join('\n');

    expect(parseReviewFindings(review).map((f) => [f.ordinal, f.evidence])).toEqual([
      [1, ['first evidence']],
      [2, []],
    ]);
  });

  it('ignores verdict and summary lines', () => {
    const review = ['VERDICT: APPROVE', 'Solid change overall.', '1. src/a.ts:3 — nit — rename'].join('\n');

    expect(parseReviewFindings(review)).toHaveLength(1);
  });
});

describe('reviewMarker', () => {
  it('round-trips through markerKindOf', () => {
    expect(markerKindOf(`${reviewMarker('verify')}\nStill open: the cast remains`)).toBe('verify');
  });

  it('carries run, commit, and model provenance', () => {
    const marker = reviewMarker('finding', { run: '0f8e2c1a-4b7d-4e2a-9c3f-1d2e3f4a5b6c', commit: 'abc1234def', model: 'claude-opus-5-5' });

    expect(marker).toBe('<!-- cycgraph:pr-finding run=0f8e2c1a-4b7d-4e2a-9c3f-1d2e3f4a5b6c commit=abc1234def model=claude-opus-5-5 -->');
  });

  it('leaves out a provenance value that could break out of the comment', () => {
    expect(reviewMarker('reply', { model: 'evil --> <script>', commit: 'abc1234' })).toBe('<!-- cycgraph:pr-reply commit=abc1234 -->');
  });

  it('stays outside the issue pipeline marker namespace', () => {
    expect(reviewMarker('finding')).not.toContain('cycgraph:finding=');
  });
});

describe('markerKindOf', () => {
  it('returns undefined for a body without a marker', () => {
    expect(markerKindOf('just a human comment')).toBeUndefined();
  });

  it('finds a marker placed mid-body', () => {
    expect(markerKindOf('pr-review ran but failed <!-- cycgraph:pr-notice -->')).toBe('notice');
  });
});

describe('markerProvenance', () => {
  it('reads the provenance back from a marked body', () => {
    const body = `${reviewMarker('verify', { run: 'r-1', commit: 'abc1234', model: 'qwen2.5:7b' })}\nStill open: the cast remains`;

    expect(markerProvenance(body)).toEqual({ run: 'r-1', commit: 'abc1234', model: 'qwen2.5:7b' });
  });

  it('reads an empty provenance from a bare marker', () => {
    expect(markerProvenance(reviewMarker('notice'))).toEqual({});
  });

  it('returns undefined for an unmarked body', () => {
    expect(markerProvenance('a human comment')).toBeUndefined();
  });
});

describe('withoutMarkers', () => {
  it('removes every marker and the line break after it', () => {
    expect(withoutMarkers(`${reviewMarker('reply')}\nRenamed the helper.`)).toBe('Renamed the helper.');
  });

  it('removes a marker that carries provenance', () => {
    expect(withoutMarkers(`${reviewMarker('reply', { run: 'r-1', commit: 'abc1234' })}\nRenamed.`)).toBe('Renamed.');
  });
});

describe('isFindingThread', () => {
  it('recognizes the hidden finding marker', () => {
    expect(isFindingThread(`${reviewMarker('finding')}\noff by one`)).toBe(true);
  });

  it('recognizes a finding marker that carries provenance', () => {
    expect(isFindingThread(`${reviewMarker('finding', { run: 'r-1' })}\noff by one`)).toBe(true);
  });

  it('recognizes the legacy visible finding prefix', () => {
    expect(isFindingThread('**Finding 2** — off by one')).toBe(true);
  });

  it('rejects a human comment and a reviser reply', () => {
    expect(isFindingThread('please rename this')).toBe(false);
    expect(isFindingThread(`${reviewMarker('reply')}\nrenamed`)).toBe(false);
  });
});

describe('inlineFindingBody', () => {
  it('posts the finding text alone when it has no evidence', () => {
    const body = inlineFindingBody({ ordinal: 1, path: 'a.ts', line: 3, text: 'off by one — use <=', evidence: [] });

    expect(body).toBe(`${reviewMarker('finding')}\noff by one — use <=`);
  });

  it('names the line in the text of a comment on the whole file', () => {
    const body = inlineFindingBody({ ordinal: 1, path: 'a.ts', line: 90, text: 'dead branch — delete it', evidence: [] }, { onFile: true });

    expect(body).toBe(`${reviewMarker('finding')}\nLine 90: dead branch — delete it`);
  });

  it('folds evidence into a collapsed block', () => {
    const body = inlineFindingBody({ ordinal: 1, text: 'duplicates ghEnv — reuse it', evidence: ['see pr.ts:120'] });

    expect(body).toBe([
      reviewMarker('finding'),
      'duplicates ghEnv — reuse it',
      '',
      '<details><summary>Evidence</summary>',
      '',
      'see pr.ts:120',
      '',
      '</details>',
    ].join('\n'));
  });
});

describe('composeReviewBody', () => {
  const REVIEW = [
    'VERDICT: REVISE',
    'Two problems and one gap.',
    '1. src/a.ts:3 — off by one — use <=',
    '   the loop skips the last item',
    '2. The PR description omits the migration — document it',
    '   the schema changed in migration 0021',
    '3. src/gone.ts:9 — unchecked cast — narrow first',
  ].join('\n');

  it('keeps the prose and lists unplaced findings without numbers', () => {
    expect(composeReviewBody(REVIEW, new Set([1]))).toBe([
      'VERDICT: REVISE',
      'Two problems and one gap.',
      '',
      OVERALL_HEADING,
      '- The PR description omits the migration — document it',
      '  - the schema changed in migration 0021',
      '- `src/gone.ts:9` unchecked cast — narrow first',
    ].join('\n'));
  });

  it('leaves only the prose when every finding is placed', () => {
    expect(composeReviewBody(REVIEW, new Set([1, 2, 3]))).toBe('VERDICT: REVISE\nTwo problems and one gap.');
  });

  it('carries open earlier points forward and lists addressed ones as resolved', () => {
    const review = [
      'VERDICT: REVISE',
      'One earlier point remains.',
      'T1: ADDRESSED — the helper is reused',
      'P1: ADDRESSED — the description now documents the migration',
      'P2: UNRESOLVED — the changelog entry is still missing',
    ].join('\n');
    const prior = [
      { label: 'P1', text: 'The PR description omits the migration — document it' },
      { label: 'P2', text: 'The changelog is missing — add one' },
      { label: 'P3', text: 'The README example is stale — update it' },
    ];

    expect(composeReviewBody(review, new Set(), prior)).toBe([
      'VERDICT: REVISE',
      'One earlier point remains.',
      '',
      OVERALL_HEADING,
      '- Still open from the last review: The changelog is missing — add one',
      '  - the changelog entry is still missing',
      '- Still open from the last review: The README example is stale — update it',
      '',
      RESOLVED_HEADING,
      '- The PR description omits the migration — document it',
      '  - the description now documents the migration',
    ].join('\n'));
  });
});

describe('parseOverallFindings', () => {
  it('reads the overall section back in order with its evidence', () => {
    const body = composeReviewBody([
      'VERDICT: REVISE',
      'Summary.',
      '1. The description omits the migration — document it',
      '   the schema changed in migration 0021',
      '2. The changelog is missing — add one',
    ].join('\n'), new Set());

    expect(parseOverallFindings(`${body}\n\n1 finding is posted as a comment on the diff.`)).toEqual([
      { ordinal: 1, text: 'The description omits the migration — document it', evidence: ['the schema changed in migration 0021'] },
      { ordinal: 2, text: 'The changelog is missing — add one', evidence: [] },
    ]);
  });

  it('strips the still-open prefix so it does not stack across rounds', () => {
    const body = `${OVERALL_HEADING}\n- Still open from the last review: The changelog is missing — add one`;

    expect(parseOverallFindings(body).map((finding) => finding.text)).toEqual(['The changelog is missing — add one']);
  });

  it('stops at the resolved section', () => {
    const body = `${OVERALL_HEADING}\n- open point\n\n${RESOLVED_HEADING}\n- closed point`;

    expect(parseOverallFindings(body).map((finding) => finding.text)).toEqual(['open point']);
  });

  it('returns nothing for a body without the section', () => {
    expect(parseOverallFindings('VERDICT: APPROVE\nLooks good.')).toEqual([]);
  });
});

describe('parsePriorVerdicts', () => {
  it('reads earlier-point judgments and ignores thread lines', () => {
    const review = 'T1: ADDRESSED — reused\nP1: UNRESOLVED — still missing\n**P2: ADDRESSED** — documented';

    expect(parsePriorVerdicts(review)).toEqual([
      { label: 'P1', addressed: false, note: 'still missing' },
      { label: 'P2', addressed: true, note: 'documented' },
    ]);
  });
});

describe('parseThreadVerdicts', () => {
  it('reads addressed and unresolved thread lines with their notes', () => {
    const review = [
      'VERDICT: REVISE',
      'T1: ADDRESSED — the helper is now reused',
      'T2: UNRESOLVED — the cast is still unchecked',
      'P1: ADDRESSED — documented',
    ].join('\n');

    expect(parseThreadVerdicts(review)).toEqual([
      { label: 'T1', addressed: true, note: 'the helper is now reused' },
      { label: 'T2', addressed: false, note: 'the cast is still unchecked' },
    ]);
  });

  it('tolerates bold, a bullet, and a THREAD prefix', () => {
    expect(parseThreadVerdicts('- **T3: ADDRESSED** — fixed\nTHREAD T4: unresolved — not yet')).toEqual([
      { label: 'T3', addressed: true, note: 'fixed' },
      { label: 'T4', addressed: false, note: 'not yet' },
    ]);
  });

  it('ignores a blockquoted line from a quoted earlier review', () => {
    expect(parseThreadVerdicts('> T1: ADDRESSED — quoted')).toEqual([]);
  });
});

describe('parseReplies', () => {
  it('maps reply lines to thread and top-level labels', () => {
    const report = [
      'Renamed the helper and tightened the type.',
      'REPLY T1: renamed resolveX to resolveTarget',
      'REPLY c2: documented the migration in the description',
    ].join('\n');

    expect([...parseReplies(report)]).toEqual([
      ['T1', 'renamed resolveX to resolveTarget'],
      ['C2', 'documented the migration in the description'],
    ]);
  });

  it('ignores the bare numeric form', () => {
    expect(parseReplies('REPLY 1: done').size).toBe(0);
  });
});

describe('withoutReplies', () => {
  it('keeps the summary and drops every reply line', () => {
    expect(withoutReplies('Renamed the helper.\n\nREPLY T1: renamed\nREPLY C1: documented')).toBe('Renamed the helper.');
  });
});

describe('parseReviewVerdict', () => {
  it('reads the plain marker', () => {
    expect(parseReviewVerdict('VERDICT: REVISE\n1. a.ts:1 — x — y')).toBe('REVISE');
  });

  it('tolerates bold, heading, lowercase, and a dropped colon', () => {
    expect(parseReviewVerdict('**VERDICT: APPROVE**')).toBe('APPROVE');
    expect(parseReviewVerdict('## VERDICT: REVISE')).toBe('REVISE');
    expect(parseReviewVerdict('verdict: approve')).toBe('APPROVE');
    expect(parseReviewVerdict('VERDICT APPROVE')).toBe('APPROVE');
  });

  it('returns undefined when no marker line exists', () => {
    expect(parseReviewVerdict('The change looks fine to me.')).toBeUndefined();
  });

  it('ignores a blockquoted verdict from a quoted prior review', () => {
    const review = ['> VERDICT: REVISE', 'T1: ADDRESSED — fixed', 'VERDICT: APPROVE'].join('\n');

    expect(parseReviewVerdict(review)).toBe('APPROVE');
  });

  it('does not read a mid-sentence mention as a verdict', () => {
    expect(parseReviewVerdict('The previous verdict: approve was wrong.')).toBeUndefined();
  });
});
