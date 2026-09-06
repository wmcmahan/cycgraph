/**
 * Tests for the feature-proposal shape (src/proposal.ts) — the
 * structural gate before a proposal can become a ticket.
 */

import { describe, it, expect } from 'vitest';
import { parseProposal, pathTokens, proposalKey } from '../src/proposal.js';

const WELL_FORMED = [
  'TITLE: Batch variant for the memory writer',
  'MOTIVATION:',
  'Writers loop one fact at a time today.',
  'DESIGN:',
  'Add writeMany to the MemoryWriter interface.',
  'EVIDENCE:',
  'packages/orchestrator/src/memory/memory-writer.ts shows the single-fact loop.',
  'ACCEPTANCE:',
  '- npm run test --workspace=packages/orchestrator passes with new writeMany tests',
  '- writeMany persists N facts in one call',
].join('\n');

describe('parseProposal', () => {
  it('parses a well-formed proposal with nothing missing', () => {
    const parsed = parseProposal(WELL_FORMED);

    expect(parsed.missing).toEqual([]);
    expect(parsed.title).toBe('Batch variant for the memory writer');
    expect(parsed.acceptance).toHaveLength(2);
    expect(parsed.motivation).toBe('Writers loop one fact at a time today.');
  });

  it('names every absent section', () => {
    const parsed = parseProposal('TITLE: something\nMOTIVATION:\nwhy\n');

    expect(parsed.missing).toEqual(['DESIGN', 'EVIDENCE', 'ACCEPTANCE']);
  });

  it('treats an acceptance section without bullets as missing', () => {
    const parsed = parseProposal(`${WELL_FORMED.split('ACCEPTANCE:')[0]}ACCEPTANCE:\nprose, not bullets\n`);

    expect(parsed.missing).toEqual(['ACCEPTANCE']);
  });

  it('reports a missing title', () => {
    const parsed = parseProposal(WELL_FORMED.replace('TITLE: Batch variant for the memory writer', ''));

    expect(parsed.missing).toContain('TITLE');
  });
});

describe('proposalKey', () => {
  it('normalizes the title into a stable ledger key', () => {
    expect(proposalKey('Batch variant, for the Memory Writer!')).toBe('feature:batch-variant-for-the-memory-writer');
  });
});

describe('pathTokens', () => {
  it('extracts path-shaped tokens and strips trailing punctuation', () => {
    const tokens = pathTokens('see packages/orchestrator/src/index.ts, and docs/guide.md.');

    expect(tokens).toEqual(['packages/orchestrator/src/index.ts', 'docs/guide.md']);
  });
});
