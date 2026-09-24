/**
 * Tests for the review workflows' run links and provenance footer (src/shared/provenance.ts).
 */

import { describe, expect, it } from 'vitest';
import { actionsRunUrl, dryRunPreview, provenanceFooter } from '../src/shared/provenance.js';

const ACTIONS = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
};

describe('actionsRunUrl', () => {
  it('links the run page on a first attempt', () => {
    expect(actionsRunUrl(ACTIONS)).toBe('https://github.com/acme/widgets/actions/runs/123456');
  });

  it('links the specific attempt on a re-run', () => {
    expect(actionsRunUrl({ ...ACTIONS, GITHUB_RUN_ATTEMPT: '2' })).toBe('https://github.com/acme/widgets/actions/runs/123456/attempts/2');
  });

  it('returns undefined outside Actions', () => {
    expect(actionsRunUrl({})).toBeUndefined();
  });
});

describe('provenanceFooter', () => {
  it('names the short commit, the model, and the run link', () => {
    const footer = provenanceFooter('Reviewed at', {
      commit: 'abc1234def5678',
      model: 'claude-opus-5-5',
      runUrl: 'https://github.com/acme/widgets/actions/runs/123456',
    });

    expect(footer).toBe('<sub>Reviewed at `abc1234` · with claude-opus-5-5 · [workflow run](https://github.com/acme/widgets/actions/runs/123456)</sub>');
  });

  it('leaves out the link for a run outside Actions', () => {
    expect(provenanceFooter('Revised in', { commit: 'abc1234def', model: 'qwen2.5:7b' })).toBe('<sub>Revised in `abc1234` · with qwen2.5:7b</sub>');
  });

  it('is empty when there is nothing to say', () => {
    expect(provenanceFooter('Reviewed at', {})).toBe('');
  });
});

describe('dryRunPreview', () => {
  it('shows each section under a rule naming where it would go', () => {
    const preview = dryRunPreview([
      { title: 'line comment · src/a.ts:3', body: 'off by one' },
      { title: 'review (COMMENT)', body: 'VERDICT: REVISE' },
    ]);

    expect(preview).toBe('── line comment · src/a.ts:3\noff by one\n\n── review (COMMENT)\nVERDICT: REVISE');
  });

  it('says so when nothing would be posted', () => {
    expect(dryRunPreview([])).toBe('nothing would be posted');
  });
});
