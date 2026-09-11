/**
 * Audit finding shape: parsing, keying, and the sift that turns raw
 * auditor reports into a ranked, deduped, evidence-checked shortlist.
 *
 * Pure logic, no model and no filesystem: the workflow binds `pathExists`
 * to its jailed clone and hands in the open-issue marker set, so every
 * rule here is unit-testable.
 *
 * @module maintenance/audit-findings
 */

import { pathTokens } from './proposal.js';

/** Severity an auditor may assign, ordered worst-first for ranking. */
export const AUDIT_SEVERITIES = ['high', 'medium', 'low'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** One structured finding parsed from an auditor's report. */
export interface AuditFinding {
  title: string;
  severity: AuditSeverity;
  evidence: string;
  detail: string;
  suggestion: string;
}

/** Why a parsed block or report section was not kept. */
export interface AuditSiftDrops {
  malformed: number;
  no_evidence: number;
  duplicate: number;
  already_filed: number;
}

/** The sift's outcome: what survives, and an account of what did not. */
export interface AuditSiftResult {
  kept: AuditFinding[];
  drops: AuditSiftDrops;
  /** Reports that declared themselves clean (`CLEAN:` head). */
  clean_reports: number;
}

/** Dedupe key for a finding, stable under case and punctuation noise. */
export function auditKey(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `audit:${normalized}`;
}

/**
 * The title an audit issue body carries: its first markdown heading
 * (`#` through `######`, with text after it), falling back to the
 * finding key. Bodies filed by the audit workflow carry no heading, so
 * the fallback is the ordinary path for a real ticket.
 */
export function auditTitle(body: string, key: string): string {
  const heading = body.split('\n').find((line) => /^#{1,6}\s+\S/.test(line));
  return heading !== undefined ? heading.replace(/^#{1,6}\s+/, '').trim() : key;
}

const SECTION_HEADS = /^(SEVERITY|EVIDENCE|DETAIL|SUGGESTION):/;

/**
 * Parse one auditor report into findings.
 *
 * The contract the auditor is instructed to follow: zero or more blocks,
 * each opening `FINDING: <title>` followed by `SEVERITY:`, `EVIDENCE:`,
 * `DETAIL:`, and optionally `SUGGESTION:` sections; or a single line
 * opening `CLEAN:` when the charter turned up nothing. A block missing
 * its title, a valid severity, or a detail body is counted malformed
 * rather than guessed at.
 */
export function parseAuditFindings(text: string): { findings: AuditFinding[]; malformed: number; clean: boolean } {
  const clean = /^\s*CLEAN:/m.test(text);
  const blocks = text.split(/^FINDING:/m).slice(1);
  const findings: AuditFinding[] = [];
  let malformed = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    const title = (lines[0] ?? '').trim();

    const sections: Record<string, string[]> = {};
    let current: string | undefined;
    for (const line of lines.slice(1)) {
      const head = line.match(SECTION_HEADS);
      if (head) {
        current = head[1]!;
        sections[current] = [];
        const rest = line.slice(head[0].length).trim();
        if (rest) sections[current]!.push(rest);
        continue;
      }
      if (current) sections[current]!.push(line);
    }

    const severity = (sections['SEVERITY']?.join(' ').trim().toLowerCase() ?? '') as AuditSeverity;
    const detail = (sections['DETAIL'] ?? []).join('\n').trim();
    const evidence = (sections['EVIDENCE'] ?? []).join('\n').trim();
    const suggestion = (sections['SUGGESTION'] ?? []).join('\n').trim();

    if (title === '' || !AUDIT_SEVERITIES.includes(severity) || detail === '') {
      malformed += 1;
      continue;
    }
    findings.push({ title, severity, evidence, detail, suggestion });
  }

  return { findings, malformed, clean };
}

/** Options for {@link siftAuditFindings}. */
export interface AuditSiftOptions {
  /** Whether a repository-relative path exists in the audited clone. */
  pathExists: (path: string) => boolean;
  /** Marker keys already carried by open issues. */
  openKeys?: ReadonlySet<string>;
  /** Findings to keep after ranking. */
  cap: number;
}

/**
 * Sift raw auditor reports into the shortlist worth filing.
 *
 * Order of elimination, each drop accounted: malformed blocks, findings
 * whose evidence names no path the clone actually has, duplicates within
 * the run (first occurrence wins; a higher-severity duplicate replaces a
 * lower one), and findings an open ticket already carries. Survivors are
 * ranked worst-severity-first, stable within a severity, and capped.
 */
export function siftAuditFindings(reports: string[], options: AuditSiftOptions): AuditSiftResult {
  const drops: AuditSiftDrops = { malformed: 0, no_evidence: 0, duplicate: 0, already_filed: 0 };
  const byKey = new Map<string, AuditFinding>();
  let cleanReports = 0;

  for (const report of reports) {
    const { findings, malformed, clean } = parseAuditFindings(report);
    drops.malformed += malformed;
    if (clean && findings.length === 0) cleanReports += 1;

    for (const finding of findings) {
      const evidenced = pathTokens(finding.evidence).filter((token) => options.pathExists(token));
      if (evidenced.length === 0) {
        drops.no_evidence += 1;
        continue;
      }
      const key = auditKey(finding.title);
      if (options.openKeys?.has(key)) {
        drops.already_filed += 1;
        continue;
      }
      const existing = byKey.get(key);
      if (existing) {
        drops.duplicate += 1;
        if (AUDIT_SEVERITIES.indexOf(finding.severity) < AUDIT_SEVERITIES.indexOf(existing.severity)) {
          byKey.set(key, finding);
        }
        continue;
      }
      byKey.set(key, finding);
    }
  }

  const kept = [...byKey.values()]
    .sort((a, b) => AUDIT_SEVERITIES.indexOf(a.severity) - AUDIT_SEVERITIES.indexOf(b.severity))
    .slice(0, options.cap);

  return { kept, drops, clean_reports: cleanReports };
}
