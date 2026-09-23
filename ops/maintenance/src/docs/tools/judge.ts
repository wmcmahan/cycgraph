/**
 * judge_fix — re-scan and decide whether the targeted finding is gone.
 *
 * Reads its own previous result to count attempts on a stuck finding and
 * abandon it instead of grinding the run's whole iteration cap against it.
 * The verdict guards against deletion: the claim must be corrected, nothing
 * new introduced.
 *
 * @module maintenance/docs/tools/judge
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { findingKey, judgeFix, type DocsFinding } from '../scan.js';
import { scopedScan } from '../scoped-scan.js';
import type { DocsContext } from '../context.js';

/** The re-scan-and-judge tool, bound to the run's context. */
export function judgeTool(c: DocsContext) {
  const { workspaceAt, params: p } = c;
  return tool({
    name: 'judge_fix',
    description: 'Re-scan and decide whether the targeted finding is gone.',
    parameters: z.object({
      scan_result: z.unknown().optional(),
      judge_result: z.unknown().optional(),
    }),
    execute: async ({ scan_result, judge_result }) => {
      const before = scan_result as
        { finding?: DocsFinding; findings?: DocsFinding[]; finding_keys?: string[]; text?: string } | undefined;
      const previous = judge_result as
        { key?: string; resolved?: boolean; attempts?: number; abandoned_keys?: string[] } | undefined;
      const targeted = before?.finding;
      if (!targeted) return { resolved: false, weakened: false, detail: 'nothing was targeted' };
      const after = await scopedScan(c);
      const afterText = await readFile(join(workspaceAt, targeted.file), 'utf8').catch(() => '');
      const verdict = judgeFix(targeted, before?.findings ?? [], after, {
        before: before?.text ?? '',
        after: afterText,
      }, before?.finding_keys);
      const key = findingKey(targeted);
      const attempts = (previous?.key === key && previous.resolved !== true ? previous.attempts ?? 0 : 0) + 1;
      const abandonedKeys = [...previous?.abandoned_keys ?? []];
      const abandon = !verdict.resolved || verdict.weakened;
      if (attempts >= p.attempts && abandon && !abandonedKeys.includes(key)) abandonedKeys.push(key);
      return {
        ...verdict,
        key,
        attempts,
        subject: `docs: correct a stale reference in ${targeted.file}`,
        gave_up: abandonedKeys.includes(key),
        abandoned_keys: abandonedKeys,
        ...(abandonedKeys.includes(key)
          ? { detail: `${verdict.detail} — abandoned after ${attempts} attempt(s); a human should look` }
          : {}),
      };
    },
  });
}
