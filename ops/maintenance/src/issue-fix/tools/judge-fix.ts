/**
 * judge_fix — decide whether the finding was resolved without gaming.
 *
 * Re-scans the clone and applies the class-specific anti-gaming guard from
 * {@link ../judge.js}: an audit finding is judged on the tree changing
 * without introducing new findings, a mechanical finding on its key being
 * gone without its class being weakened (a TODO deleted, a test hollowed, a
 * warning silenced). The verdict feeds the gate; `attempts` bounds the
 * gate-retry loop.
 *
 * @module maintenance/issue-fix/tools/judge-fix
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { pendingDiff } from '@cycgraph/tools/git';
import { scanCore, type CoreFinding } from '../../code-scan/scan.js';
import { judgeAuditFix, judgeIssueFix, nextGateAttempt, type IssueFinding } from '../judge.js';
import type { IssueFixContext } from '../context.js';

/** Commit subject for a resolved mechanical finding, by its class. */
const MECHANICAL_SUBJECTS: Record<string, (file: string) => string> = {
  todo: (file) => `chore: complete the TODO in ${file}`,
  'skipped-test': (file) => `test: revive the skipped test in ${file}`,
  'lint-warning': (file) => `fix: clear the lint warning in ${file}`,
};

/** The re-scan-and-judge tool, bound to the clone. */
export function judgeFixTool(c: IssueFixContext) {
  const { workspaceAt, params: p } = c;
  return tool({
    name: 'judge_fix',
    description: 'Re-scan and decide whether the finding was resolved without gaming its class.',
    parameters: z.object({
      pick_result: z.unknown().optional(),
      baseline_result: z.unknown().optional(),
      judge_result: z.object({ attempts: z.number() }).partial().optional(),
      gate_verification_passed: z.boolean().optional(),
    }),
    timeoutMs: 300_000,
    execute: async ({ pick_result, baseline_result, judge_result, gate_verification_passed }) => {
      const pick = pick_result as { issue_number?: number; issue_title?: string } | undefined;
      const attempts = nextGateAttempt({
        previousAttempts: judge_result?.attempts ?? 0,
        gatePassed: gate_verification_passed,
      });
      const baseline = baseline_result as
        { keys?: string[]; target?: CoreFinding; text?: string; audit?: boolean } | undefined;
      const closesPrefix = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';

      // Audit finding: judged on the tree changing without introducing new
      // findings; the diff reviewer judges fidelity to the described fix.
      if (baseline?.audit === true) {
        const afterAudit = await scanCore(workspaceAt, { lint: p.lint });
        const verdict = judgeAuditFix({
          beforeKeys: baseline.keys ?? [],
          afterKeys: afterAudit.map((f) => f.key),
          diff: await pendingDiff(workspaceAt),
        });
        return {
          ...verdict,
          attempts,
          detail: `${closesPrefix}${verdict.detail}`,
          // The issue title names the finding, so the commit inherits it.
          ...(pick?.issue_title !== undefined && pick.issue_title !== ''
            ? { subject: `fix: ${pick.issue_title}` }
            : {}),
        };
      }

      // Mechanical finding: judged on its key being gone without its class
      // being weakened.
      const target = baseline?.target;
      if (target === undefined) return { resolved: false, weakened: false, attempts, detail: 'nothing was targeted' };

      const finding: IssueFinding = { key: target.key, kind: target.kind, file: target.file };
      const after = await scanCore(workspaceAt, { lint: p.lint });
      const afterText = await readFile(join(workspaceAt, target.file), 'utf8').catch(() => '');
      const verdict = judgeIssueFix({
        finding,
        beforeKeys: baseline?.keys ?? [],
        afterKeys: after.map((f) => f.key),
        text: { before: baseline?.text ?? '', after: afterText },
        diff: await pendingDiff(workspaceAt),
      });
      // "Closes #N" in the verdict detail reaches the PR body through the
      // delivery evidence, which is what closes the issue on merge.
      const closes = pick?.issue_number !== undefined ? `Closes #${pick.issue_number}. ` : '';
      const subject = MECHANICAL_SUBJECTS[target.kind]?.(target.file);
      return {
        ...verdict,
        attempts,
        detail: `${closes}${verdict.detail}`,
        ...(subject !== undefined ? { subject } : {}),
      };
    },
  });
}
