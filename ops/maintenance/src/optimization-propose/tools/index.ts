/**
 * The optimizer's hands and the run's tool-node primitives.
 *
 * `hands` are the editing surface the optimizer drives directly; the tool
 * nodes bracket it — `clone` sets up the workspace, `benchBefore`/`benchAfter`
 * measure, `verdict` compares and scope-checks, `checks` is the gate's run,
 * and `ticket` files the verified proposal. Each is its own file; this
 * barrel binds them all to one {@link OptProposeContext}.
 *
 * @module maintenance/optimization-propose/tools
 */

import type { OptProposeContext } from '../context.js';
import { optProposeHands } from './hands.js';
import { cloneTool } from './clone.js';
import { benchTools } from './bench.js';
import { verdictTool } from './verdict.js';
import { checksTool } from './checks.js';
import { ticketTool } from './ticket.js';

/** Build every tool the run needs, bound to the given context. */
export function optProposeTools(c: OptProposeContext) {
  const bench = benchTools(c);
  return {
    hands: optProposeHands(c),
    clone: cloneTool(c),
    benchBefore: bench.before,
    benchAfter: bench.after,
    verdict: verdictTool(c),
    checks: checksTool(c),
    ticket: ticketTool(c),
  };
}

/** The optimizer's hands and the run's tool-node primitives. */
export type OptProposeTools = ReturnType<typeof optProposeTools>;
