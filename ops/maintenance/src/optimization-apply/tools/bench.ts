/**
 * bench_before / bench_after — measure the clone the same aliased way,
 * before and after re-applying the ticket's diff.
 *
 * @module maintenance/optimization-apply/tools/bench
 */

import { z } from 'zod';
import { tool } from '@cycgraph/orchestrator';
import { runAliasedBench } from '../../tune/bench.js';
import type { OptApplyContext } from '../context.js';

/** The before/after benchmark tools, bound to the clone. */
export function benchTools(c: OptApplyContext) {
  const { workspaceAt, params: p } = c;

  const before = tool({
    name: 'bench_before',
    description: 'Measure the baseline against the clone\'s own source.',
    parameters: z.object({}),
    timeoutMs: 1_800_000,
    execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
  });

  const after = tool({
    name: 'bench_after',
    description: 'Re-measure after the diff, the same way.',
    parameters: z.object({}),
    timeoutMs: 1_800_000,
    execute: async () => ({ rows: await runAliasedBench(workspaceAt, { filter: p.target }) }),
  });

  return { before, after };
}
