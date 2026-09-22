/**
 * bench_before / bench_after — measure the clone the same aliased way,
 * before and after the optimizer's edit.
 *
 * The baseline carries a readable table for the optimizer's context; the
 * after-run carries only the rows the verdict compares.
 *
 * @module maintenance/optimization-propose/tools/bench
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { runAliasedBench, type BenchRow } from '../../tune/bench.js';
import type { OptProposeContext } from '../context.js';

/** A readable ops/s table of the top `limit` rows, for the optimizer's context. */
function benchTable(rows: readonly BenchRow[], limit: number): string {
  return rows.slice(0, limit)
    .map((row) => `${row.id}: ${Math.round(row.hz).toLocaleString('en-US')} ops/s (±${row.rme.toFixed(2)}%)`)
    .join('\n');
}

/** The before/after benchmark tools, bound to the clone. */
export function benchTools(c: OptProposeContext) {
  const { workspaceAt, params: p } = c;

  const before = tool({
    name: 'bench_before',
    description: 'Measure the baseline against the clone\'s own source.',
    parameters: z.object({}),
    timeoutMs: 1_800_000,
    execute: async () => {
      const rows = await runAliasedBench(workspaceAt, { filter: p.target });
      return { rows, summary: benchTable(rows, 30) };
    },
  });

  const after = tool({
    name: 'bench_after',
    description: 'Re-measure after the edit, the same way.',
    parameters: z.object({}),
    timeoutMs: 1_800_000,
    execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
  });

  return { before, after };
}
