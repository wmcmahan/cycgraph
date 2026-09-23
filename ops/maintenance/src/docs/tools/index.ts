/**
 * The fixer's hands and the run's tool-node primitives.
 *
 * `hands` are the editing surface the fixer drives; the tool nodes are
 * `scan` (find the next stale claim), `judge` (prove the fix), and `checks`
 * (the gate's run). Each is its own file; this barrel binds them all to one
 * {@link DocsContext}.
 *
 * @module maintenance/docs/tools
 */

import type { DocsContext } from '../context.js';
import { docsHands } from './hands.js';
import { scanTool } from './scan.js';
import { judgeTool } from './judge.js';
import { checksTool } from './checks.js';

/** Build every tool the run needs, bound to the given context. */
export function docsTools(c: DocsContext) {
  return {
    hands: docsHands(c),
    scan: scanTool(c),
    judge: judgeTool(c),
    checks: checksTool(c),
  };
}

/** The fixer's hands and the run's tool-node primitives. */
export type DocsTools = ReturnType<typeof docsTools>;
