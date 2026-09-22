/**
 * bench_verdict — compare the runs and check the diff stayed in scope.
 *
 * A pass needs at least one benchmark improved beyond floor and noise, none
 * regressed or disappeared, and every changed file inside the allowed
 * scope. The `detail` reports the first failing condition, or the wins.
 *
 * @module maintenance/optimization-propose/tools/verdict
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { compareBench, type BenchRow } from '../../tune/bench.js';
import type { OptProposeContext } from '../context.js';

const exec = promisify(execFile);

/** The compare-and-scope-check tool, bound to the clone. */
export function verdictTool(c: OptProposeContext) {
  const { workspaceAt, params: p } = c;
  return tool({
    name: 'bench_verdict',
    description: 'Compare the runs and check the diff stayed in scope.',
    parameters: z.object({
      bench_before_result: z.unknown().optional(),
      bench_after_result: z.unknown().optional(),
    }),
    timeoutMs: 60_000,
    execute: async ({ bench_before_result, bench_after_result }) => {
      const before = (bench_before_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
      const after = (bench_after_result as { rows?: BenchRow[] } | undefined)?.rows ?? [];
      const comparison = compareBench(before, after, p.minImprovement);

      const { stdout } = await exec('git', ['diff', '--name-only'], { cwd: workspaceAt });
      const changed = stdout.split('\n').filter(Boolean);
      const outOfScope = changed.filter((file) => !file.startsWith(`${p.scope}/`) && file !== p.scope);

      const detail = changed.length === 0
        ? 'nothing was changed'
        : outOfScope.length > 0
          ? `changes left the allowed scope: ${outOfScope.join(', ')}`
          : comparison.disappeared.length > 0
            ? `benchmarks disappeared after the edit (broken or deleted, not a pass): ${comparison.disappeared.join(', ')}`
          : comparison.improved.length === 0
            ? `no benchmark improved by ≥${p.minImprovement}% beyond noise`
            : comparison.regressed.length > 0
              ? `improved ${comparison.improved.length} but regressed ${comparison.regressed.map((r) => r.id).join(', ')}`
              : `improved ${comparison.improved.map((d) => `${d.id} +${d.pct.toFixed(1)}%`).join('; ')}`;

      return {
        ...comparison,
        improved_count: comparison.improved.length,
        regressed_count: comparison.regressed.length,
        disappeared_count: comparison.disappeared.length,
        out_of_scope_count: outOfScope.length,
        changed_count: changed.length,
        changed_files: changed,
        detail,
      };
    },
  });
}
