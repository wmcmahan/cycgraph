/**
 * Tests for the audit finding shape (src/audit-findings.ts) — the
 * mechanical sift between raw auditor reports and filed tickets.
 */

import { describe, it, expect } from 'vitest';
import { auditKey, auditTitle, parseAuditFindings, renderAuditIssueBody, siftAuditFindings, type AuditFinding } from '../src/audit-findings.js';
import { charterOrder } from '../src/audit-workflow.js';

const WELL_FORMED = [
  'FINDING: Retriever drops fact ids',
  'SEVERITY: high',
  'EVIDENCE:',
  'packages/orchestrator/examples/context-and-memory/context-and-memory.ts maps facts without id.',
  'DETAIL:',
  'Lesson provenance records nothing, so eval-gating degrades to keep-everything.',
  'SUGGESTION:',
  'Map id: f.id through in the adapter.',
].join('\n');

const SECOND = [
  'FINDING: Supervisor prompt names unreadable keys',
  'SEVERITY: medium',
  'EVIDENCE:',
  'packages/orchestrator/examples/prompt-builder/prompt-builder.ts instructs reads the grant omits.',
  'DETAIL:',
  'The derived read set covers team outputs only, so the plan keys never reach the prompt.',
].join('\n');

const ALL_PATHS = () => true;

describe('parseAuditFindings', () => {
  it('parses a well-formed block with every section', () => {
    const { findings, malformed, clean } = parseAuditFindings(WELL_FORMED);

    expect(malformed).toBe(0);
    expect(clean).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      title: 'Retriever drops fact ids',
      severity: 'high',
      evidence: 'packages/orchestrator/examples/context-and-memory/context-and-memory.ts maps facts without id.',
      detail: 'Lesson provenance records nothing, so eval-gating degrades to keep-everything.',
      suggestion: 'Map id: f.id through in the adapter.',
    });
  });

  it('parses multiple blocks from one report', () => {
    const { findings } = parseAuditFindings(`${WELL_FORMED}\n${SECOND}`);

    expect(findings.map((f) => f.severity)).toEqual(['high', 'medium']);
  });

  it('counts a block with an invalid severity as malformed', () => {
    const { findings, malformed } = parseAuditFindings(WELL_FORMED.replace('high', 'catastrophic'));

    expect(findings).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it('counts a block with no detail as malformed', () => {
    const noDetail = ['FINDING: something', 'SEVERITY: low', 'EVIDENCE:', 'a/b.ts shows it.'].join('\n');

    const { findings, malformed } = parseAuditFindings(noDetail);

    expect(findings).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it('recognises a clean report', () => {
    const { findings, clean } = parseAuditFindings('CLEAN: checked every reducer against replay.');

    expect(clean).toBe(true);
    expect(findings).toHaveLength(0);
  });
});

describe('auditKey', () => {
  it('is stable under case and punctuation noise', () => {
    expect(auditKey('Retriever drops fact IDs!')).toBe(auditKey('retriever drops fact ids'));
  });

  it('is namespaced apart from feature keys', () => {
    expect(auditKey('anything')).toMatch(/^audit:/);
  });
});

describe('auditTitle', () => {
  it('takes the first H1 heading of the body', () => {
    const body = ['Preamble line.', '# Retriever drops fact ids', '## Problem'].join('\n');

    expect(auditTitle(body, 'audit:retriever-drops-fact-ids')).toBe('Retriever drops fact ids');
  });

  it('falls back to the key for a body with no heading', () => {
    const body = ['SEVERITY: high', 'EVIDENCE:', 'a/b.ts shows it.', 'DETAIL:', 'It drops ids.'].join('\n');

    expect(auditTitle(body, 'audit:retriever-drops-fact-ids')).toBe('audit:retriever-drops-fact-ids');
  });

  it('ignores section headings deeper than H1', () => {
    const body = ['## Problem', 'It drops ids.', '## Evidence', '- a/b.ts — shows it.'].join('\n');

    expect(auditTitle(body, 'audit:key')).toBe('audit:key');
  });

  it('does not take a heading with no text after it', () => {
    const body = ['#', 'SEVERITY: low'].join('\n');

    expect(auditTitle(body, 'audit:key')).toBe('audit:key');
  });
});

describe('renderAuditIssueBody', () => {
  const FINDING: AuditFinding = {
    title: 'Retriever drops fact ids',
    severity: 'high',
    evidence: 'a/b.ts maps facts without id.\nc/d.ts shows the ledger stays empty.',
    detail: 'Lesson provenance records nothing, so eval-gating degrades to keep-everything.',
    suggestion: 'Map id: f.id through in the adapter.',
  };
  const MARKER = '<!-- cycgraph:finding=audit:retriever-drops-fact-ids -->';

  it('orders problem, suggested fix, evidence, footer, marker', () => {
    const body = renderAuditIssueBody(FINDING, MARKER);

    expect(body).toBe([
      '## Problem',
      '',
      'Lesson provenance records nothing, so eval-gating degrades to keep-everything.',
      '',
      '## Suggested fix',
      '',
      'Map id: f.id through in the adapter.',
      '',
      '## Evidence',
      '',
      '- a/b.ts maps facts without id.',
      '- c/d.ts shows the ledger stays empty.',
      '',
      '_Found in automated audit sweep. Severity: high._',
      '',
      MARKER,
    ].join('\n'));
  });

  it('omits the suggested-fix section when the finding carries none', () => {
    const body = renderAuditIssueBody({ ...FINDING, suggestion: '' }, MARKER);

    expect(body).not.toContain('## Suggested fix');
    expect(body).toContain('## Problem');
    expect(body).toContain('## Evidence');
  });

  it('keeps evidence lines already written as bullets unchanged', () => {
    const body = renderAuditIssueBody({ ...FINDING, evidence: '- a/b.ts — shows it.' }, MARKER);

    expect(body).toContain('\n- a/b.ts — shows it.\n');
    expect(body).not.toContain('- - a/b.ts');
  });

  it('renders no title heading, so a filed body falls back to its key', () => {
    const body = renderAuditIssueBody(FINDING, MARKER);

    expect(auditTitle(body, 'audit:retriever-drops-fact-ids')).toBe('audit:retriever-drops-fact-ids');
  });
});

describe('siftAuditFindings', () => {
  it('keeps evidenced findings ranked worst-severity-first', () => {
    const { kept, drops } = siftAuditFindings([SECOND, WELL_FORMED], { pathExists: ALL_PATHS, cap: 5 });

    expect(kept.map((f) => f.severity)).toEqual(['high', 'medium']);
    expect(drops).toEqual({ malformed: 0, no_evidence: 0, duplicate: 0, already_filed: 0 });
  });

  it('drops a finding whose evidence names no real path', () => {
    const { kept, drops } = siftAuditFindings([WELL_FORMED], { pathExists: () => false, cap: 5 });

    expect(kept).toHaveLength(0);
    expect(drops.no_evidence).toBe(1);
  });

  it('dedupes within a run, keeping the worse severity', () => {
    const lowDuplicate = WELL_FORMED.replace('SEVERITY: high', 'SEVERITY: low');

    const { kept, drops } = siftAuditFindings([lowDuplicate, WELL_FORMED], { pathExists: ALL_PATHS, cap: 5 });

    expect(kept).toHaveLength(1);
    expect(kept[0]!.severity).toBe('high');
    expect(drops.duplicate).toBe(1);
  });

  it('drops a finding an open ticket already carries', () => {
    const openKeys = new Set([auditKey('Retriever drops fact ids')]);

    const { kept, drops } = siftAuditFindings([WELL_FORMED], { pathExists: ALL_PATHS, openKeys, cap: 5 });

    expect(kept).toHaveLength(0);
    expect(drops.already_filed).toBe(1);
  });

  it('caps the shortlist after ranking', () => {
    const { kept } = siftAuditFindings([SECOND, WELL_FORMED], { pathExists: ALL_PATHS, cap: 1 });

    expect(kept.map((f) => f.severity)).toEqual(['high']);
  });

  it('counts clean reports without inventing findings', () => {
    const { kept, clean_reports } = siftAuditFindings(['CLEAN: nothing provable.'], { pathExists: ALL_PATHS, cap: 5 });

    expect(kept).toHaveLength(0);
    expect(clean_reports).toBe(1);
  });
});

describe('charterOrder', () => {
  it('spreads a capped prefix across both lenses and scopes', () => {
    const ordered = charterOrder(['a', 'b'], ['x', 'y', 'z']);

    const prefix = ordered.slice(0, 3);
    expect(new Set(prefix.map((c) => c.lens)).size).toBe(2);
    expect(new Set(prefix.map((c) => c.scope)).size).toBeGreaterThan(1);
  });

  it('emits the full cross-product exactly once', () => {
    const ordered = charterOrder(['a', 'b'], ['x', 'y']);

    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map((c) => `${c.lens}:${c.scope}`)).size).toBe(4);
  });
});
