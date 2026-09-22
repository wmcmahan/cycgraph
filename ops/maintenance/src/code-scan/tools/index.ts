/**
 * The run's tool-node primitives (no agent — this workflow is mechanical).
 *
 * `clone` sets up the workspace, `scan` senses owed upkeep, and `triage`
 * dedupes and files it. Each is its own file; this barrel binds them all to
 * one {@link CodeScanContext}.
 *
 * @module maintenance/code-scan/tools
 */

import type { CodeScanContext } from '../context.js';
import { cloneTool } from './clone.js';
import { scanTool } from './scan.js';
import { triageTool } from './triage.js';

/** Build every tool the run needs, bound to the given context. */
export function codeScanTools(c: CodeScanContext) {
  return {
    clone: cloneTool(c),
    scan: scanTool(c),
    triage: triageTool(c),
  };
}

/** The run's tool-node primitives. */
export type CodeScanTools = ReturnType<typeof codeScanTools>;
