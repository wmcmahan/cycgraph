/**
 * bench_verdict — decide whether the improvement still holds.
 *
 * The ticket's diff was verified once; this re-measures the current tree.
 * A pass needs at least one benchmark still improved beyond noise, none
 * regressed or disappeared. The `detail` carries the `Closes #N` that
 * closes the ticket on merge.
 *
 * @module maintenance/optimization-apply/tools/verdict
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { compareBench, type BenchRow } from '../../tune/bench.js';
import type { OptApplyContext } from '../context.js';

/** The re-measurement verdict tool. */
export function verdictTool(c: OptApplyContext) {
  const { params: p } = c;
  return tool({
    name: 'bench_verdict',
    description: 'Decide whether the improvement still holds.',
    parameters: z.object({
      pick_result: z.unknown().optional(),
      bench_before_result: z.unknown().optional(),
      bench_after_result: z.unknown().optional(),
    }),
    execute: async ({ pick_result, bench_before_result, bench_after_result }) => {
      const before = (bench_before_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
      const after = (bench_after_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
      const comparison = compareBench(before, after, p.minImprovement);
      const pick = pick_result as { issue_number?: number; issue_title?: string } | undefined;
      const issue = pick?.issue_number;
      const closes = issue !== undefined ? `Closes #${issue}. ` : '';
      // The ticket title names the optimization; its `[optimization]`
      // marker gives way to the conventional prefix.
      const ticketTitle = (pick?.issue_title ?? '').replace(/^\[[^\]]*\]\s*/, '');
      return {
        ...(ticketTitle !== '' ? { subject: `perf: ${ticketTitle}` } : {}),
        improved_count: comparison.improved.length,
        regressed_count: comparison.regressed.length,
        disappeared_count: comparison.disappeared.length,
        detail: comparison.disappeared.length > 0
          ? `${closes}benchmarks disappeared after the edit (broken or deleted, not a pass): ${comparison.disappeared.join(', ')}`
          : comparison.improved.length === 0
          ? `${closes}the improvement no longer measures ≥${p.minImprovement}% beyond noise`
          : comparison.regressed.length > 0
            ? `${closes}improvement holds but ${comparison.regressed.map((r) => r.id).join(', ')} regressed`
            : `${closes}re-verified: ${comparison.improved.map((d) => `${d.id} +${d.pct.toFixed(1)}%`).join('; ')}`,
      };
    },
  });
}
