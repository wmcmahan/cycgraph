/**
 * The run's tool-node primitives (no agent — this workflow is mechanical).
 *
 * `pick` lifts the approved ticket's diff, `benchBefore`/`benchAfter`
 * measure, `apply` re-applies the diff, `verdict` decides whether the win
 * holds, `checks` is the gate's run, and `giveUp` flags a dead end. Each is
 * its own file; this barrel binds them all to one {@link OptApplyContext}.
 *
 * @module maintenance/optimization-apply/tools
 */

import type { OptApplyContext } from '../context.js';
import { pickTool } from './pick.js';
import { benchTools } from './bench.js';
import { applyTool } from './apply.js';
import { verdictTool } from './verdict.js';
import { checksTool } from './checks.js';
import { giveUpTool } from './give-up.js';

/** Build every tool the run needs, bound to the given context. */
export function optApplyTools(c: OptApplyContext) {
  const bench = benchTools(c);
  return {
    pick: pickTool(c),
    benchBefore: bench.before,
    benchAfter: bench.after,
    apply: applyTool(c),
    verdict: verdictTool(c),
    checks: checksTool(c),
    giveUp: giveUpTool(c),
  };
}

/** The run's tool-node primitives. */
export type OptApplyTools = ReturnType<typeof optApplyTools>;
