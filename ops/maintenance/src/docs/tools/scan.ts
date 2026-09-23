/**
 * scan_docs — find what the documentation claims that the repo contradicts.
 *
 * Fetches the open-PR claim set and (in diff mode) the changed paths once,
 * then reports the first eligible finding to fix. A finding with no
 * candidates has no legitimate agent move — correction is impossible and
 * removal is what the judge refuses — so those are reported for a human
 * rather than burned against.
 *
 * @module maintenance/docs/tools/scan
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { openPrFiles } from '@cycgraph/tools/git';
import { findingKey } from '../scan.js';
import { scopedScan } from '../scoped-scan.js';
import type { DocsContext } from '../context.js';

const exec = promisify(execFile);

/** The scan tool, bound to the run's context. */
export function scanTool(c: DocsContext) {
  const { repoRoot, workspaceAt, params: p } = c;
  return tool({
    name: 'scan_docs',
    description: 'Find what the documentation claims that the repository contradicts.',
    parameters: z.object({
      commit_result: z.unknown().optional(),
      judge_result: z.unknown().optional(),
    }),
    execute: async ({ commit_result, judge_result }) => {
      if (!c.scan.deferredFetched) {
        c.scan.deferredFetched = true;
        c.scan.deferred = await openPrFiles(repoRoot, 'docs/');
      }
      if (p.since !== '' && c.scan.changed === undefined) {
        const { stdout } = await exec('git', ['diff', '--name-only', `${p.since}..HEAD`], { cwd: workspaceAt });
        c.scan.changed = stdout.split('\n').filter(Boolean);
      }
      const findings = await scopedScan(c);
      // A finding with no candidates has no legitimate agent move: the
      // referenced thing exists nowhere in the clone, correction is
      // impossible and removal is what the judge refuses. Whether the
      // reference or the absence is the mistake is a human question, so
      // those findings are reported rather than burned against.
      const abandoned = new Set(((judge_result as { abandoned_keys?: string[] } | undefined)?.abandoned_keys) ?? []);
      const fixable = findings.filter((entry) => entry.candidates.length > 0 && !abandoned.has(findingKey(entry)));
      const needsHuman = findings.filter((entry) => entry.candidates.length === 0);
      const finding = fixable[p.skip];
      const fixedSoFar = (commit_result as { count?: number } | undefined)?.count ?? 0;
      const text = finding
        ? await readFile(join(workspaceAt, finding.file), 'utf8').catch(() => '')
        : '';
      return {
        total: findings.length,
        has_finding: finding !== undefined,
        any_fixed: fixedSoFar > 0,
        needs_human: needsHuman.map((entry) => `${entry.file}: ${entry.detail.slice(0, 120)}`),
        ...(abandoned.size > 0 ? { abandoned: [...abandoned] } : {}),
        findings: findings.slice(0, 20),
        // Complete, uncapped: the judge needs every before-key or findings
        // past the display cap read as introduced.
        finding_keys: findings.map(findingKey),
        ...(finding ? { finding, text } : {}),
        instruction: finding
          ? [
            `In ${finding.file}, line ${finding.line}: ${finding.detail}`,
            `The document says '${finding.target}'.`,
            finding.candidates.length > 0
              ? `The repository actually has: ${finding.candidates.join(' | ')}. Pick whichever the sentence means and edit the document to say that.`
              : 'Search the repository for where that thing lives now, and edit the document to match.',
            'Replace the wrong reference with the right one. Do not delete the sentence, and do not replace an instruction with a comment.',
            'Change nothing else.',
          ].join('\n')
          : 'Nothing to fix: the documentation matches the repository.',
      };
    },
  });
}
